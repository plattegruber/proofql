/**
 * The monthly query quota against the real schema, through the real
 * `GET /v1/query` route (#71; no `q`, so nothing is embedded). Two stub
 * routes mounted the same way (auth, `queryQuota`, handler) cover what the
 * real route cannot yet: one calls `markCacheHit` to exercise the #28 seam
 * (retire it once the route serves from KV), one throws so the "errors are
 * not charged" rule is pinned.
 */

import { generateApiKey, PLAN_QUERY_LIMITS } from "@proofql/core";
import { schema } from "@proofql/db";
import { account, apiKey, project, setupTestDb } from "@proofql/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { requireAnyKey } from "./auth.js";
import type { ApiBindings } from "./bindings.js";
import { markCacheHit, monthStart, queryQuota } from "./quota.js";

const t = setupTestDb();

const env: ApiBindings = {
  ENVIRONMENT: "test",
  HYPERDRIVE: { connectionString: "postgres://unused" } as Hyperdrive,
  CACHE: {} as KVNamespace,
  INGEST_QUEUE: {} as ApiBindings["INGEST_QUEUE"],
};

function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    flush: () => Promise.allSettled(pending),
  };
}

function app() {
  const a = createApp({
    db: t.db,
    rateLimiter: { limit: async () => ({ success: true }) },
  });
  a.get("/v1/query-cached", requireAnyKey, queryQuota, (c) => {
    markCacheHit(c);
    return c.json({ results: [], cached: true });
  });
  a.get("/v1/query-failing", requireAnyKey, queryQuota, () => {
    throw new Error("search exploded");
  });
  return a;
}

/** The snippet's origin: publishable keys must come from a listed page. */
const ORIGIN = "https://shop.example";

async function query(plaintext: string, path = "/v1/query") {
  const ctx = fakeCtx();
  const res = await app().request(
    path,
    { headers: { authorization: `Bearer ${plaintext}`, origin: ORIGIN } },
    env,
    ctx as unknown as ExecutionContext,
  );
  await ctx.flush();
  // biome-ignore lint/suspicious/noExplicitAny: reads both shapes
  const json = (await res.json()) as any;
  return { res, json };
}

async function setup(opts: { plan?: "free" | "paid" } = {}) {
  const acct = await account(t.db, { plan: opts.plan ?? "free" });
  const p = await project(t.db, {
    accountId: acct.id,
    allowedOrigins: [ORIGIN],
  });
  const generated = await generateApiKey({
    kind: "publishable",
    environment: "live",
  });
  await apiKey(t.db, {
    projectId: p.id,
    kind: "publishable",
    environment: "live",
    keyHash: generated.hash,
    prefix: generated.prefix,
  });
  return { project: p, plaintext: generated.plaintext };
}

async function seedUsage(
  projectId: string,
  month: string,
  queries: number,
  cacheHits = 0,
) {
  await t.db
    .insert(schema.usage)
    .values({ projectId, month, queries, cacheHits });
}

async function usageRows(projectId: string) {
  return t.db
    .select({
      month: schema.usage.month,
      queries: schema.usage.queries,
      cacheHits: schema.usage.cacheHits,
    })
    .from(schema.usage)
    .where(eq(schema.usage.projectId, projectId))
    .orderBy(schema.usage.month);
}

const thisMonth = monthStart();
const lastMonth = (() => {
  const d = new Date(`${thisMonth}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return monthStart(d);
})();

describe("monthly query quota", () => {
  it("under quota: 200, and usage.queries is incremented exactly once", async () => {
    const { project: p, plaintext } = await setup();

    const { res, json } = await query(plaintext);

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ results: [], cached: false, badge: true });
    expect(await usageRows(p.id)).toEqual([
      { month: thisMonth, queries: 1, cacheHits: 0 },
    ]);

    await query(plaintext);
    expect(await usageRows(p.id)).toEqual([
      { month: thisMonth, queries: 2, cacheHits: 0 },
    ]);
  });

  it("at quota: 429 query_quota_exceeded with Retry-After to month end; no increment", async () => {
    const { project: p, plaintext } = await setup();
    await seedUsage(p.id, thisMonth, PLAN_QUERY_LIMITS.free);

    const { res, json } = await query(plaintext);

    expect(res.status).toBe(429);
    expect(json).toMatchObject({
      error: {
        code: "query_quota_exceeded",
        doc_url: "https://docs.proofql.com/errors#query_quota_exceeded",
        message: expect.stringMatching(/50,000 uncached queries/),
      },
    });
    expect(json.error.message).toMatch(/free plan/);
    expect(json.error.message).toMatch(/upgrade/i);
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(31 * 86_400);
    expect(await usageRows(p.id)).toEqual([
      { month: thisMonth, queries: PLAN_QUERY_LIMITS.free, cacheHits: 0 },
    ]);
  });

  it("one below quota is still served (the request that reaches the limit)", async () => {
    const { project: p, plaintext } = await setup();
    await seedUsage(p.id, thisMonth, PLAN_QUERY_LIMITS.free - 1);

    expect((await query(plaintext)).res.status).toBe(200);
    expect((await query(plaintext)).res.status).toBe(429);
    expect(await usageRows(p.id)).toEqual([
      { month: thisMonth, queries: PLAN_QUERY_LIMITS.free, cacheHits: 0 },
    ]);
  });

  it("cached hits do not count: at the limit on `queries` alone, cache hits make room", async () => {
    const { project: p, plaintext } = await setup();
    // 50,000 answered, 10 of them from cache → 49,990 uncached: under.
    await seedUsage(p.id, thisMonth, PLAN_QUERY_LIMITS.free, 10);

    expect((await query(plaintext)).res.status).toBe(200);
    expect(await usageRows(p.id)).toEqual([
      { month: thisMonth, queries: PLAN_QUERY_LIMITS.free + 1, cacheHits: 10 },
    ]);
  });

  it("markCacheHit: the post-response hook counts a cache hit, leaving the enforced number alone", async () => {
    const { project: p, plaintext } = await setup();
    await seedUsage(p.id, thisMonth, 5, 2);

    const { res, json } = await query(plaintext, "/v1/query-cached");

    expect(res.status).toBe(200);
    expect(json).toEqual({ results: [], cached: true });
    // queries - cache_hits stays 3.
    expect(await usageRows(p.id)).toEqual([
      { month: thisMonth, queries: 6, cacheHits: 3 },
    ]);
  });

  it("a handler that fails is not charged", async () => {
    const { project: p, plaintext } = await setup();

    const { res, json } = await query(plaintext, "/v1/query-failing");

    expect(res.status).toBe(500);
    expect(json.error.code).toBe("internal");
    expect(await usageRows(p.id)).toEqual([]);
  });

  it("the paid plan gets the higher limit", async () => {
    const { project: p, plaintext } = await setup({ plan: "paid" });
    await seedUsage(p.id, thisMonth, PLAN_QUERY_LIMITS.free);

    expect((await query(plaintext)).res.status).toBe(200);

    await t.db
      .update(schema.usage)
      .set({ queries: PLAN_QUERY_LIMITS.paid })
      .where(eq(schema.usage.projectId, p.id));
    const { res, json } = await query(plaintext);
    expect(res.status).toBe(429);
    expect(json.error.message).toMatch(/paid plan quota of 2,000,000/);
  });

  it("month rollover: last month's exhausted row does not count; this month starts at 0", async () => {
    const { project: p, plaintext } = await setup();
    await seedUsage(p.id, lastMonth, PLAN_QUERY_LIMITS.free + 500);

    const { res } = await query(plaintext);

    expect(res.status).toBe(200);
    expect(await usageRows(p.id)).toEqual([
      { month: lastMonth, queries: PLAN_QUERY_LIMITS.free + 500, cacheHits: 0 },
      { month: thisMonth, queries: 1, cacheHits: 0 },
    ]);
  });

  it("quota is per project: another project's exhaustion is irrelevant", async () => {
    const a = await setup();
    const b = await setup();
    await seedUsage(a.project.id, thisMonth, PLAN_QUERY_LIMITS.free);

    expect((await query(a.plaintext)).res.status).toBe(429);
    expect((await query(b.plaintext)).res.status).toBe(200);
  });
});
