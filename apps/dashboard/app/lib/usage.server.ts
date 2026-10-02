/**
 * This month's `usage` row per project, for the overview (#54). Plain
 * function over a `Db` (like app/lib/accounts.ts) so the integration test
 * exercises exactly what the loader calls. Server-only: `@proofql/db` pulls
 * the postgres driver, which must never reach the browser bundle.
 *
 * The row is the same one the api counts into (workers/api src/quota.ts):
 * `queries` is every query answered this month, `cache_hits` the subset
 * served from KV, and the number the plan limits is the difference —
 * cached hits are free on every plan.
 */
import { usageMonthStart } from "@proofql/core";
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
