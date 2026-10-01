/**
 * Plan limits (scope.md §2 "Free tier"). v0 numbers; tune with data.
 *
 * Reviews are enforced at the write path: `POST /v1/reviews` rejects a batch
 * that would push `projects.review_count` past the account's limit before
 * writing anything, so a project is never left half-imported at the cap.
 *
 * Queries are enforced per calendar month (UTC) at `/v1/query` from the
 * `usage` table: the number compared against the limit is uncached queries
 * (`queries - cache_hits`), because cached hits are free on every plan.
 * The paid number is a placeholder for "metered" until billing lands (M3).
 */

export const PLAN_REVIEW_LIMITS = {
  free: 5_000,
  paid: 100_000,
} as const;

export const PLAN_QUERY_LIMITS = {
  free: 50_000,
  paid: 2_000_000,
} as const satisfies Record<Plan, number>;

/**
 * Projects per account (scope.md §2: free = 1, paid = "many"). Enforced by
 * the dashboard's create-project action (#37); the paid number is a cap
 * against runaway scripts, not a product limit.
 */
export const PLAN_PROJECT_LIMITS = {
  free: 1,
  paid: 50,
} as const satisfies Record<Plan, number>;

export type Plan = keyof typeof PLAN_REVIEW_LIMITS;

/** Reviews per project for a plan; unknown plans get the free-tier number. */
export function reviewLimitForPlan(plan: string): number {
  return limitFor(PLAN_REVIEW_LIMITS, plan);
}

/** Uncached queries per project per month; unknown plans get the free number. */
export function queryLimitForPlan(plan: string): number {
  return limitFor(PLAN_QUERY_LIMITS, plan);
}

/** Projects per account for a plan; unknown plans get the free-tier number. */
export function projectLimitForPlan(plan: string): number {
  return limitFor(PLAN_PROJECT_LIMITS, plan);
}

/**
 * `hasOwn`, not a bare index: `plan` comes from a database enum today, but
 * a string like "toString" must still resolve to the free number rather
 * than an inherited property.
 */
function limitFor(table: Record<Plan, number>, plan: string): number {
  return Object.hasOwn(table, plan) ? table[plan as Plan] : table.free;
}
