/**
 * `review_chunks` — the unit of search (scope.md §2 "Chunking", §4).
 *
 * Every review gets one `full` chunk covering its whole text; reviews longer
 * than a few sentences also get `window` chunks (2–3 sentences, overlapping
 * by one) so a review that covers four topics can match four queries. The
 * best-matching chunk is the excerpt the API returns.
 *
 * **Verbatim by construction.** `text` is always a slice of the parent
 * review's text starting at `start_offset`:
 *
 *     review.text.slice(start_offset, start_offset + text.length) === text
 *
 * Nothing generates text, so a fabricated quote cannot exist. The invariant
 * is checked by `assertVerbatimSlice` in `../chunks.ts` on the write path
 * and in tests; it cannot be a CHECK constraint because it spans two tables.
 *
 * **Vectors.** `embedding` is `halfvec(1024)` — bge-m3's dimensionality,
 * stored at half precision to halve the bytes with no measurable loss for
 * cosine ranking. Nullable because chunk rows are written before the
 * embedding job fills them in.
 *
 * **No HNSW or IVFFlat index — on purpose.** Tenants are small (a few
 * thousand vectors at most) and numerous. Search filters by
 * `(project_id, environment)` through the btree below and computes exact
 * cosine distance over that tenant's rows: single-digit milliseconds and
 * always correct. A global approximate index with a tenant post-filter is
 * the classic multi-tenant pgvector failure mode — small tenants get
 * starved, wrong results. Revisit (per-tenant partial index or
 * partitioning) only when one tenant exceeds ~50k vectors. `project_id` and
 * `environment` are denormalized from `reviews` precisely so that filter
 * never needs a join.
 *
 * **Full text.** `tsv` is a stored generated column so the FTS branch of
 * hybrid search can never drift from `text`. The `english` configuration is
 * a v0 simplification (bge-m3 carries the multilingual weight; FTS is the
 * keyword-exactness signal); a language-aware configuration is a later
 * migration, not a rewrite.
 */

import { CHUNK_KINDS, type ChunkKind } from "@proofql/core";
import { sql } from "drizzle-orm";
import {
  check,
  halfvec,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { reviews } from "./reviews.js";
import { environmentEnum, id } from "./shared.js";
import { projects } from "./tenancy.js";
import { tsvector } from "./tsvector.js";

/** bge-m3 output size; the only embedding dimension the schema knows. */
export const EMBEDDING_DIMENSIONS = 1024;

export { CHUNK_KINDS, type ChunkKind };
export const chunkKindEnum = pgEnum("chunk_kind", CHUNK_KINDS);

export const reviewChunks = pgTable(
  "review_chunks",
  {
    id: id(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    /** Denormalized from `reviews` so the tenant filter never joins. */
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environment: environmentEnum("environment").notNull(),
    kind: chunkKindEnum("kind").notNull(),
    /** Verbatim slice of the parent review's text — see module doc. */
    text: text("text").notNull(),
    /** UTF-16 code-unit offset of `text` within the parent review's text. */
    startOffset: integer("start_offset").notNull(),
    /** bge-m3 embedding at half precision; null until the embedding job runs. */
    embedding: halfvec("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    tsv: tsvector("tsv").generatedAlwaysAs(
      (): ReturnType<typeof sql> => sql`to_tsvector('english', "text")`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The tenant filter every search starts from. Deliberately the only
    // index on the search path — see module doc for why there is no HNSW.
    index("review_chunks_project_id_environment_idx").on(
      table.projectId,
      table.environment,
    ),
    index("review_chunks_tsv_gin_idx").using("gin", table.tsv),
    // Cascade deletes and "show this review's excerpts" look up by parent.
    index("review_chunks_review_id_idx").on(table.reviewId),
    check(
      "review_chunks_start_offset_nonnegative",
      sql`${table.startOffset} >= 0`,
    ),
  ],
);
