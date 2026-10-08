/**
 * The per-IP auth-failure throttle without a database: which responses
 * count, which do not, what the overflow looks like, and the penalty box.
 * Two harnesses: the real app with a throwing db provider (so any lookup
 * that should not happen fails loudly), and a bare Hono app whose handler
 * sets `auth` or not on demand, standing in for the route-level outcomes.
 */

import { generateApiKey, recordingSink } from "@proofql/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import {
  AUTH_FAIL_CONFIG,
  authFailureThrottle,
  bindingAuthFailureLimiter,
  CLIENT_IP_HEADER,
  injectedAuthFailureLimiter,
  isAuthFailure,
  isAuthRoute,
  resetPenaltyBox,
} from "./auth-throttle.js";
import type { ApiBindings, AppEnv, AuthContext } from "./bindings.js";
import { onError } from "./errors.js";
import type { RateLimiter } from "./rate-limit.js";
import { REQUEST_ID_HEADER, requestContext } from "./request-id.js";

/** A limiter that records its keys and answers from a script (default allow). */
function recordingLimiter(outcomes: boolean[] = []) {
  const keys: string[] = [];
  const limiter: RateLimiter & { keys: string[] } = {
    keys,
    limit: async (key) => {
      keys.push(key);
      return { success: outcomes.shift() ?? true };
    },
  };
  return limiter;
}

const fakeAuth: AuthContext = {
  apiKeyId: "key-1",
  projectId: "project-1",
  environment: "live",
  kind: "publishable",
  plan: "free",
  project: {
    allowedOrigins: [],
    minRating: 4,
    similarityFloor: 0.55,
    category: null,
  },
};

/**
 * Bare harness: `/v1/thing?outcome=<status>&auth=1` answers with that
 * status, setting `auth` first when asked — the shapes `requireApiKey`,
 * the CORS check and the per-key limiter produce.
 */
function bareApp(limiter: RateLimiter, now?: () => number) {
  const out = recordingSink();
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use(requestContext({ sink: out.sink }));
  app.use(
    authFailureThrottle({
      provider: injectedAuthFailureLimiter(limiter),
      ...(now === undefined ? {} : { now }),
    }),
  );
  app.all("/v1/thing", (c) => {
    if (c.req.query("auth") === "1") c.set("auth", fakeAuth);
    const status = Number(c.req.query("outcome") ?? "200");
    return c.json({ status }, status as 200);
  });
  app.get("/health", (c) => c.json({ ok: true }));
  return Object.assign(app, { out });
}

let ipCounter = 0;
/** A fresh address per test: the penalty box is module state. */
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

beforeEach(() => {
  resetPenaltyBox();
});

describe("classification", () => {
  it("only /v1 routes authenticate", () => {
    expect(isAuthRoute("/v1/query")).toBe(true);
    expect(isAuthRoute("/v1/reviews/abc")).toBe(true);
    expect(isAuthRoute("/v1")).toBe(true);
    expect(isAuthRoute("/health")).toBe(false);
    expect(isAuthRoute("/v10/x")).toBe(false);
  });

  it("falls back to the in-memory limiter without the binding, and adapts it when bound", async () => {
    expect(bindingAuthFailureLimiter(undefined)).toBe(
      bindingAuthFailureLimiter({} as ApiBindings),
    );
    let seen: string | undefined;
    const binding = {
      limit: async ({ key }: { key: string }) => {
        seen = key;
        return { success: false };
      },
    } as unknown as RateLimit;
    const limiter = bindingAuthFailureLimiter({
      RL_AUTH_FAIL: binding,
    } as ApiBindings);
    expect(await limiter.limit("1.2.3.4")).toEqual({ success: false });
    expect(seen).toBe("1.2.3.4");
  });
});

describe("what counts as a failure", () => {
  it("counts a 401 and a 403 with no resolved key, keyed on the client address", async () => {
    const limiter = recordingLimiter();
    const app = bareApp(limiter);
    const ip = freshIp();
    for (const outcome of [401, 403]) {
      const res = await app.request(`/v1/thing?outcome=${outcome}`, {
        headers: { [CLIENT_IP_HEADER]: ip },
      });
      expect(res.status).toBe(outcome);
    }
    expect(limiter.keys).toEqual([ip, ip]);
  });

  it("never counts a request that resolved a key, whatever its status", async () => {
    const limiter = recordingLimiter();
    const app = bareApp(limiter);
    const ip = freshIp();
    for (const outcome of [200, 403, 422, 429]) {
      await app.request(`/v1/thing?outcome=${outcome}&auth=1`, {
        headers: { [CLIENT_IP_HEADER]: ip },
      });
    }
    expect(limiter.keys).toEqual([]);
  });

  it("ignores other statuses, other paths, preflights, and requests with no client address", async () => {
    const limiter = recordingLimiter();
    const app = bareApp(limiter);
    const ip = freshIp();
    await app.request("/v1/thing?outcome=404", {
      headers: { [CLIENT_IP_HEADER]: ip },
    });
    await app.request("/v1/thing?outcome=500", {
      headers: { [CLIENT_IP_HEADER]: ip },
    });
    await app.request("/health", { headers: { [CLIENT_IP_HEADER]: ip } });
    await app.request("/v1/thing?outcome=401", {
      method: "OPTIONS",
      headers: { [CLIENT_IP_HEADER]: ip },
    });
    await app.request("/v1/thing?outcome=401");
    expect(limiter.keys).toEqual([]);
  });

  it("isAuthFailure reads the response status and the auth variable", () => {
    const make = (status: number, auth: boolean) =>
      ({
        res: { status },
        get: () => (auth ? fakeAuth : undefined),
      }) as unknown as Parameters<typeof isAuthFailure>[0];
    expect(isAuthFailure(make(401, false))).toBe(true);
    expect(isAuthFailure(make(403, false))).toBe(true);
    expect(isAuthFailure(make(403, true))).toBe(false);
    expect(isAuthFailure(make(422, false))).toBe(false);
  });
});

describe("overflow", () => {
  it("turns the failure that exhausts the budget into a 429 with Retry-After, and logs it", async () => {
    const limiter = recordingLimiter([true, false]);
    const app = bareApp(limiter);
    const ip = freshIp();
    const first = await app.request("/v1/thing?outcome=401", {
      headers: { [CLIENT_IP_HEADER]: ip },
    });
    expect(first.status).toBe(401);

    const second = await app.request("/v1/thing?outcome=401", {
      headers: { [CLIENT_IP_HEADER]: ip, [REQUEST_ID_HEADER]: "req-t1" },
    });
    expect(second.status).toBe(429);
    const retryAfter = Number(second.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(AUTH_FAIL_CONFIG.period);
    expect(second.headers.get(REQUEST_ID_HEADER)).toBe("req-t1");
    expect(await second.json()).toMatchObject({
      error: {
        code: "rate_limited",
        message: expect.stringMatching(/failed authentication attempts/),
        request_id: "req-t1",
      },
    });
    expect(app.out.only("auth.throttled")).toMatchObject({
      level: "warn",
      request_id: "req-t1",
      phase: "failure",
      limit: AUTH_FAIL_CONFIG.limit,
      period: AUTH_FAIL_CONFIG.period,
      retry_after: retryAfter,
    });
    // The address is never written to a log line.
    for (const record of app.out.records) {
      expect(JSON.stringify(record)).not.toContain(ip);
    }
  });

  it("then refuses the boxed address before the route runs, until the box expires", async () => {
    let clock = 1_000_000;
    const limiter = recordingLimiter([false]);
    const app = bareApp(limiter, () => clock);
    const ip = freshIp();
    const overflow = await app.request("/v1/thing?outcome=401", {
      headers: { [CLIENT_IP_HEADER]: ip },
    });
    expect(overflow.status).toBe(429);

    // A would-be success from the same address is refused without reaching
    // the handler (its status would be 200) and without consulting the
    // limiter again.
    const boxed = await app.request("/v1/thing?outcome=200&auth=1", {
      headers: { [CLIENT_IP_HEADER]: ip },
    });
    expect(boxed.status).toBe(429);
    expect(await boxed.json()).toMatchObject({
      error: { code: "rate_limited" },
    });
    expect(limiter.keys).toHaveLength(1);
    expect(app.out.find("auth.throttled").at(-1)).toMatchObject({
      phase: "penalty_box",
    });

    // Another address is untouched.
    const other = await app.request("/v1/thing?outcome=200&auth=1", {
      headers: { [CLIENT_IP_HEADER]: freshIp() },
    });
    expect(other.status).toBe(200);

    // Past the period boundary the box is gone and the handler runs again.
    clock += AUTH_FAIL_CONFIG.period * 1000 + 1;
    const after = await app.request("/v1/thing?outcome=200&auth=1", {
      headers: { [CLIENT_IP_HEADER]: ip },
    });
    expect(after.status).toBe(200);
  });
});

describe("through the real app", () => {
  const app = createApp({
    dbProvider: () => {
      throw new Error("database must not be touched by a throttled request");
    },
    authFailureLimiter: recordingLimiter([false]),
  });

  it("boxes an address after the limiter refuses and then refuses a well-formed key before any lookup", async () => {
    const ip = freshIp();
    const first = await app.request("/v1/reviews", {
      headers: { [CLIENT_IP_HEADER]: ip },
    });
    expect(first.status).toBe(429);

    // A well-formed key would reach the database (and throw) if the box
    // were not consulted first.
    const { plaintext } = await generateApiKey({
      kind: "secret",
      environment: "live",
    });
    const second = await app.request("/v1/reviews", {
      headers: {
        [CLIENT_IP_HEADER]: ip,
        authorization: `Bearer ${plaintext}`,
      },
    });
    expect(second.status).toBe(429);
    expect(second.headers.get("Cache-Control")).toBe("no-store");
  });

  it("never engages without a client address (unit tests, local curl)", async () => {
    const res = await app.request("/v1/reviews");
    expect(res.status).toBe(401);
  });
});
