/**
 * `searchChunks` — exact per-tenant hybrid search with the publication
 * policy in the same statement (#16; scope.md §2 "Vector search", §3
 * "Query").
 *
 * One SQL statement does all of it: restrict `review_chunks` to
 * `(project_id, environment)` through the btree index, join `reviews`
 * **on the same tenant predicate** (so the join side is an index scan too,
 * never a scan of every tenant's reviews — #111, `tenant()` below),
 * apply the publication policy and the caller's filters, rank the
 * survivors by exact cosine similarity and by full-text rank, fuse the two
 * rankings with Reciprocal Rank Fusion (k = 60, `./fusion.ts`), keep the
 * best chunk per review, and return the top `limit`. Nothing is
 * post-filtered in JavaScript: a hidden or one-star review can never reach
 * the ranking, so it can never crowd out a publishable one.
 *
 * ## Why there is no vector index
 *
 * There is no HNSW or IVFFlat index on `review_chunks.embedding`, on
 * purpose (scope.md §2). Tenants are small and numerous: a business with
 * 2,000 reviews has maybe 4,000 vectors, and an exact scan over that many
 * half-precision vectors is single-digit milliseconds and always correct.
 * A global approximate index with a tenant post-filter is the classic
 * multi-tenant pgvector failure mode — the index returns its k nearest
 * neighbors across *all* tenants, the filter then throws most of them
 * away, and a small tenant gets starved, wrong results. Exact scan has no
 * recall knob to get wrong and no index to keep in sync.
 *
 * Measured locally with `scripts/bench-search.ts` (Postgres 16,
 * `pgvector/pgvector:pg16` in Docker Desktop on an Apple-silicon laptop;
 * two tenants of 2,500 reviews / 5,000 embedded chunks each, so the tenant
 * filter is doing real work; hybrid query with both branches, limit 5,
 * timed end to end from Node, 39 warm runs): **exact scan over 5,000
 * chunks: 12.4 ms median, 13.1 ms p95**, 14.1 ms cold; vector-only
 * 10.1 ms. `EXPLAIN ANALYZE` puts server-side execution at 11.9 ms, both
 * branches starting from a bitmap scan on
 * `review_chunks_project_id_environment_idx`. On the 21-tenant load
 * database (`pnpm load:seed`) a 2,000-chunk tenant is 7.4 ms median (was
 * 18.3 ms before the `reviews` join carried the tenant predicate, #111),
 * and no-query recency mode is 1.0 ms (was 8.2 ms before the recency index,
 * #117). The #16 target is under 20 ms; the hybrid statement crosses it
 * between 7,500 and 10,000 chunks (`docs/performance.md` §2).
 *
 * **Revisit when a single tenant exceeds ~50k vectors.** The fix at that
 * point is a partial HNSW index for that tenant (`WHERE project_id = …`)
 * or partitioning `review_chunks` by project — never a global index. The
 * statement below needs no change for either: the tenant predicate stays
 * the first thing the planner sees.
 *
 * ## Ranking
 *
 * - **Vector branch.** `1 - (embedding <=> $query::halfvec(1024))` is
 *   cosine similarity. Only chunks with a non-null embedding take part.
 * - **The floor has two tiers** (#138). A chunk survives when its
 *   similarity clears `policy.similarityFloor`, or when it clears the
 *   lower *lexical floor* (`lexicalFloorFor(similarityFloor)` from
 *   `@proofql/core`, the floor minus 0.13) **and** it matches the query's
 *   words: at least half of the query's content words that are not
 *   generic for the project's category (`policy.category`,
 *   `genericQueryWords` in `@proofql/core`, #151) are in the chunk, or the
 *   text branch
 *   matched it outright (`./lexicalMatch.ts`, rule `half-specific`, #147).
 *   So "dental implants" passes on an implant review that never says
 *   "dental". Everything else is dropped before the collapse, so a chunk that
 *   is not semantically close never comes back however well its words
 *   match ("empty beats irrelevant"; scope.md §3), and a short keyword
 *   query that literally matches a review is not blanked by a floor tuned
 *   for paraphrases. The vector branch keeps chunks down to the lexical
 *   floor (only when there is query text; otherwise the tier is inert and
 *   the branch stops at the floor), and the fused step applies the rule.
 * - **Text branch.** `ts_rank_cd(tsv, websearch_to_tsquery('english', $q))`
 *   over the same policy-filtered set, ranked over every chunk that matches
 *   the query (`tsv @@ q`). Skipped when no `queryText` is given.
 * - **Fusion.** Each chunk's raw score is `Σ 1 / (60 + rank)` over the
 *   branches it appears in. Ties at every step break on
 *   `occurred_at DESC NULLS LAST`, then the narrower chunk (`sentence` <
 *   `window` < `full`, `breadth` below), then `id`, so the same data
 *   always yields the same order — and at an exact tie, the tighter quote.
 * - **Collapse.** Both modes return at most one row per review — the
 *   chunk with the best fused score (on an exact RRF tie, e.g. a review's
 *   `full` chunk and one of its windows swapping ranks 1 and 2 across the
 *   branches, the semantically closer chunk wins; at equal similarity too,
 *   the narrower one). The two modes exist so
 *   the caller's intent is explicit and so an `excerpts` override (several
 *   excerpts from one review, scope.md §8) has a home; today they share
 *   the shape and the API layer decides whether to render `excerpt` or
 *   `review.text`.
 *
 * `score` is the fused rank normalized to [0, 1] — see `normalizeRrf` in
 * `./fusion.ts`: raw RRF divided by the best possible score given the
 * number of active branches, so a chunk ranked first by both vector and
 * text scores exactly 1, one ranked first by vector alone (no
 * `queryText`) also scores 1, and one that only the text branch liked
 * scores at most 0.5. It is a *rank*, comparable within one result set.
 * `similarity` is the raw cosine similarity, comparable across queries and
 * the number the floor is applied to; the API contract exposes that one as
 * its `score`.
 *
 * ## Debug: `includeBelowFloor`
 *
 * The dashboard's query playground (#40) needs to show *why* a query came
 * back thin: which candidates the floor dropped. With
 * `includeBelowFloor: true` the vector branch keeps every embedded
 * candidate and each result carries `belowFloor` (the two-tier rule above
 * says drop) and `lexical` (it matches the query's words). The above-floor
 * rows are **exactly** the default result — same rows, same order, same
 * `score` — because every surviving chunk clears the lexical floor, the
 * rows the default statement leaves out of the vector branch sort after
 * all of them (so their vector ranks are unchanged), the text branch never
 * looked at the floor,
 * and the per-review collapse runs separately inside each group. The
 * below-floor group is the next `limit` reviews by fused rank that have
 * no above-floor chunk, in rank order after the above-floor group. The
 * default statement is untouched by the option: only the debug variant
 * pays for the wider scan.
 *
 * ## No query
 *
 * Without `queryEmbedding` the result is the newest publishable reviews
 * (`occurred_at DESC NULLS LAST, id`), same policy and filters, with the
 * review's `full` chunk as the excerpt and `similarity`/`score` null.
 */

import {
  genericQueryWords,
  LEXICAL_RULE,
  lexicalFloorFor,
} from "@proofql/core";
import { type SQL, sql } from "drizzle-orm";

import type { Db } from "../client.js";
import { EMBEDDING_DIMENSIONS } from "../schema/reviewChunks.js";
import type { ReviewMetadata } from "../schema/reviews.js";
import type { Environment } from "../schema/shared.js";
import { normalizeRrf, RRF_K } from "./fusion.js";
import { lexicalMatchSql } from "./lexicalMatch.js";

/** Upper bound on `limit`; the API contract's maximum page. */
export const MAX_SEARCH_LIMIT = 20;

export type SearchMode = "excerpts" | "reviews";

export interface SearchPolicy {
  /** Reviews rated below this never return; `projects.min_rating`. */
  minRating: number;
  /**
   * Cosine-similarity floor; `projects.similarity_floor`. A chunk the text
   * branch matched passes at the lower `lexicalFloorFor(similarityFloor)`
   * (module doc). Ignored in no-query mode.
   */
  similarityFloor: number;
  /**
   * The project's business category (`projects.category`, #151): picks the
   * generic words the partial word match ignores (`genericQueryWords`).
   * Null, absent, or a key this build does not know: the universal words
   * only.
   */
  category?: string | null | undefined;
}

export interface SearchFilters {
  /** Keep reviews whose `source` is one of these. Empty or absent: all. */
  source?: string[] | undefined;
  /** Keep reviews with `occurred_at >= since`. Reviews without a date drop. */
  since?: Date | undefined;
  /** Keep reviews whose `metadata` contains every key/value pair (`@>`). */
  metadata?: Record<string, string> | undefined;
}

export interface SearchChunksParams {
  projectId: string;
  environment: Environment;
  /**
   * bge-m3 query embedding (1024 dimensions). Absent: no-query mode —
   * newest publishable reviews.
   */
  queryEmbedding?: number[] | undefined;
  /**
   * The user's query text, for the full-text branch. Only meaningful with
   * `queryEmbedding` (text-only hits cannot clear the similarity floor).
   * Empty or whitespace: vector-only.
   */
  queryText?: string | undefined;
  /** Rows to return, 1–{@link MAX_SEARCH_LIMIT}. */
  limit: number;
  policy: SearchPolicy;
  filters?: SearchFilters | undefined;
  mode: SearchMode;
  /**
   * Debug variant (module doc): also return the candidates that fell below
   * `policy.similarityFloor`, flagged `belowFloor: true`, after the normal
   * results. Default false. Ignored in no-query mode (nothing is floored).
   */
  includeBelowFloor?: boolean | undefined;
}

export interface SearchResultReview {
  rating: number | null;
  authorName: string | null;
  authorAvatarUrl: string | null;
  source: string;
  occurredAt: Date | null;
  url: string | null;
  metadata: ReviewMetadata;
  /** The whole review, for `mode: "reviews"` rendering. */
  text: string;
}

export interface SearchResult {
  reviewId: string;
  chunkId: string;
  /** Verbatim slice of `review.text` (the best chunk; the `full` chunk in no-query mode). */
  excerpt: string;
  /** UTF-16 offset of `excerpt` within `review.text`. */
  startOffset: number;
  /** Cosine similarity of the chunk to the query; null in no-query mode. */
  similarity: number | null;
  /** Fused rank normalized to [0, 1] (module doc); null in no-query mode. */
  score: number | null;
  /**
   * True only with `includeBelowFloor`, for a candidate the floor would
   * have dropped. Always false for the rows the default search returns.
   */
  belowFloor: boolean;
  /**
   * The chunk matches the query's words (`./lexicalMatch.ts`, at least half
   * of the specific content words, or every term), so it was held to the
   * lexical floor rather than the floor. False in no-query mode and
   * without text.
   */
  lexical: boolean;
  review: SearchResultReview;
}

/** The row shape every statement in this module produces. */
type Row = {
  chunk_id: string;
  review_id: string;
  excerpt: string;
  start_offset: number;
  similarity: number | null;
  rrf: number | null;
  below_floor: boolean;
  lexical: boolean;
  rating: number | null;
  author_name: string | null;
  author_avatar_url: string | null;
  source: string;
  /** ISO 8601 text (via `to_json`); drizzle's raw path returns timestamps unparsed. */
  occurred_at: string | null;
  url: string | null;
  metadata: ReviewMetadata;
  review_text: string;
};

export async function searchChunks(
  db: Db,
  params: SearchChunksParams,
): Promise<SearchResult[]> {
  const rows = await db.execute<Row>(searchChunksSql(params));
  const activeLists = hasQueryText(params) ? 2 : 1;
  return rows.map((row) => toResult(row, activeLists));
}

/**
 * The statement `searchChunks` runs, for `EXPLAIN` and the benchmark
 * (`scripts/bench-search.ts`). Validates `params` the same way.
 */
export function searchChunksSql(params: SearchChunksParams): SQL {
  validate(params);
  if (!params.queryEmbedding) return recencyStatement(params);
  return hybridStatement(
    params,
    params.queryEmbedding,
    hasQueryText(params) ? (params.queryText?.trim() ?? null) : null,
  );
}

function hasQueryText(params: SearchChunksParams): boolean {
  return (params.queryText?.trim().length ?? 0) > 0;
}

function validate(params: SearchChunksParams): void {
  if (
    !Number.isInteger(params.limit) ||
    params.limit < 1 ||
    params.limit > MAX_SEARCH_LIMIT
  ) {
    throw new RangeError(
      `searchChunks: limit must be an integer in 1..${MAX_SEARCH_LIMIT}, got ${params.limit}`,
    );
  }
  if (
    params.queryEmbedding !== undefined &&
    params.queryEmbedding.length !== EMBEDDING_DIMENSIONS
  ) {
    throw new RangeError(
      `searchChunks: queryEmbedding must have ${EMBEDDING_DIMENSIONS} dimensions, got ${params.queryEmbedding.length}`,
    );
  }
  if (
    params.queryEmbedding === undefined &&
    (params.queryText?.trim().length ?? 0) > 0
  ) {
    throw new RangeError(
      "searchChunks: queryText requires queryEmbedding — text-only hits have no vector similarity for the floor to apply to",
    );
  }
}

/**
 * The publication policy plus the caller's filters as one predicate over
 * `reviews r`. Shared by both statements so the two modes can never
 * disagree about what is publishable.
 */
function publishable(params: SearchChunksParams): SQL {
  const { policy, filters } = params;
  const clauses: SQL[] = [
    sql`r.hidden_at IS NULL`,
    // Rated reviews must clear min_rating; unrated ones must not be
    // classified negative (a still-unclassified NULL passes).
    sql`CASE WHEN r.rating IS NULL
          THEN r.sentiment IS DISTINCT FROM 'negative'::sentiment
          ELSE r.rating >= ${policy.minRating}
        END`,
  ];
  if (filters?.source && filters.source.length > 0) {
    clauses.push(
      sql`r.source IN (${sql.join(
        filters.source.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  }
  if (filters?.since) {
    // ISO text + cast: drizzle's raw `execute` path hands parameters to
    // postgres-js unserialized, and a Date is not a wire value.
    clauses.push(
      sql`r.occurred_at >= ${filters.since.toISOString()}::timestamptz`,
    );
  }
  if (filters?.metadata && Object.keys(filters.metadata).length > 0) {
    clauses.push(sql`r.metadata @> ${JSON.stringify(filters.metadata)}::jsonb`);
  }
  return sql.join(clauses, sql` AND `);
}

/**
 * `reviews r` is the caller's tenant. Semantically redundant on every
 * join below — a chunk's review is always in the chunk's project and
 * environment, the FK and the denormalized columns guarantee it — but the
 * planner cannot know that. Without it, `candidates` joined `reviews` on
 * `id` alone and Postgres seq-scanned and hashed **every publishable review
 * in the table** to serve one tenant: 30,058 rows for a tenant with 1,000
 * of them on the 21-tenant load database, 14.7 → 3.9 ms median (#111,
 * `docs/performance.md` §2). With the predicate the join starts from a
 * tenant-prefixed btree (`reviews_project_id_environment_occurred_at_idx`,
 * or the upsert key's unique index — same prefix) and the cost scales with
 * the tenant, not the table — the same property the exact scan over
 * `review_chunks` already had.
 */
function tenant(params: SearchChunksParams): SQL {
  return sql`r.project_id = ${params.projectId} AND r.environment = ${params.environment}`;
}

/** The `reviews r` columns every result carries. */
const reviewColumns = sql`
  r.rating,
  r.author_name,
  r.author_avatar_url,
  r.source,
  to_json(r.occurred_at) AS occurred_at,
  r.url,
  r.metadata,
  r.text AS review_text`;

/**
 * How much of its review a chunk covers, as a sort key: `sentence` (0) <
 * `window` (1) < `full` (2). The tie-break before `id` in every ranking of
 * the hybrid statement, so that at an equal score the narrower chunk —
 * the one that quotes exactly what answered — wins, deterministically.
 *
 * Without it, ties fell through to `id`, a random uuid. That is not a
 * corner case: `ts_rank_cd` (normalization 0) scores a chunk by its covers
 * of the query terms, not its length, so a sentence, both windows
 * containing it, and the `full` chunk routinely tie exactly in the text
 * branch. Ordered by uuid, a wider chunk could take text rank 1 with the
 * sentence pushed to 3, and win the fused score outright despite the
 * sentence's better similarity — the highlight then quoted two sentences
 * instead of one, depending on which uuids the rows happened to get.
 */
const breadth = sql`CASE c.kind WHEN 'sentence' THEN 0 WHEN 'window' THEN 1 ELSE 2 END`;

/**
 * Hybrid search. `candidates` is `NOT MATERIALIZED` so each branch is
 * planned as its own index scan on `(project_id, environment)` rather than
 * spooling every embedding into a tuplestore once; the vector branch is
 * the driving set (inner join), which is what applies the floor to the
 * fused result. Every `reviews` join carries `tenant()` so the join side
 * is index-scanned for the tenant too (#111).
 */
function hybridStatement(
  params: SearchChunksParams,
  queryEmbedding: number[],
  queryText: string | null,
): SQL {
  // pgvector's text format, bound as a parameter and cast — never spliced.
  const vector = `[${queryEmbedding.join(",")}]`;
  const floor = params.policy.similarityFloor;
  // The lexical tier only exists with query text; without it the vector
  // branch stops at the floor as before.
  const lexicalFloor = queryText ? lexicalFloorFor(floor) : floor;

  // The floor's word-match test (#147): partial keyword coverage, not the
  // ranking branch's every-term match. Only rows already in `vec` (at or
  // above the lexical floor by default) pay for it.
  const lexical = queryText
    ? lexicalMatchSql(
        sql`v.tsv`,
        queryText,
        LEXICAL_RULE,
        genericQueryWords(params.policy.category),
      )
    : sql`false`;

  const textBranch = queryText
    ? sql`
      SELECT id,
             row_number() OVER (
               ORDER BY ts_rank_cd(tsv, q) DESC, occurred_at DESC NULLS LAST,
                        breadth, id
             ) AS rank
      FROM candidates, websearch_to_tsquery('english', ${queryText}) AS q
      WHERE tsv @@ q`
    : // Inactive branch: an empty relation of the same shape keeps the
      // statement one fixed template.
      sql`SELECT NULL::uuid AS id, NULL::bigint AS rank WHERE false`;

  return sql`
    WITH candidates AS NOT MATERIALIZED (
      SELECT c.id, c.review_id, c.text, c.start_offset, c.embedding, c.tsv,
             r.occurred_at, ${breadth} AS breadth
      FROM review_chunks c
      JOIN reviews r ON r.id = c.review_id AND ${tenant(params)}
      WHERE c.project_id = ${params.projectId}
        AND c.environment = ${params.environment}
        AND ${publishable(params)}
    ),
    vec AS (
      SELECT id, review_id, text, start_offset, occurred_at, breadth, similarity, tsv,
             row_number() OVER (
               ORDER BY similarity DESC, occurred_at DESC NULLS LAST, breadth, id
             ) AS rank
      FROM (
        SELECT id, review_id, text, start_offset, occurred_at, breadth, tsv,
               1 - (embedding <=> ${vector}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))})) AS similarity
        FROM candidates
        WHERE embedding IS NOT NULL
        -- OFFSET 0 keeps the planner from flattening this subquery, so each
        -- distance is computed once instead of once for the floor and once
        -- for the sort key (~15% off the statement at 5,000 chunks).
        OFFSET 0
      ) AS scored
      ${
        params.includeBelowFloor
          ? // Debug: keep everything; `below_floor` partitions the output.
            sql``
          : sql`WHERE similarity >= ${lexicalFloor}`
      }
    ),
    kw AS (${textBranch}),
    matched AS (
      SELECT v.*, kw.rank AS kw_rank, ${lexical} AS lexical
      FROM vec v
      LEFT JOIN kw ON kw.id = v.id
    ),
    fused AS (
      SELECT id, review_id, text, start_offset, occurred_at, breadth,
             similarity, lexical,
             NOT (similarity >= ${floor}
                  OR (lexical AND similarity >= ${lexicalFloor}))
               AS below_floor,
             (COALESCE(1.0 / (${RRF_K} + rank), 0)
              + COALESCE(1.0 / (${RRF_K} + kw_rank), 0))::float8 AS rrf
      FROM matched
    ),
    ${params.includeBelowFloor ? debugTail(params) : defaultTail(params)}
  `;
}

/** The `best` collapse: one row per review (per floor side in debug mode). */
const bestColumns = sql`b.id AS chunk_id,
           b.review_id,
           b.text AS excerpt,
           b.start_offset,
           b.similarity,
           b.rrf,
           b.below_floor,
           b.lexical,
           ${reviewColumns}`;

/** Default: collapse, then the top `limit` by fused rank. */
function defaultTail(params: SearchChunksParams): SQL {
  return sql`
    best AS (
      SELECT DISTINCT ON (review_id) *
      FROM fused
      WHERE NOT below_floor
      ORDER BY review_id, rrf DESC, similarity DESC, breadth, id
    )
    SELECT ${bestColumns}
    FROM best b
    JOIN reviews r ON r.id = b.review_id AND ${tenant(params)}
    ORDER BY b.rrf DESC, b.occurred_at DESC NULLS LAST, b.review_id
    LIMIT ${params.limit}`;
}

/**
 * Debug (`includeBelowFloor`): collapse within each floor side so the
 * above-floor page is byte-identical to the default, then append the next
 * `limit` reviews that only have below-floor chunks.
 */
function debugTail(params: SearchChunksParams): SQL {
  return sql`
    best AS (
      SELECT DISTINCT ON (review_id, below_floor) *
      FROM fused
      ORDER BY review_id, below_floor, rrf DESC, similarity DESC, breadth, id
    ),
    above AS (
      SELECT * FROM best WHERE NOT below_floor
      ORDER BY rrf DESC, occurred_at DESC NULLS LAST, review_id
      LIMIT ${params.limit}
    ),
    below AS (
      SELECT * FROM best
      WHERE below_floor
        AND review_id NOT IN (SELECT review_id FROM best WHERE NOT below_floor)
      ORDER BY rrf DESC, occurred_at DESC NULLS LAST, review_id
      LIMIT ${params.limit}
    )
    SELECT ${bestColumns}
    FROM (SELECT * FROM above UNION ALL SELECT * FROM below) b
    JOIN reviews r ON r.id = b.review_id AND ${tenant(params)}
    ORDER BY b.below_floor, b.rrf DESC, b.occurred_at DESC NULLS LAST, b.review_id`;
}

/**
 * No-query mode: newest publishable reviews with their `full` chunk as the
 * excerpt. Drives from `reviews` and picks the chunk with a LATERAL
 * subquery, so a review that has not been chunked yet is simply not
 * queryable, as the API's `indexing` status promises.
 *
 * `WHERE tenant ORDER BY occurred_at DESC NULLS LAST, id LIMIT n` is
 * exactly the shape of `reviews_project_id_environment_occurred_at_idx`
 * (#117): the planner walks that index from the tenant's newest row and
 * stops once `limit` rows have passed the policy filter, reading a few
 * dozen buffers. Before the index it was a Parallel Seq Scan over every
 * tenant's reviews plus a top-N sort — 8.2 ms for a 1,000-review tenant in
 * a 45k-row table, slower than the hybrid search for the same tenant, and
 * growing with the table. Keep the ORDER BY and the index in step: a
 * different sort key here silently brings the table scan back (the
 * plan-shape test in `searchChunks.integration.test.ts` would catch it).
 */
function recencyStatement(params: SearchChunksParams): SQL {
  return sql`
    SELECT c.id AS chunk_id,
           r.id AS review_id,
           c.text AS excerpt,
           c.start_offset,
           NULL::float8 AS similarity,
           NULL::float8 AS rrf,
           false AS below_floor,
           false AS lexical,
           ${reviewColumns}
    FROM reviews r
    JOIN LATERAL (
      SELECT c.id, c.text, c.start_offset
      FROM review_chunks c
      WHERE c.review_id = r.id
        AND c.project_id = ${params.projectId}
        AND c.environment = ${params.environment}
        AND c.kind = 'full'
      ORDER BY c.start_offset, c.id
      LIMIT 1
    ) AS c ON true
    WHERE ${tenant(params)}
      AND ${publishable(params)}
    ORDER BY r.occurred_at DESC NULLS LAST, r.id
    LIMIT ${params.limit}
  `;
}

function toResult(row: Row, activeLists: number): SearchResult {
  return {
    reviewId: row.review_id,
    chunkId: row.chunk_id,
    excerpt: row.excerpt,
    startOffset: row.start_offset,
    similarity: row.similarity,
    score: row.rrf === null ? null : normalizeRrf(row.rrf, activeLists),
    belowFloor: row.below_floor,
    lexical: row.lexical,
    review: {
      rating: row.rating,
      authorName: row.author_name,
      authorAvatarUrl: row.author_avatar_url,
      source: row.source,
      occurredAt: row.occurred_at === null ? null : new Date(row.occurred_at),
      url: row.url,
      metadata: row.metadata,
      text: row.review_text,
    },
  };
}
