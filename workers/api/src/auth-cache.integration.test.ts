/**
 * The auth cache on the real `/v1/query` route (#108, #158): the first
 * request looks the key up and stores it; the next one is answered from the
 * cache with **no database at all** — proven by swapping in a db provider
 * that throws — and the entry stops being trusted on a generation bump
 * (what the dashboard does on revoke, policy and allowlist changes) or
 * after the TTL, except as a stale stand-in while the database is down.
 * Write routes never consult it: a revoked secret key is refused at once.
 * Nothing about it touches KV except the generation read.
 */

import {
  bumpProjectGeneration,
  exhaustedKv,
  hashApiKey,
  recordingSink,
} from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { account, project, setupTestDb } from "@proofql/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { fakeCtx, fakeKv, issueKey, testEnv } from "../test/helpers.js";
import { createApp } from "./app.js";
import {
  AUTH_CACHE_TTL_SECONDS,
  AUTH_STALE_SECONDS,
  AuthCache,
  UNKNOWN_GENERATION,
} from "./auth-cache.js";

const t = setupTestDb();

const ORIGIN = "https://shop.example";

/** `createApp` whose first database touch throws — the "no database" proof. */
function appWithoutDb(authCache: AuthCache, now?: () => number) {
  return createApp({
    authCache,
    ...(now === undefined ? {} : { now }),
    dbProvider: () => {
      throw Object.assign(new Error("database must not be opened"), {
        code: "53300",
      });
    },
    rateLimiter: { limit: async () => ({ success: true }) },
    usageFlushMs: 0,
    // The buffer must not open a database either; count its attempts.
    usageWriter: async (_env, deltas) => {
      usageWrites.push(deltas.length);
    },
  });
}
const usageWrites: number[] = [];

function appWithDb(db: Db, authCache = new AuthCache(), now?: () => number) {
  return createApp({
    db,
    authCache,
    ...(now === undefined ? {} : { now }),
    rateLimiter: { limit: async () => ({ success: true }) },
  });
}

async function fixture(opts: { revoke?: boolean } = {}) {
  const acct = await account(t.db, { plan: "paid" });
  const p = await project(t.db, {
    accountId: acct.id,
    allowedOrigins: [ORIGIN],
  });
  const publishable = await issueKey(t.db, p.id, "publishable");
  const secret = await issueKey(t.db, p.id, "secret");
  if (opts.revoke) {
    await t.db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiKeys.id, publishable.row.id));
  }
  return { project: p, publishable, secret };
}

async function query(
  app: ReturnType<typeof createApp>,
  env: ReturnType<typeof testEnv>,
  key: string,
) {
  const ctx = fakeCtx();
  const res = await app.request(
    `/v1/query?key=${encodeURIComponent(key)}`,
    { headers: { origin: ORIGIN } },
    env,
    ctx.asExecutionContext(),
  );
  await ctx.flush();
  return res;
}

describe("auth cache on /v1/query", () => {
  it("stores the resolved key under its hash after a lookup, and a HIT opens no database", async () => {
    const f = await fixture();
    let clock = Date.parse("2026-10-04T12:00:00Z");
    const now = () => clock;
    const kv = fakeKv({ now });
    const env = testEnv({ kv });
    const cache = new AuthCache({ now });

    // First request: looked up and stored in the isolate tier.
    const first = await query(
      appWithDb(t.db, cache, now),
      env,
      f.publishable.plaintext,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("x-cache")).toBe("MISS");
    const hash = await hashApiKey(f.publishable.plaintext);
    expect(cache.lru.get(hash, Number.POSITIVE_INFINITY)?.value).toMatchObject({
      v: 1,
      generation: 0,
      auth: {
        projectId: f.project.id,
        kind: "publishable",
        environment: "live",
        plan: "paid",
        project: { allowedOrigins: [ORIGIN] },
      },
    });
    // The auth cache never writes KV (#158); only the query result is there.
    expect([...kv.store.keys()].filter((k) => !k.startsWith("q:"))).toEqual([]);

    // Second request on an app that cannot open a database at all: auth
    // from the cache, results from KV, usage into the buffer. 200 and a HIT.
    usageWrites.length = 0;
    const noDb = appWithoutDb(cache, now);
    const second = await query(noDb, env, f.publishable.plaintext);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(usageWrites).toEqual([1]);

    // Past the TTL the entry needs a lookup — but the database is down, so
    // the stale entry stands in (stale-if-error) and the HIT is served…
    clock += AUTH_CACHE_TTL_SECONDS * 1000;
    const stale = await query(noDb, env, f.publishable.plaintext);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-cache")).toBe("HIT");

    // …until the stale window ends too.
    clock += AUTH_STALE_SECONDS * 1000;
    const expired = await query(noDb, env, f.publishable.plaintext);
    expect(expired.status).toBe(503);
    expect((await expired.json()) as object).toMatchObject({
      error: { code: "service_unavailable" },
    });
  });

  it("a stale entry is never served when the database answers, nor after a bump", async () => {
    const f = await fixture();
    let clock = Date.now();
    const now = () => clock;
    const kv = fakeKv({ now });
    const env = testEnv({ kv });
    const cache = new AuthCache({ now });
    expect(
      (await query(appWithDb(t.db, cache, now), env, f.publishable.plaintext))
        .status,
    ).toBe(200);
    await t.db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiKeys.id, f.publishable.row.id));
    clock += AUTH_CACHE_TTL_SECONDS * 1000;
    // The database is up: the lookup is the truth.
    expect(
      (await query(appWithDb(t.db, cache, now), env, f.publishable.plaintext))
        .status,
    ).toBe(401);

    // Re-prime with a live key, bump, then take the database away: a bumped
    // entry is not a stand-in.
    const other = await issueKey(t.db, f.project.id, "publishable");
    await query(appWithDb(t.db, cache, now), env, other.plaintext);
    await bumpProjectGeneration(kv, f.project.id);
    clock += AUTH_CACHE_TTL_SECONDS * 1000;
    expect(
      (await query(appWithoutDb(cache, now), env, other.plaintext)).status,
    ).toBe(503);
  });

  it("CORS preflight resolves the key from the cache too", async () => {
    const f = await fixture();
    const env = testEnv();
    const cache = new AuthCache();
    await query(appWithDb(t.db, cache), env, f.publishable.plaintext);

    const res = await appWithoutDb(cache).request(
      `/v1/query?key=${encodeURIComponent(f.publishable.plaintext)}`,
      {
        method: "OPTIONS",
        headers: {
          origin: ORIGIN,
          "access-control-request-method": "GET",
        },
      },
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("a generation bump invalidates the entry: a revoked key is refused on the next request", async () => {
    const f = await fixture();
    const kv = fakeKv();
    const env = testEnv({ kv });
    const app = appWithDb(t.db);
    expect((await query(app, env, f.publishable.plaintext)).status).toBe(200);

    // Revoke in the database. Until the bump lands the cached entry still
    // authenticates (the documented ≤ 60 s window)…
    await t.db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiKeys.id, f.publishable.row.id));
    expect((await query(app, env, f.publishable.plaintext)).status).toBe(200);

    // …and the dashboard's bump ends it at once.
    await bumpProjectGeneration(kv, f.project.id);
    const refused = await query(app, env, f.publishable.plaintext);
    expect(refused.status).toBe(401);
    expect((await refused.json()) as object).toMatchObject({
      error: { code: "unauthorized" },
    });
  });

  it("a policy change (generation bump) is read on the next request", async () => {
    const f = await fixture();
    const kv = fakeKv();
    const env = testEnv({ kv });
    const app = appWithDb(t.db);
    expect((await query(app, env, f.publishable.plaintext)).status).toBe(200);

    await t.db
      .update(schema.projects)
      .set({ allowedOrigins: ["https://other.example"] })
      .where(eq(schema.projects.id, f.project.id));
    // Still allowed from the cached allowlist until the bump.
    expect((await query(app, env, f.publishable.plaintext)).status).toBe(200);

    await bumpProjectGeneration(kv, f.project.id);
    const refused = await query(app, env, f.publishable.plaintext);
    expect(refused.status).toBe(403);
  });

  it("a kind/environment mismatch between the entry and the key is a miss, never trusted", async () => {
    const f = await fixture();
    const kv = fakeKv();
    const env = testEnv({ kv });
    const cache = new AuthCache();
    await query(appWithDb(t.db, cache), env, f.publishable.plaintext);
    const hash = await hashApiKey(f.publishable.plaintext);
    const entry = cache.lru.get(hash, Number.POSITIVE_INFINITY)?.value;
    if (entry === undefined) throw new Error("entry missing");
    cache.lru.set(hash, { ...entry, auth: { ...entry.auth, kind: "secret" } });

    // A database-less app must not trust it…
    expect(
      (await query(appWithoutDb(cache), env, f.publishable.plaintext)).status,
    ).toBe(503);
    // …and with the database it falls through to the lookup.
    const res = await query(
      appWithDb(t.db, cache),
      env,
      f.publishable.plaintext,
    );
    expect(res.status).toBe(200);
  });

  it("write routes never use the cache: a revoked secret key is refused immediately", async () => {
    const f = await fixture();
    const kv = fakeKv();
    const env = testEnv({ kv });
    const app = appWithDb(t.db);
    // Prime the cache through /v1/query with the secret key.
    const primed = await app.request(
      "/v1/query",
      { headers: { authorization: `Bearer ${f.secret.plaintext}` } },
      env,
    );
    expect(primed.status).toBe(200);

    await t.db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiKeys.id, f.secret.row.id));

    const write = await app.request(
      "/v1/reviews",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.secret.plaintext}`,
          "content-type": "application/json",
        },
        body: JSON.stringify([]),
      },
      env,
    );
    expect(write.status).toBe(401);
  });

  it("KV at its daily read limit: auth from the database once, then the cache; queries uncachable, never failed", async () => {
    const f = await fixture();
    const kv = exhaustedKv();
    const env = testEnv();
    env.CACHE = kv as unknown as KVNamespace;
    const rec = recordingSink();
    const cache = new AuthCache();
    const app = createApp({
      db: t.db,
      authCache: cache,
      rateLimiter: { limit: async () => ({ success: true }) },
      logSink: rec.sink,
    });

    const first = await query(app, env, f.publishable.plaintext);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-cache")).toBe("MISS");
    const hash = await hashApiKey(f.publishable.plaintext);
    expect(
      cache.lru.get(hash, Number.POSITIVE_INFINITY)?.value.generation,
    ).toBe(UNKNOWN_GENERATION);

    // The next request trusts the fresh entry on its age alone: no
    // database for auth (proved by an app that has none), still a MISS
    // because the query cannot be keyed — so it fails only at the quota
    // read, which is what a database-less app must do on a miss.
    const second = await query(
      appWithoutDb(cache),
      env,
      f.publishable.plaintext,
    );
    expect(second.status).toBe(503);
    const secondDb = await query(app, env, f.publishable.plaintext);
    expect(secondDb.status).toBe(200);
    // Uncachable: no KV write was even attempted.
    expect(kv.calls.put).toBe(0);
    expect(rec.find("kv.limit_exceeded")).toHaveLength(1);
    expect(rec.only("kv.limit_exceeded")).toMatchObject({
      level: "warn",
      op: "get",
      site: "api.generation",
    });
  });
});
