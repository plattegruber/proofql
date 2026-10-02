/**
 * Plan limits — thin wrappers over the plan table in ./plans.ts, kept so
 * the call sites from #21/#29/#37 keep compiling. New code reads `PLANS`
 * via `planFor(plan)` directly; everything exported here is deprecated.
 *
 * Reviews are enforced at the write path: `POST /v1/reviews` rejects a batch
 * that would push `projects.review_count` past the account's limit before
 * writing anything, so a project is never left half-imported at the cap.
 *
 * Queries are enforced per calendar month (UTC) at `/v1/query` from the
 * `usage` table: the number compared against the limit is uncached queries
 * (`queries - cache_hits`), because cached hits are free on every plan.
 */

import { PLANS, type Plan, planFor } from "./plans.js";

export type { Plan };

/** @deprecated Read `PLANS[plan].reviewsPerProject` via `planFor`. */
export const PLAN_REVIEW_LIMITS: Readonly<Record<Plan, number>> = {
  free: PLANS.free.reviewsPerProject,
  paid: PLANS.paid.reviewsPerProject,
};

/** @deprecated Read `PLANS[plan].queriesPerMonth` via `planFor`. */
export const PLAN_QUERY_LIMITS: Readonly<Record<Plan, number>> = {
  free: PLANS.free.queriesPerMonth,
  paid: PLANS.paid.queriesPerMonth,
};

/** @deprecated Read `PLANS[plan].projects` via `planFor`. */
export const PLAN_PROJECT_LIMITS: Readonly<Record<Plan, number>> = {
  free: PLANS.free.projects,
  paid: PLANS.paid.projects,
};

/**
 * Reviews per project for a plan; unknown plans get the free-tier number.
 * @deprecated Use `planFor(plan).reviewsPerProject`.
 */
export function reviewLimitForPlan(plan: string): number {
  return planFor(plan).reviewsPerProject;
}

/**
 * Uncached queries per project per month; unknown plans get the free number.
 * @deprecated Use `planFor(plan).queriesPerMonth`.
 */
export function queryLimitForPlan(plan: string): number {
  return planFor(plan).queriesPerMonth;
}

/**
 * Projects per account for a plan; unknown plans get the free-tier number.
 * @deprecated Use `planFor(plan).projects`.
 */
export function projectLimitForPlan(plan: string): number {
  return planFor(plan).projects;
}
