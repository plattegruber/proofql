/**
 * Monthly query quota (scope.md §2 "Free tier": 50,000 queries / month,
 * cached hits are free; issue #29).
 *
 * Two halves, both used by `/v1/query` only:
 *
 *   - `enforceQueryQuota(c)` — the handler calls it **after** a cache miss
 *     and before any uncached work. The plan arrived with the key
 *     (`auth.plan`, src/auth.ts), so the only read is this month's `usage`
 *     row (`month` = first day of the UTC month). The enforced number is
 *     `queries - cache_hits`, as the `usage` schema documents: `queries`
 *     counts every query answered, `cache_hits` the subset served from KV,
 *     which no plan charges for. At or over the plan's limit → 429
 *     `query_quota_exceeded` (distinct from `rate_limited`: "wait for the
 *     month or upgrade", not "slow down") with `Retry-After` set to the
 *     seconds until the next month. The snippet renders nothing on any
 *     error, so an over-quota site degrades to an empty widget, never a
 *     broken page.
 *   - `queryQuota` — route-level middleware mounted after auth. Once the
 *     handler has produced a 2xx it hands the request to the app's
 *     `UsageBuffer` (src/usage-buffer.ts, #108), which accumulates per
 *     `(project, month)` and writes every few seconds with `recordUsage`:
 *     `INSERT ... ON CONFLICT (project_id, month) DO UPDATE SET queries =
 *     usage.queries + excluded.queries` — an atomic increment, never a
 *     read-modify-write, so concurrent isolates cannot lose counts. A
 *     handler that called `markCacheHit(c)` is counted under `cache_hits`
 *     too, so the hit shows in the dashboard total but not in the enforced
 *     number. Errors (422, 429, 503) are not charged. The buffer is why a
 *     cache HIT opens no database connection: the write is no longer per
 *     request, and it rides a client of its own, not the request's.
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
 * by the in-flight requests plus whatever each isolate's buffer has not
 * flushed yet (at most one `USAGE_FLUSH_MS` window); the limit is a plan
 * ceiling, not a billing invariant, and the overshoot is bounded by
 * concurrency and the flush window.
 */

import {
  PRICING_URL,
  planFor,
  secondsToMonthEnd,
  usageMonthStart,
} from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { and, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { AppEnv } from "./bindings.js";
import { ApiError } from "./errors.js";
import { logFor } from "./request-id.js";
import type { UsageDelta } from "./usage-buffer.js";

/** `YYYY-MM-01` for the UTC month containing `now` — the `usage.month` key. */
export const monthStart = usageMonthStart;
export { secondsToMonthEnd };

export interface UsageCounters {
  /** Every query answered this month, cached or not. */
  queries: number;
  cacheHits: number;
}

export interface QuotaStatus extends UsageCounters {
  plan: string;
  limit: number;
  /** What the limit applies to: `queries - cacheHits`. */
  uncached: number;
}

/** This month's counters for a project; zeros before its first query. */
export async function readUsage(
  db: Db,
  projectId: string,
  month: string,
): Promise<UsageCounters> {
  const { usage } = schema;
  const [row] = await db
    .select({
      queries: sql<number>`coalesce(${usage.queries}, 0)`.mapWith(Number),
      cacheHits: sql<number>`coalesce(${usage.cacheHits}, 0)`.mapWith(Number),
    })
    .from(usage)
    .where(and(eq(usage.projectId, projectId), eq(usage.month, month)))
    .limit(1);
  return row ?? { queries: 0, cacheHits: 0 };
}

/** Where a project stands against its plan's monthly limit. */
export async function readQuota(
  db: Db,
  projectId: string,
  plan: string,
  month: string,
): Promise<QuotaStatus> {
  const counters = await readUsage(db, projectId, month);
  return {
    ...counters,
    plan,
    limit: planFor(plan).queriesPerMonth,
    uncached: counters.queries - counters.cacheHits,
  };
}

/**
 * Atomic `+delta` on `queries` and `cache_hits` for every `(project, month)`
 * in `deltas`, in one statement (the `UsageBuffer`'s writer). `excluded` is
 * the row that failed to insert, i.e. this batch's delta for that key.
 */
export async function recordUsage(
  db: Db,
  deltas: readonly UsageDelta[],
): Promise<void> {
  if (deltas.length === 0) return;
  const { usage } = schema;
  await db
    .insert(usage)
    .values(
      deltas.map((d) => ({
        projectId: d.projectId,
        month: d.month,
        queries: d.queries,
        cacheHits: d.cacheHits,
      })),
    )
    .onConflictDoUpdate({
      target: [usage.projectId, usage.month],
      set: {
        queries: sql`${usage.queries} + excluded.queries`,
        cacheHits: sql`${usage.cacheHits} + excluded.cache_hits`,
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
    auth.plan,
    monthStart(now),
  );
  if (quota.uncached < quota.limit) return;
  const retryAfter = secondsToMonthEnd(now);
  c.header("Retry-After", String(retryAfter));
  // docs/observability.md `quota.rejected`: the plan ceiling and where the
  // project stands against it, so "who is at quota" is one filter.
  logFor(c).log("quota.rejected", {
    level: "warn",
    project_id: auth.projectId,
    key_environment: auth.environment,
    key_kind: auth.kind,
    plan: quota.plan,
    limit: quota.limit,
    uncached: quota.uncached,
    queries: quota.queries,
    cache_hits: quota.cacheHits,
    retry_after: retryAfter,
  });
  throw new ApiError(
    "query_quota_exceeded",
    `This project has used its ${quota.plan} plan quota of ${quota.limit.toLocaleString("en-US")} uncached queries for the month (cached queries are free). The quota resets at the start of next month (UTC); upgrade at ${PRICING_URL} to raise it.`,
  );
}

/** `/v1/query` only, after auth: count every answered query afterwards. */
export const queryQuota = createMiddleware<AppEnv>(async (c, next) => {
  const auth = c.get("auth");
  const month = monthStart();

  await next();

  // Charge only answered queries: a thrown ApiError never reaches here, and
  // a handler that returned an error envelope itself is not charged either.
  // No database here: the buffer writes on its own schedule and client.
  if (c.res.ok) {
    c.get("usage").record(c, auth.projectId, month, c.get("cacheHit") === true);
  }
});
