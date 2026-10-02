/**
 * The pure math behind the overview's usage meters (#54): percent of a
 * limit, how loudly to show it, and which PLANS numbers are metered. No
 * database here — this file is imported by components and so reaches the
 * browser bundle; the `usage` query lives in usage.server.ts.
 */
import { type PlanLimits, planFor } from "@proofql/core";

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
