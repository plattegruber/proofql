/**
 * Rate limiting without a database: the window math of the in-memory
 * limiter, the per-plan configs read from PLANS, the wrangler.jsonc mirror,
 * binding selection by plan, and the middleware's 429 contract. Auth is
 * stood in for by a middleware that sets `auth` directly, so these tests
 * drive `rateLimit` exactly as `requireApiKey` drives `enforceRateLimit`.
 */

import { readFileSync } from "node:fs";
import { type ApiKeyKind, PLANS, type Plan } from "@proofql/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  AUTH_FAIL_BINDING,
  AUTH_FAIL_CONFIG,
  AUTH_FAIL_NAMESPACE_ID,
} from "./auth-throttle.js";
import type { ApiBindings, AppEnv, AuthContext } from "./bindings.js";
import { onError } from "./errors.js";
import {
  bindingProvider,
  injectedProvider,
  MemoryRateLimiter,
  RATE_LIMIT_BINDINGS,
  type RateLimiter,
  rateLimit,
  rateLimitConfig,
  rateLimitConfigs,
  rateLimitMiddleware,
  secondsToNextPeriod,
} from "./rate-limit.js";
import { requestId } from "./request-id.js";

/** A limiter that records its keys and answers from a script. */
function recordingLimiter(outcomes: boolean[] = []): RateLimiter & {
  keys: string[];
} {
  const keys: string[] = [];
  return {
    keys,
    limit: async (key) => {
      keys.push(key);
      return { success: outcomes.shift() ?? true };
    },
  };
}

function authFor(kind: ApiKeyKind, plan: Plan = "free"): AuthContext {
  return {
    apiKeyId: `key-${kind}`,
    projectId: "project-1",
    environment: "live",
    kind,
    plan,
    project: {
      allowedOrigins: [],
      minRating: 4,
      similarityFloor: 0.55,
    },
  };
}

/** Request id → fake auth (`?kind=`, `?plan=`) → rate limit → handler. */
function appWith(
  limiters: RateLimiter | { secret?: RateLimiter; publishable?: RateLimiter },
) {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use(requestId);
  app.use(rateLimitMiddleware(injectedProvider(limiters)));
  app.use(async (c, next) => {
    const kind =
      c.req.query("kind") === "publishable" ? "publishable" : "secret";
    const plan = c.req.query("plan") === "paid" ? "paid" : "free";
    c.set("auth", authFor(kind, plan));
    await next();
  });
  app.get("/v1/thing", rateLimit, (c) => c.json({ ok: true }));
  return app;
}

function env(overrides: Partial<ApiBindings> = {}): ApiBindings {
  return {
    ENVIRONMENT: "test",
    HYPERDRIVE: { connectionString: "postgres://unused" } as Hyperdrive,
    CACHE: {} as KVNamespace,
    INGEST_QUEUE: {} as ApiBindings["INGEST_QUEUE"],
    ...overrides,
  };
}

describe("MemoryRateLimiter", () => {
  it("allows `limit` requests in a window, refuses the next, slides open again", async () => {
    let now = 1_000_000;
    const limiter = new MemoryRateLimiter({ limit: 3, period: 60 }, () => now);

    expect(await limiter.limit("k")).toEqual({ success: true });
    now += 10_000;
    expect(await limiter.limit("k")).toEqual({ success: true });
    now += 10_000;
    expect(await limiter.limit("k")).toEqual({ success: true });
    now += 10_000;
    expect(await limiter.limit("k")).toEqual({ success: false });
    // Refusals do not consume: still refused a moment later.
    now += 1_000;
    expect(await limiter.limit("k")).toEqual({ success: false });

    // 60 s after the first hit it slides out; one slot opens, exactly one.
    now = 1_000_000 + 60_000 + 1;
    expect(await limiter.limit("k")).toEqual({ success: true });
    expect(await limiter.limit("k")).toEqual({ success: false });
    // Another 10 s and the second original hit expires too.
    now += 10_000;
    expect(await limiter.limit("k")).toEqual({ success: true });
  });

  it("counts keys independently", async () => {
    const limiter = new MemoryRateLimiter({ limit: 1, period: 60 }, () => 0);
    expect(await limiter.limit("a")).toEqual({ success: true });
    expect(await limiter.limit("a")).toEqual({ success: false });
    expect(await limiter.limit("b")).toEqual({ success: true });
  });

  it("a hit exactly at the window edge has expired", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter({ limit: 1, period: 10 }, () => now);
    expect(await limiter.limit("k")).toEqual({ success: true });
    now = 9_999;
    expect(await limiter.limit("k")).toEqual({ success: false });
    now = 10_000;
    expect(await limiter.limit("k")).toEqual({ success: true });
  });
});

/**
 * wrangler.jsonc is JSONC; strip `//` comments outside strings (the config
 * has no block comments) and parse. Kept here rather than pulling a parser
 * in: the file is ours and the shape is fixed.
 */
function readWranglerConfig(): {
  ratelimits: RatelimitEntry[];
  env: Record<string, { ratelimits: RatelimitEntry[] }>;
} {
  const raw = readFileSync(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  let out = "";
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (inString) {
      out += ch;
      if (ch === "\\") out += raw[++i];
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out += "\n";
    } else {
      out += ch;
    }
  }
  return JSON.parse(out);
}

interface RatelimitEntry {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
}

describe("per-plan configs", () => {
  it("come from PLANS, with the free numbers for an unknown plan", () => {
    expect(rateLimitConfigs("free")).toEqual({
      secret: { limit: 300, period: 60 },
      publishable: { limit: 120, period: 60 },
    });
    expect(rateLimitConfigs("paid")).toEqual({
      secret: { limit: 1000, period: 60 },
      publishable: { limit: 600, period: 60 },
    });
    expect(rateLimitConfig("enterprise", "secret")).toEqual(
      rateLimitConfig("free", "secret"),
    );
    expect(rateLimitConfig("paid", "publishable").limit).toBe(
      PLANS.paid.rateLimits.publishable,
    );
  });

  it("wrangler.jsonc binds one limiter per (plan, kind) with PLANS' numbers, in every env", () => {
    const config = readWranglerConfig();
    const expected = (Object.keys(PLANS) as Plan[]).flatMap((plan) =>
      (["secret", "publishable"] as const).map((kind) => ({
        name: RATE_LIMIT_BINDINGS[plan][kind],
        simple: rateLimitConfig(plan, kind),
      })),
    );
    const blocks = {
      local: config.ratelimits,
      preview: config.env.preview?.ratelimits,
      prod: config.env.prod?.ratelimits,
    };
    for (const [name, entries] of Object.entries(blocks)) {
      expect(entries, name).toBeDefined();
      const byName = new Map(
        (entries as RatelimitEntry[]).map((e) => [e.name, e]),
      );
      for (const e of expected) {
        expect(byName.get(e.name)?.simple, `${name} ${e.name}`).toEqual(
          e.simple,
        );
      }
      // The per-IP auth-failure budget (src/auth-throttle.ts) rides in the
      // same block and must mirror its constant too.
      expect(byName.get(AUTH_FAIL_BINDING)?.simple, `${name} auth`).toEqual(
        AUTH_FAIL_CONFIG,
      );
      expect(byName.get(AUTH_FAIL_BINDING)?.namespace_id).toBe(
        AUTH_FAIL_NAMESPACE_ID,
      );
      // Namespace ids are account-unique integers: no two bindings share one.
      const ids = (entries as RatelimitEntry[]).map((e) => e.namespace_id);
      expect(new Set(ids).size, `${name} namespace ids`).toBe(ids.length);
      expect(ids).toEqual(["1001", "1002", "1003", "1004", "1005"]);
    }
  });
});

describe("secondsToNextPeriod", () => {
  it("counts down to the next boundary and never says 0", () => {
    expect(secondsToNextPeriod(60, 0)).toBe(60);
    expect(secondsToNextPeriod(60, 1_000)).toBe(59);
    expect(secondsToNextPeriod(60, 59_000)).toBe(1);
    expect(secondsToNextPeriod(60, 59_999)).toBe(1);
    expect(secondsToNextPeriod(60, 60_000)).toBe(60);
    expect(secondsToNextPeriod(10, 123_456)).toBe(7);
  });
});

describe("rateLimit middleware", () => {
  it("passes an allowed request through with RateLimit-* headers", async () => {
    const limiter = recordingLimiter([true]);
    const res = await appWith(limiter).request("/v1/thing", {}, env());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("RateLimit-Policy")).toBe("300;w=60");
    expect(res.headers.get("RateLimit-Limit")).toBe("300");
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(limiter.keys).toEqual(["key-secret"]);
  });

  it("429 rate_limited envelope with Retry-After when the limiter refuses", async () => {
    const limiter = recordingLimiter([false]);
    const res = await appWith(limiter).request("/v1/thing", {}, env());

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      error: {
        code: "rate_limited",
        doc_url: "https://docs.proofql.com/errors#rate_limited",
        message: expect.stringMatching(/300 requests per 60 seconds/),
        request_id: res.headers.get("x-request-id"),
      },
    });
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(res.headers.get("RateLimit-Policy")).toBe("300;w=60");
    expect(res.headers.get("RateLimit-Limit")).toBe("300");
  });

  it("picks the limiter by key kind and keys it on the api key id", async () => {
    const secret = recordingLimiter();
    const publishable = recordingLimiter([false]);
    const app = appWith({ secret, publishable });

    const sk = await app.request("/v1/thing?kind=secret", {}, env());
    const pk = await app.request("/v1/thing?kind=publishable", {}, env());

    expect(sk.status).toBe(200);
    expect(pk.status).toBe(429);
    expect(secret.keys).toEqual(["key-secret"]);
    expect(publishable.keys).toEqual(["key-publishable"]);
    expect(pk.headers.get("RateLimit-Policy")).toBe("120;w=60");
    expect(pk.headers.get("RateLimit-Limit")).toBe("120");
    const body = (await pk.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(
      /120 requests per 60 seconds .* publishable key/,
    );
  });

  it("advertises the paid plan's limits for a paid account", async () => {
    const res = await appWith(recordingLimiter([false])).request(
      "/v1/thing?kind=publishable&plan=paid",
      {},
      env(),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("RateLimit-Policy")).toBe("600;w=60");
    expect(res.headers.get("RateLimit-Limit")).toBe("600");
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/600 requests per 60 seconds/);
    expect(body.error.message).toMatch(/paid plan/);
  });

  it("falls back to the in-memory limiter when the bindings are absent", async () => {
    // The real provider under Node: no RL_* bindings → MemoryRateLimiter per
    // (plan, kind), shared across requests in the isolate, keyed on the api
    // key id. Exhausting the free publishable window takes 120 requests.
    const id = `memory-${crypto.randomUUID()}`;
    const app = new Hono<AppEnv>();
    app.onError(onError);
    app.use(requestId);
    app.use(rateLimitMiddleware(bindingProvider));
    app.use(async (c, next) => {
      c.set("auth", {
        ...authFor(
          "publishable",
          c.req.query("plan") === "paid" ? "paid" : "free",
        ),
        apiKeyId: c.req.query("other") ? `${id}-other` : id,
      });
      await next();
    });
    app.get("/t", rateLimit, (c) => c.json({ ok: true }));
    const e = env();

    for (let i = 0; i < PLANS.free.rateLimits.publishable; i++) {
      expect((await app.request("/t", {}, e)).status).toBe(200);
    }
    const refused = await app.request("/t", {}, e);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("RateLimit-Limit")).toBe("120");
    // Another key id is unaffected, and the same key on the paid plan is
    // counted by a different limiter with a different limit.
    expect((await app.request("/t?other=1", {}, e)).status).toBe(200);
    const paid = await app.request("/t?plan=paid", {}, e);
    expect(paid.status).toBe(200);
    expect(paid.headers.get("RateLimit-Limit")).toBe("600");
  });

  it("uses the Cloudflare bindings when present, selected by plan and kind", async () => {
    const calls: { name: string; key: string }[] = [];
    const binding = (name: string, success: boolean): RateLimit => ({
      limit: async ({ key }) => {
        calls.push({ name, key });
        return { success };
      },
    });
    const limiters = bindingProvider(
      env({
        RL_SECRET: binding("RL_SECRET", true),
        RL_PUBLISHABLE: binding("RL_PUBLISHABLE", false),
        RL_SECRET_PAID: binding("RL_SECRET_PAID", true),
        RL_PUBLISHABLE_PAID: binding("RL_PUBLISHABLE_PAID", true),
      }),
    );

    expect(await limiters.free.secret.limit("k1")).toEqual({ success: true });
    expect(await limiters.free.publishable.limit("k2")).toEqual({
      success: false,
    });
    expect(await limiters.paid.secret.limit("k3")).toEqual({ success: true });
    expect(await limiters.paid.publishable.limit("k4")).toEqual({
      success: true,
    });
    expect(calls).toEqual([
      { name: "RL_SECRET", key: "k1" },
      { name: "RL_PUBLISHABLE", key: "k2" },
      { name: "RL_SECRET_PAID", key: "k3" },
      { name: "RL_PUBLISHABLE_PAID", key: "k4" },
    ]);
  });

  it("a config that binds only the free pair still limits paid keys in memory", async () => {
    const calls: string[] = [];
    const binding = (name: string): RateLimit => ({
      limit: async () => {
        calls.push(name);
        return { success: true };
      },
    });
    const limiters = bindingProvider(
      env({
        RL_SECRET: binding("RL_SECRET"),
        RL_PUBLISHABLE: binding("RL_PUBLISHABLE"),
      }),
    );
    expect(limiters.paid.secret).toBeInstanceOf(MemoryRateLimiter);
    expect(limiters.paid.publishable).toBeInstanceOf(MemoryRateLimiter);
    await limiters.paid.secret.limit("k");
    // The paid key was never counted against the free binding.
    expect(calls).toEqual([]);
  });

  it("the injected provider applies one fake to every plan", async () => {
    const limiter = recordingLimiter();
    const table = injectedProvider(limiter)(undefined);
    await table.free.secret.limit("a");
    await table.paid.publishable.limit("b");
    expect(limiter.keys).toEqual(["a", "b"]);
  });
});
