/**
 * Monthly query quota (scope.md §2 "Free tier": 50,000 queries / month,
 * cached hits are free; issue #29).
 *
 * Two halves, both used by `/v1/query` only:
 *
 *   - `enforceQueryQuota(c)` — the handler calls it **after** a cache miss
 *     and before any uncached work. One statement joins `projects` →
 *     `accounts` for the plan and LEFT JOINs this month's `usage` row
 *     (`month` = first day of the UTC month). The enforced number is
 *     `queries - cache_hits`, as the `usage` schema documents: `queries`
 *     counts every query answered, `cache_hits` the subset served from KV,
 *     which no plan charges for. At or over the plan's limit → 429
 *     `query_quota_exceeded` (distinct from `rate_limited`: "wait for the
 *     month or upgrade", not "slow down") with `Retry-After` set to the
 *     seconds until the next month. The snippet renders nothing on any
 *     error, so an over-quota site degrades to an empty widget, never a
 *     broken page.
 *   - `queryQuota` — route-level middleware mounted after auth. Once the
 *     handler has produced a 2xx it bumps the counters after the response
 *     via `waitUntil`, with `INSERT ... ON CONFLICT (project_id, month) DO
 *     UPDATE SET queries = usage.queries + 1` — an atomic increment, never
 *     a read-modify-write, so concurrent requests cannot lose counts. A
 *     handler that called `markCacheHit(c)` is counted under `cache_hits`
 *     too, so the hit shows in the dashboard total but not in the enforced
 *     number. Errors (422, 429, 503) are not charged.
 *
 * Why the check is a call rather than middleware ahead of the handler: the
 * cache lookup (src/query/cache.ts) must come first, so that a cached
 * answer — free by definition — is served at quota rather than refused,
 * and so that a hit costs no `usage` read at all. Only the miss path pays
 * for the check, immediately before it pays for the search.
 *
 * Usage is per project, not per environment or key: a test key shares its
 * project's quota (packages/db/src/schema/usage.ts). The check reads the
 * counter as of the request start, so a burst at the boundary can overshoot
 * by the in-flight requests; the limit is a plan ceiling, not a billing
 * invariant, and the overshoot is bounded by concurrency.
 */

import { queryLimitForPlan } from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { and, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { AppEnv } from "./bindings.js";
import { waitUntil } from "./db.js";
import { ApiError } from "./errors.js";

/** `YYYY-MM-01` for the UTC month containing `now` — the `usage.month` key. */
export function monthStart(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

/** Whole seconds from `now` until the first instant of next UTC month. */
export function secondsToMonthEnd(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export interface QuotaStatus {
  plan: string;
  limit: number;
  /** Every query answered this month, cached or not. */
  queries: number;
  cacheHits: number;
  /** What the limit applies to: `queries - cacheHits`. */
  uncached: number;
}

/** Plan and this month's counters for a project, in one round-trip. */
export async function readQuota(
  db: Db,
  projectId: string,
  month: string,
): Promise<QuotaStatus> {
  const { projects, accounts, usage } = schema;
  const [row] = await db
    .select({
      plan: accounts.plan,
      queries: sql<number>`coalesce(${usage.queries}, 0)`.mapWith(Number),
      cacheHits: sql<number>`coalesce(${usage.cacheHits}, 0)`.mapWith(Number),
    })
    .from(projects)
    .innerJoin(accounts, eq(accounts.id, projects.accountId))
    .leftJoin(
      usage,
      and(eq(usage.projectId, projects.id), eq(usage.month, month)),
    )
    .where(eq(projects.id, projectId))
    .limit(1);
  if (row === undefined) {
    // The key resolved a moment ago; the project vanished underneath it.
    throw new ApiError("unauthorized", "Unknown or revoked API key.");
  }
  return {
    plan: row.plan,
    limit: queryLimitForPlan(row.plan),
    queries: row.queries,
    cacheHits: row.cacheHits,
    uncached: row.queries - row.cacheHits,
  };
}

/** Atomic `+1` on `queries`, and on `cache_hits` too for a cached answer. */
export function recordQuery(
  db: Db,
  projectId: string,
  month: string,
  cacheHit: boolean,
): Promise<unknown> {
  const { usage } = schema;
  const hit = cacheHit ? 1 : 0;
  return db
    .insert(usage)
    .values({ projectId, month, queries: 1, cacheHits: hit })
    .onConflictDoUpdate({
      target: [usage.projectId, usage.month],
      set: {
        queries: sql`${usage.queries} + 1`,
        cacheHits: sql`${usage.cacheHits} + ${hit}`,
      },
    });
}

/**
 * Call from a `/v1/query` handler that answered from the cache, before
 * returning. The post-response hook then counts the request as a cache hit
 * (free) instead of an uncached query.
 */
export function markCacheHit(c: Context<AppEnv>): void {
  c.set("cacheHit", true);
}

/**
 * Refuse with 429 `query_quota_exceeded` when the project is at its plan's
 * monthly limit of uncached queries. The `/v1/query` handler calls this on
 * a cache miss, before embedding and searching (module doc).
 */
export async function enforceQueryQuota(c: Context<AppEnv>): Promise<void> {
  const auth = c.get("auth");
  const now = new Date();
  const quota = await readQuota(
    c.get("getDb")(),
    auth.projectId,
    monthStart(now),
  );
  if (quota.uncached < quota.limit) return;
  c.header("Retry-After", String(secondsToMonthEnd(now)));
  throw new ApiError(
    "query_quota_exceeded",
    `This project has used its ${quota.plan} plan quota of ${quota.limit.toLocaleString("en-US")} uncached queries for the month (cached queries are free). The quota resets at the start of next month (UTC); upgrade the account's plan in the dashboard to raise it.`,
  );
}

/** `/v1/query` only, after auth: count every answered query afterwards. */
export const queryQuota = createMiddleware<AppEnv>(async (c, next) => {
  const auth = c.get("auth");
  const db = c.get("getDb")();
  const month = monthStart();

  await next();

  // Charge only answered queries: a thrown ApiError never reaches here, and
  // a handler that returned an error envelope itself is not charged either.
  if (c.res.ok) {
    waitUntil(
      c,
      recordQuery(db, auth.projectId, month, c.get("cacheHit") === true),
    );
  }
});
