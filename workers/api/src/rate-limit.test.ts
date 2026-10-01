/**
 * Rate limiting without a database: the window math of the in-memory
 * limiter, `RATE_LIMITS` parsing, and the middleware's 429 contract. Auth
 * is stood in for by a middleware that sets `auth` directly, so these tests
 * drive `rateLimit` exactly as `requireApiKey` drives `enforceRateLimit`.
 */

import type { ApiKeyKind } from "@proofql/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiBindings, AppEnv, AuthContext } from "./bindings.js";
import { onError } from "./errors.js";
import {
  bindingProvider,
  DEFAULT_RATE_LIMITS,
  injectedProvider,
  MemoryRateLimiter,
  parseRateLimits,
  type RateLimiter,
  rateLimit,
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

function authFor(kind: ApiKeyKind): AuthContext {
  return {
    apiKeyId: `key-${kind}`,
    projectId: "project-1",
    environment: "live",
    kind,
    project: {
      allowedOrigins: [],
      minRating: 4,
      similarityFloor: 0.55,
      showBadge: true,
    },
  };
}

/** Request id → fake auth (`?kind=`) → rate limit → handler. */
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
    c.set("auth", authFor(kind));
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

describe("parseRateLimits", () => {
  it("returns the defaults for an absent or blank var", () => {
    expect(parseRateLimits(undefined)).toEqual(DEFAULT_RATE_LIMITS);
    expect(parseRateLimits("  ")).toEqual(DEFAULT_RATE_LIMITS);
    expect(DEFAULT_RATE_LIMITS).toEqual({
      secret: { limit: 300, period: 60 },
      publishable: { limit: 120, period: 60 },
    });
  });

  it("merges a partial override onto the defaults without mutating them", () => {
    const parsed = parseRateLimits('{"publishable":{"limit":600}}');
    expect(parsed).toEqual({
      secret: { limit: 300, period: 60 },
      publishable: { limit: 600, period: 60 },
    });
    expect(DEFAULT_RATE_LIMITS.publishable.limit).toBe(120);

    expect(
      parseRateLimits('{"secret":{"limit":10,"period":10},"publishable":{}}'),
    ).toEqual({
      secret: { limit: 10, period: 10 },
      publishable: { limit: 120, period: 60 },
    });
  });

  it("rejects malformed values loudly", () => {
    expect(() => parseRateLimits("{")).toThrow(/valid JSON/);
    expect(() => parseRateLimits("[]")).toThrow(/object/);
    expect(() => parseRateLimits('{"admin":{"limit":1}}')).toThrow(
      /unknown key kind "admin"/,
    );
    expect(() => parseRateLimits('{"secret":5}')).toThrow(/must be an object/);
    expect(() => parseRateLimits('{"secret":{"limit":0}}')).toThrow(
      /secret\.limit must be a positive integer/,
    );
    expect(() => parseRateLimits('{"secret":{"period":"60"}}')).toThrow(
      /secret\.period must be a positive integer/,
    );
    expect(() => parseRateLimits('{"secret":{"limit":1.5}}')).toThrow(
      /positive integer/,
    );
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

  it("advertises RATE_LIMITS overrides", async () => {
    const res = await appWith(recordingLimiter([false])).request(
      "/v1/thing?kind=publishable",
      {},
      env({ RATE_LIMITS: '{"publishable":{"limit":600,"period":10}}' }),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("RateLimit-Policy")).toBe("600;w=10");
    expect(Number(res.headers.get("Retry-After"))).toBeLessThanOrEqual(10);
  });

  it("falls back to the in-memory limiter when the bindings are absent", async () => {
    // The real provider under Node: no RL_* bindings → MemoryRateLimiter,
    // shared across requests in the isolate, keyed on the api key id.
    const id = `memory-${crypto.randomUUID()}`;
    const app = new Hono<AppEnv>();
    app.onError(onError);
    app.use(requestId);
    app.use(rateLimitMiddleware(bindingProvider));
    app.use(async (c, next) => {
      c.set("auth", {
        ...authFor("publishable"),
        apiKeyId: c.req.query("other") ? `${id}-other` : id,
      });
      await next();
    });
    app.get("/t", rateLimit, (c) => c.json({ ok: true }));
    const e = env({ RATE_LIMITS: '{"publishable":{"limit":2}}' });

    expect((await app.request("/t", {}, e)).status).toBe(200);
    expect((await app.request("/t", {}, e)).status).toBe(200);
    const refused = await app.request("/t", {}, e);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("RateLimit-Limit")).toBe("2");
    // Another key id is unaffected.
    expect((await app.request("/t?other=1", {}, e)).status).toBe(200);
  });

  it("uses the Cloudflare bindings when present", async () => {
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
      }),
    );

    expect(await limiters.secret.limit("k1")).toEqual({ success: true });
    expect(await limiters.publishable.limit("k2")).toEqual({ success: false });
    expect(calls).toEqual([
      { name: "RL_SECRET", key: "k1" },
      { name: "RL_PUBLISHABLE", key: "k2" },
    ]);
  });
});
