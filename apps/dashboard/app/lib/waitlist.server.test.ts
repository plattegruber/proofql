// The waitlist action with Postgres and KV replaced by fakes: parsing,
// the honeypot, the per-address window, and what reaches the insert. The
// insert itself runs against the real schema in
// waitlist.server.integration.test.ts.
import {
  createKvFaultReporter,
  createLogger,
  exhaustedKv,
  MemoryKv,
  recordingSink,
} from "@proofql/core";
import { describe, expect, it } from "vitest";

import { createLoadContext } from "./context";
import type { WithDb } from "./db.server";
import { WAITLIST_RATE_LIMIT, WAITLIST_THROTTLED_MESSAGE } from "./waitlist";
import {
  CLIENT_IP_HEADER,
  DegradingLimiter,
  FixedWindowLimiter,
  handleWaitlistSubmission,
  limiterKeyFor,
  WAITLIST_LIMIT_PREFIX,
  type WaitlistActionData,
  type WaitlistLimiter,
  waitlistLimiterFor,
} from "./waitlist.server";

function env(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "prod",
    CLERK_SECRET_KEY: "sk_test_x",
    CACHE: {} as KVNamespace,
    HYPERDRIVE: { connectionString: "postgres://unused" } as Hyperdrive,
    ...overrides,
  } as Env;
}

/** A `withDb` that records the inserted emails instead of touching Postgres. */
function fakeWithDb(existing: string[] = []) {
  const rows = new Set(existing);
  const inserted: string[] = [];
  const db = {
    insert: () => ({
      values: (value: { email: string }) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (rows.has(value.email)) return [];
            rows.add(value.email);
            inserted.push(value.email);
            return [{ id: "new" }];
          },
        }),
      }),
    }),
  };
  const withDb: WithDb = async (_context, fn) => fn(db as never);
  return { withDb, inserted };
}

function submit(
  fields: Record<string, string>,
  options: { ip?: string; limiter?: WaitlistLimiter; existing?: string[] } = {},
) {
  const { withDb, inserted } = fakeWithDb(options.existing);
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
  });
  if (options.ip) headers.set(CLIENT_IP_HEADER, options.ip);
  const request = new Request("https://dash.test/sign-up", {
    method: "POST",
    headers,
    body: new URLSearchParams(fields),
  });
  const limiter = options.limiter ?? { limit: async () => ({ success: true }) };
  const result = handleWaitlistSubmission(
    {
      request,
      context: createLoadContext({ env: env(), ctx: {} as ExecutionContext }),
    },
    { withDb, limiterFor: () => limiter },
  );
  return { result, inserted };
}

async function unwrap(result: ReturnType<typeof submit>["result"]) {
  const value = (await result) as {
    data: WaitlistActionData;
    init?: ResponseInit;
  };
  return { body: value.data, status: value.init?.status ?? 200 };
}

describe("handleWaitlistSubmission", () => {
  it("normalizes and stores a valid address", async () => {
    const { result, inserted } = submit({ email: " Ada@Example.com " });
    expect(await unwrap(result)).toEqual({ body: { ok: true }, status: 200 });
    expect(inserted).toEqual(["ada@example.com"]);
  });

  it("answers a repeat address exactly like a new one", async () => {
    const { result, inserted } = submit(
      { email: "ada@example.com" },
      { existing: ["ada@example.com"] },
    );
    expect(await unwrap(result)).toEqual({ body: { ok: true }, status: 200 });
    expect(inserted).toEqual([]);
  });

  it("returns 422 field errors for a malformed address", async () => {
    const { result, inserted } = submit({ email: "nope" });
    const { body, status } = await unwrap(result);
    expect(status).toBe(422);
    expect(body).toEqual({
      ok: false,
      fieldErrors: { email: ["Enter a valid email address."] },
    });
    expect(inserted).toEqual([]);
  });

  it("says yes to a filled honeypot and stores nothing", async () => {
    const { result, inserted } = submit({
      email: "bot@example.com",
      website: "https://spam.example",
    });
    expect(await unwrap(result)).toEqual({ body: { ok: true }, status: 200 });
    expect(inserted).toEqual([]);
  });

  it("refuses with 429 and a form-level error when the address is over its window", async () => {
    const limiter: WaitlistLimiter = {
      limit: async () => ({ success: false }),
    };
    const { result, inserted } = submit(
      { email: "ada@example.com" },
      { ip: "203.0.113.7", limiter },
    );
    const value = (await result) as {
      data: WaitlistActionData;
      init?: ResponseInit;
    };
    expect(value.init?.status).toBe(429);
    expect(new Headers(value.init?.headers).get("Retry-After")).toBe(
      String(WAITLIST_RATE_LIMIT.period),
    );
    expect(value.data).toEqual({
      ok: false,
      fieldErrors: { "": [WAITLIST_THROTTLED_MESSAGE] },
    });
    expect(inserted).toEqual([]);
  });

  it("does not consult the limiter without a client address", async () => {
    let calls = 0;
    const limiter: WaitlistLimiter = {
      limit: async () => {
        calls += 1;
        return { success: false };
      },
    };
    const { result } = submit({ email: "ada@example.com" }, { limiter });
    expect(await unwrap(result)).toEqual({ body: { ok: true }, status: 200 });
    expect(calls).toBe(0);
  });
});

describe("FixedWindowLimiter", () => {
  it("allows `limit` attempts per window, then refuses until the window ends", async () => {
    let now = 1_000_000;
    const kv = new MemoryKv();
    const limiter = new FixedWindowLimiter(
      kv,
      { limit: 2, period: 60 },
      () => now,
    );
    expect(await limiter.limit("k")).toEqual({ success: true });
    expect(await limiter.limit("k")).toEqual({ success: true });
    expect(await limiter.limit("k")).toEqual({ success: false });
    // Another key is its own window.
    expect(await limiter.limit("other")).toEqual({ success: true });
    now += 61_000;
    expect(await limiter.limit("k")).toEqual({ success: true });
  });

  it("writes a TTL of at least KV's 60 s minimum", async () => {
    const puts: { expirationTtl?: number }[] = [];
    const kv = {
      get: async () => null,
      put: async (_k: string, _v: string, o?: { expirationTtl?: number }) => {
        puts.push(o ?? {});
      },
    };
    await new FixedWindowLimiter(kv, { limit: 1, period: 5 }).limit("k");
    expect(puts[0]?.expirationTtl).toBe(60);
  });

  it("treats an unparseable or expired counter as absent", async () => {
    const kv = new MemoryKv({ k: "garbage" });
    const limiter = new FixedWindowLimiter(
      kv,
      { limit: 1, period: 60 },
      () => 5_000,
    );
    expect(await limiter.limit("k")).toEqual({ success: true });
    await kv.put("stale", JSON.stringify({ count: 99, resetAt: 1 }));
    expect(await limiter.limit("stale")).toEqual({ success: true });
  });
});

describe("limiterKeyFor", () => {
  it("hashes the address under the waitlist prefix", async () => {
    const key = await limiterKeyFor("203.0.113.7");
    expect(key.startsWith(WAITLIST_LIMIT_PREFIX)).toBe(true);
    expect(key).not.toContain("203.0.113.7");
    expect(key).toBe(await limiterKeyFor("203.0.113.7"));
    expect(key).not.toBe(await limiterKeyFor("203.0.113.8"));
  });
});

describe("KV at its daily limits (#158)", () => {
  for (const which of [{ reads: true }, { reads: false, writes: true }]) {
    it(`degrades to the in-memory limiter when KV throws (reads ${which.reads ? "and writes" : "ok, writes"} exhausted)`, async () => {
      const rec = recordingSink();
      const log = createLogger({
        service: "dashboard",
        environment: "test",
        sink: rec.sink,
      });
      const kv = exhaustedKv(which);
      const limiter = new DegradingLimiter(
        new FixedWindowLimiter(kv, { limit: 2, period: 60 }),
        new FixedWindowLimiter(new MemoryKv(), { limit: 2, period: 60 }),
        log,
        createKvFaultReporter(),
      );
      expect(await limiter.limit("k")).toEqual({ success: true });
      expect(await limiter.limit("k")).toEqual({ success: true });
      // Still a throttle: the memory fallback counts.
      expect(await limiter.limit("k")).toEqual({ success: false });
      const lines = rec.find("kv.limit_exceeded");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: "warn",
        site: "dashboard.waitlist_limiter",
      });
    });
  }

  it("the production wiring degrades: a sign-up never fails on KV", async () => {
    const limiter = waitlistLimiterFor({
      CACHE: exhaustedKv() as unknown as KVNamespace,
    });
    expect(await limiter.limit("waitlist:ip:z")).toEqual({ success: true });
  });
});
