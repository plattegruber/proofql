/**
 * Limits that are not per plan.
 *
 * `REQUEST_BODY_LIMITS` (#49, #112) are the request-body ceilings workers/api
 * enforces (request-guards.ts and the route-level `bodyLimit`s) and the docs
 * Limits page renders at build time, so the number a client reads is the
 * number the API applies.
 *
 * The rest are thin wrappers over the plan table in ./plans.ts, kept so the
 * call sites from #21/#29/#37 keep compiling. New code reads `PLANS` via
 * `planFor(plan)` directly; every plan wrapper here is deprecated.
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

/**
 * Request body ceilings, in bytes. Not product limits: they exist so one
 * malformed or hostile request cannot push megabytes into the database.
 * Over the limit is `413 payload_too_large`.
 */
export const REQUEST_BODY_LIMITS = {
  /** `POST /v1/reviews`: 100 maximal reviews fit comfortably. */
  reviews: 1024 * 1024,
  /** `PATCH /v1/reviews/{id}`: one review's editable fields. */
  reviewPatch: 64 * 1024,
  /** `GET`/`POST /v1/query`: a maximal query is well under 2 KiB. */
  query: 16 * 1024,
} as const;

export type RequestBodyLimit = keyof typeof REQUEST_BODY_LIMITS;

/**
 * Whole binary units (`16 KiB`, `1 MiB`): every limit is a power of two, and
 * the docs quote them that way. Anything else falls back to bytes.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024)} MiB`;
  }
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}

/** A row of the request-body table on the docs Limits page. */
export interface RequestBodyLimitRow {
  key: RequestBodyLimit;
  request: string;
  limit: string;
}

/** `REQUEST_BODY_LIMITS` as display rows, in the order the docs list routes. */
export function requestBodyLimitRows(): RequestBodyLimitRow[] {
  return [
    {
      key: "reviews",
      request: "POST /v1/reviews body",
      limit: formatBytes(REQUEST_BODY_LIMITS.reviews),
    },
    {
      key: "reviewPatch",
      request: "PATCH /v1/reviews/{id} body",
      limit: formatBytes(REQUEST_BODY_LIMITS.reviewPatch),
    },
    {
      key: "query",
      request: "/v1/query body",
      limit: formatBytes(REQUEST_BODY_LIMITS.query),
    },
  ];
}
