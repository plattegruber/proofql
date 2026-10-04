/**
 * The auth cache on the real `/v1/query` route (#108): the first request
 * looks the key up and stores it; the next one is answered from KV with
 * **no database at all** — proven by swapping in a db provider that throws
 * — and the entry stops being trusted on a generation bump (what the
 * dashboard does on revoke, policy and allowlist changes) or after the TTL.
 * Write routes never consult it: a revoked secret key is refused at once.
 */

import { bumpProjectGeneration, hashApiKey } from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { account, project, setupTestDb } from "@proofql/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { fakeCtx, fakeKv, issueKey, testEnv } from "../test/helpers.js";
import { createApp } from "./app.js";
import { AUTH_CACHE_TTL_SECONDS, authCacheKey } from "./auth-cache.js";

const t = setupTestDb();

const ORIGIN = "https://shop.example";

/** `createApp` whose first database touch throws — the "no database" proof. */
function appWithoutDb() {
  return createApp({
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

function appWithDb(db: Db) {
  return createApp({
    db,
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
    const kv = fakeKv({ now: () => clock });
    const env = testEnv({ kv });

    // First request: looked up and stored (after the response, via waitUntil).
    const first = await query(appWithDb(t.db), env, f.publishable.plaintext);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-cache")).toBe("MISS");
    const hash = await hashApiKey(f.publishable.plaintext);
    const stored = kv.peek(authCacheKey(hash));
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string)).toMatchObject({
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

    // Second request on an app that cannot open a database at all: auth
    // from KV, results from KV, usage into the buffer. 200 and a HIT.
    usageWrites.length = 0;
    const noDb = appWithoutDb();
    const second = await query(noDb, env, f.publishable.plaintext);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(usageWrites).toEqual([1]);

    // The entry expires with the TTL; the next request needs the database.
    clock += AUTH_CACHE_TTL_SECONDS * 1000;
    const expired = await query(noDb, env, f.publishable.plaintext);
    expect(expired.status).toBe(503);
    expect((await expired.json()) as object).toMatchObject({
      error: { code: "service_unavailable" },
    });
  });

  it("CORS preflight resolves the key from the cache too", async () => {
    const f = await fixture();
    const env = testEnv();
    await query(appWithDb(t.db), env, f.publishable.plaintext);

    const res = await appWithoutDb().request(
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
    await query(appWithDb(t.db), env, f.publishable.plaintext);
    const hash = await hashApiKey(f.publishable.plaintext);
    const raw = JSON.parse(kv.peek(authCacheKey(hash)) as string);
    raw.auth.kind = "secret";
    await kv.put(authCacheKey(hash), JSON.stringify(raw));

    // Falls through to the database, which still knows the key.
    const res = await query(appWithDb(t.db), env, f.publishable.plaintext);
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

  it("a KV fault on the auth cache falls through to the database", async () => {
    const f = await fixture();
    const kv = fakeKv();
    const broken = {
      ...kv,
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
      getWithMetadata: async () => {
        throw new Error("kv down");
      },
    };
    const env = testEnv();
    env.CACHE = broken as unknown as KVNamespace;
    const res = await query(appWithDb(t.db), env, f.publishable.plaintext);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-cache")).toBe("MISS");
  });
});
