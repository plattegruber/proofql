/**
 * Usage against plan limits for the overview (#54). Plain functions over a
 * `Db` (like app/lib/accounts.ts) plus the pure math the panel renders
 * with, so the integration test exercises the query and the unit tests the
 * arithmetic.
 *
 * The `usage` row is the same one the api counts into (workers/api
 * src/quota.ts): `queries` is every query answered this month, `cache_hits`
 * the subset served from KV, and the number the plan limits is the
 * difference — cached hits are free on every plan.
 */
import { type PlanLimits, planFor, usageMonthStart } from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { and, eq, inArray } from "drizzle-orm";

export interface MonthUsage {
  /** Every query answered this month, cached or not. */
  queries: number;
  cacheHits: number;
  /** What the plan limits: `queries - cacheHits`. */
  uncached: number;
}

export const NO_USAGE: MonthUsage = { queries: 0, cacheHits: 0, uncached: 0 };

/** This month's counters for each of `projectIds`; absent rows are zeros. */
export async function usageForProjects(
  db: Db,
  projectIds: readonly string[],
  month: string = usageMonthStart(),
): Promise<Map<string, MonthUsage>> {
  const byProject = new Map<string, MonthUsage>();
  if (projectIds.length === 0) return byProject;
  const rows = await db
    .select({
      projectId: schema.usage.projectId,
      queries: schema.usage.queries,
      cacheHits: schema.usage.cacheHits,
    })
    .from(schema.usage)
    .where(
      and(
        inArray(schema.usage.projectId, [...projectIds]),
        eq(schema.usage.month, month),
      ),
    );
  for (const row of rows) {
    byProject.set(row.projectId, {
      queries: row.queries,
      cacheHits: row.cacheHits,
      uncached: row.queries - row.cacheHits,
    });
  }
  return byProject;
}

/** Whole-number percent of `limit` used, clamped to 0–100 (a bar width). */
export function usagePercent(used: number, limit: number): number {
  if (limit <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

export type UsageTone = "normal" | "caution" | "full";

/**
 * How loudly a meter should read: `caution` from 80 %, `full` at the limit
 * — where the api starts refusing (reviews: the next batch; queries: the
 * next uncached query).
 */
export function usageTone(used: number, limit: number): UsageTone {
  if (used >= limit) return "full";
  if (usagePercent(used, limit) >= 80) return "caution";
  return "normal";
}

/** The two limits the panel meters, for one plan. */
export function meteredLimits(
  plan: string,
): Pick<PlanLimits, "reviewsPerProject" | "queriesPerMonth"> {
  const { reviewsPerProject, queriesPerMonth } = planFor(plan);
  return { reviewsPerProject, queriesPerMonth };
}
