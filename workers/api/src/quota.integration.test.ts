/**
 * The monthly query quota against the real schema, through the real
 * `GET /v1/query` route (#71; no `q`, so nothing is embedded) with the
 * Map-backed fake KV as the query cache (#28), so the "cached hits are
 * free" rule is exercised on the real HIT path. One stub route mounted the
 * same way (auth, `queryQuota`, handler) throws so the "errors are not
 * charged" rule is pinned.
 */

import { PLAN_QUERY_LIMITS } from "@proofql/core";
import { schema } from "@proofql/db";
import { account, project, setupTestDb } from "@proofql/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { fakeCtx, fakeKv, issueKey, testEnv } from "../test/helpers.js";
import { createApp } from "./app.js";
import { requireAnyKey } from "./auth.js";
import { monthStart, queryQuota } from "./quota.js";

const t = setupTestDb();

/** Shared across tests: entries are keyed per project, so they never collide. */
const kv = fakeKv();
const env = testEnv({ kv });

function app() {
  const a = createApp({
    db: t.db,
    rateLimiter: { limit: async () => ({ success: true }) },
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
    ctx.asExecutionContext(),
  );
  await ctx.flush();
  // biome-ignore lint/suspicious/noExplicitAny: reads both shapes
  const json = (await res.json()) as any;
  return { res, json, cache: res.headers.get("x-cache") };
}

async function setup(opts: { plan?: "free" | "paid" } = {}) {
  const acct = await account(t.db, { plan: opts.plan ?? "free" });
  const p = await project(t.db, {
    accountId: acct.id,
    allowedOrigins: [ORIGIN],
  });
  const { plaintext } = await issueKey(t.db, p.id, "publishable");
  return { project: p, plaintext };
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

    const { res, json, cache } = await query(plaintext);

    expect(res.status).toBe(200);
    expect(cache).toBe("MISS");
    expect(json).toMatchObject({ results: [], cached: false, badge: true });
    expect(await usageRows(p.id)).toEqual([
      { month: thisMonth, queries: 1, cacheHits: 0 },
    ]);

    // A different request (limit) is another uncached query.
    await query(plaintext, "/v1/query?limit=2");
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
    expect((await query(plaintext, "/v1/query?limit=2")).res.status).toBe(429);
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

  it("a KV hit is counted under cache_hits, leaving the enforced number alone", async () => {
    const { project: p, plaintext } = await setup();
    await seedUsage(p.id, thisMonth, 5, 2);

    const miss = await query(plaintext);
    expect(miss.cache).toBe("MISS");
    expect(await usageRows(p.id)).toEqual([
      { month: thisMonth, queries: 6, cacheHits: 2 },
    ]);

    const hit = await query(plaintext);
    expect(hit.res.status).toBe(200);
    expect(hit.cache).toBe("HIT");
    expect(hit.json).toMatchObject({ results: [], cached: true });
    // queries - cache_hits stays 4.
    expect(await usageRows(p.id)).toEqual([
      { month: thisMonth, queries: 7, cacheHits: 3 },
    ]);
  });

  it("at quota: a cached answer is still served (and counted free); an uncached one is refused", async () => {
    const { project: p, plaintext } = await setup();
    // Populate the cache while under quota, then exhaust the quota.
    expect((await query(plaintext)).cache).toBe("MISS");
    await t.db
      .update(schema.usage)
      .set({ queries: PLAN_QUERY_LIMITS.free, cacheHits: 0 })
      .where(eq(schema.usage.projectId, p.id));

    const hit = await query(plaintext);
    expect(hit.res.status).toBe(200);
    expect(hit.cache).toBe("HIT");
    expect(hit.json.cached).toBe(true);
    expect(await usageRows(p.id)).toEqual([
      { month: thisMonth, queries: PLAN_QUERY_LIMITS.free + 1, cacheHits: 1 },
    ]);

    const miss = await query(plaintext, "/v1/query?limit=2");
    expect(miss.res.status).toBe(429);
    expect(miss.json.error.code).toBe("query_quota_exceeded");
    expect(miss.cache).toBeNull();
    expect(await usageRows(p.id)).toEqual([
      { month: thisMonth, queries: PLAN_QUERY_LIMITS.free + 1, cacheHits: 1 },
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
    const { res, json } = await query(plaintext, "/v1/query?limit=2");
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
