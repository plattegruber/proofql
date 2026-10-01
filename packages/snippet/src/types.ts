/**
 * The `GET /v1/query` response as the snippet reads it — a structural copy of
 * `QueryResponse` in workers/api/src/query/route.ts. Duplicated on purpose:
 * the snippet has zero dependencies and the shape is the public contract
 * (scope.md §3 "Query"), so any drift is a contract change, not a refactor.
 */

export interface QueryReview {
  id: string;
  rating: number | null;
  author_name: string | null;
  author_avatar_url: string | null;
  source: string;
  /** ISO 8601, or null when the source carried no date. */
  occurred_at: string | null;
  url: string | null;
  metadata: Record<string, string>;
  /** Whole review text; present in `mode=reviews` only. */
  text?: string;
}

export interface QueryResult {
  score: number | null;
  excerpt: string;
  excerpt_id: string;
  review: QueryReview;
}

export interface QueryResponse {
  results: QueryResult[];
  took_ms: number;
  cached: boolean;
  /** Whether the snippet must render the "Reviews by ProofQL" badge. */
  badge: boolean;
}

/** What one `[data-proofql]` element asked for (`./query.ts`). */
export type QueryMode = "excerpts" | "reviews";

declare global {
  /** Injected by esbuild `define` at build time (scripts/build.mjs). */
  const __VERSION__: string;
}
