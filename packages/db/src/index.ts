// @proofql/db — Drizzle schema, client factory, and schema-level invariants
// for Postgres (pgvector + full-text search). Migrations live in
// ../migrations and are applied by scripts/migrate.ts; see README.md.

export {
  assertVerbatimSlice,
  isVerbatimSlice,
  type VerbatimSliceChunk,
  VerbatimSliceError,
  type VerbatimSliceReview,
} from "./chunks.js";
export {
  type CreateDbOptions,
  createDb,
  type Db,
  type Sql,
} from "./client.js";
export {
  dedupeLastWins,
  type IngestedReview,
  ProjectNotFoundError,
  ReviewLimitError,
  type ReviewLimitPolicy,
  type ReviewStatus,
  type UpsertReviewsParams,
  type UpsertReviewsResult,
  upsertKey,
  upsertReviews,
} from "./ingest/upsertReviews.js";
export {
  type Fused,
  fuseRanked,
  maxRrfScore,
  normalizeRrf,
  RRF_K,
  rrfContribution,
  rrfScore,
} from "./queries/fusion.js";
export {
  computeGenericTerms,
  GENERIC_TERMS_REFRESH_INTERVAL,
  type GenericTermsExecutor,
  type GenericTermsResult,
  type RefreshGenericTermsResult,
  refreshGenericTerms,
  refreshGenericTermsIfDue,
} from "./queries/genericTerms.js";
export {
  MAX_SEARCH_LIMIT,
  type SearchChunksParams,
  type SearchFilters,
  type SearchMode,
  type SearchPolicy,
  type SearchResult,
  type SearchResultReview,
  searchChunks,
} from "./queries/searchChunks.js";
export * as schema from "./schema/index.js";
export {
  type SetAccountPlanResult,
  setAccountPlan,
  syncProjectBadges,
} from "./tenancy/plan.js";
