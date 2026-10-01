/**
 * Plan limits (scope.md §2 "Free tier"). v0 numbers; tune with data.
 *
 * Enforced at the write path: `POST /v1/reviews` rejects a batch that would
 * push `projects.review_count` past the account's limit before writing
 * anything, so a project is never left half-imported at the cap.
 */

export const PLAN_REVIEW_LIMITS = {
  free: 5_000,
  paid: 100_000,
} as const;

export type Plan = keyof typeof PLAN_REVIEW_LIMITS;

/** Reviews per project for a plan; unknown plans get the free-tier number. */
export function reviewLimitForPlan(plan: string): number {
  return (
    (PLAN_REVIEW_LIMITS as Record<string, number>)[plan] ??
    PLAN_REVIEW_LIMITS.free
  );
}
