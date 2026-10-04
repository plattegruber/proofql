/**
 * Review browser reads and writes (#39), straight against Postgres with the
 * same semantics as the api's management routes (`workers/api/src/routes/
 * reviews-crud.ts`): every query scopes to `(project_id, environment)`,
 * the list is keyset-paginated on `(occurred_at DESC NULLS LAST, id DESC)`,
 * and anything that changes what a query may return bumps the project's
 * cache generation after the write commits (`bumpProjectGeneration`, #81)
 * — so a hidden review disappears from the playground and the snippet on
 * the next request.
 *
 * Plain functions over a `Db` plus a `GenerationKv`, so the loaders
 * (Hyperdrive + the CACHE binding) and the integration tests (the
 * @proofql/db harness + `MemoryKv`) run the same code.
 */
import {
  bumpProjectGeneration,
  type ChunkKind,
  type GenerationKv,
} from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import {
  type Cursor,
  cursorFor,
  decodeCursor,
  type Environment,
  encodeCursor,
  PAGE_SIZE,
  type ReviewListFilters,
} from "./reviews";

export type ReviewRow = typeof schema.reviews.$inferSelect;

/** A list row: the review minus its long columns, plus its chunk count. */
export interface ReviewListRow {
  id: string;
  source: string;
  externalId: string;
  rating: number | null;
  text: string;
  authorName: string | null;
  occurredAt: Date | null;
  hiddenAt: Date | null;
  indexedAt: Date | null;
  indexAttempts: number;
  sentiment: ReviewRow["sentiment"];
  sentimentSource: ReviewRow["sentimentSource"];
  chunkCount: number;
}

export interface ListReviewsParams {
  projectId: string;
  environment: Environment;
  /** Encoded cursor from the previous page; null or malformed starts over. */
  cursor?: string | null | undefined;
  limit?: number | undefined;
  filters?: Partial<ReviewListFilters> | undefined;
}

export interface ListReviewsResult {
  rows: ReviewListRow[];
  /** For the next page; null on the last one. */
  nextCursor: string | null;
}

/** Every statement starts here. */
function scope(projectId: string, environment: Environment): SQL {
  return and(
    eq(schema.reviews.projectId, projectId),
    eq(schema.reviews.environment, environment),
  ) as SQL;
}

/**
 * The sort key, truncated to milliseconds on both sides of the comparison
 * so a JS-made cursor matches a microsecond column exactly (the api's rule).
 */
const occurredKey = sql`date_trunc('milliseconds', ${schema.reviews.occurredAt})`;

function afterCursor(cursor: Cursor): SQL {
  if (cursor.o === null) {
    return and(
      isNull(schema.reviews.occurredAt),
      lt(schema.reviews.id, cursor.i),
    ) as SQL;
  }
  const at = sql`${cursor.o}::timestamptz`;
  return or(
    sql`${occurredKey} < ${at}`,
    and(sql`${occurredKey} = ${at}`, lt(schema.reviews.id, cursor.i)),
    isNull(schema.reviews.occurredAt),
  ) as SQL;
}

function filterClauses(filters: Partial<ReviewListFilters>): SQL[] {
  const out: SQL[] = [];
  if (filters.source) out.push(eq(schema.reviews.source, filters.source));
  if (filters.minRating !== undefined) {
    out.push(gte(schema.reviews.rating, filters.minRating));
  }
  if (filters.hidden === "hidden") out.push(isNotNull(schema.reviews.hiddenAt));
  if (filters.hidden === "visible") out.push(isNull(schema.reviews.hiddenAt));
  if (filters.indexed === "indexed") {
    out.push(isNotNull(schema.reviews.indexedAt));
  }
  if (filters.indexed === "pending") out.push(isNull(schema.reviews.indexedAt));
  return out;
}

export async function listReviews(
  db: Db,
  params: ListReviewsParams,
): Promise<ListReviewsResult> {
  const limit = params.limit ?? PAGE_SIZE;
  const cursor = params.cursor ? decodeCursor(params.cursor) : null;
  const clauses = [
    scope(params.projectId, params.environment),
    ...filterClauses(params.filters ?? {}),
  ];
  if (cursor) clauses.push(afterCursor(cursor));

  // One extra row says whether a next page exists, without a count.
  const rows = await db
    .select({
      id: schema.reviews.id,
      source: schema.reviews.source,
      externalId: schema.reviews.externalId,
      rating: schema.reviews.rating,
      text: schema.reviews.text,
      authorName: schema.reviews.authorName,
      occurredAt: schema.reviews.occurredAt,
      hiddenAt: schema.reviews.hiddenAt,
      indexedAt: schema.reviews.indexedAt,
      indexAttempts: schema.reviews.indexAttempts,
      sentiment: schema.reviews.sentiment,
      sentimentSource: schema.reviews.sentimentSource,
      // Spelled out: in a single-table select drizzle renders
      // `${schema.reviews.id}` unqualified as "id", which the subquery would
      // resolve to the chunk's own id.
      chunkCount: sql<number>`(
        SELECT count(*)::int FROM review_chunks c
        WHERE c.review_id = reviews.id
      )`,
    })
    .from(schema.reviews)
    .where(and(...clauses))
    .orderBy(sql`${occurredKey} DESC NULLS LAST`, desc(schema.reviews.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor(cursorFor(last))
        : null,
  };
}

/** Distinct sources present in this project and environment, for the filter. */
export async function listReviewSources(
  db: Db,
  params: { projectId: string; environment: Environment },
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ source: schema.reviews.source })
    .from(schema.reviews)
    .where(scope(params.projectId, params.environment))
    .orderBy(asc(schema.reviews.source));
  return rows.map((r) => r.source);
}

/** A chunk as the detail page lists it — the vector itself is never read. */
export interface ReviewChunkRow {
  id: string;
  kind: ChunkKind;
  text: string;
  startOffset: number;
  embedded: boolean;
  createdAt: Date;
}

export interface ReviewDetail {
  review: ReviewRow;
  chunks: ReviewChunkRow[];
}

/**
 * One review with every chunk, in text order. Scoped by project only: ids
 * are unique and the row carries its own environment, which the page
 * shows. Null when the review is not this project's.
 */
export async function getReviewDetail(
  db: Db,
  params: { projectId: string; id: string },
): Promise<ReviewDetail | null> {
  const [review] = await db
    .select()
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.id, params.id),
        eq(schema.reviews.projectId, params.projectId),
      ),
    )
    .limit(1);
  if (review === undefined) return null;

  const chunks = await db
    .select({
      id: schema.reviewChunks.id,
      kind: schema.reviewChunks.kind,
      text: schema.reviewChunks.text,
      startOffset: schema.reviewChunks.startOffset,
      embedded: sql<boolean>`${schema.reviewChunks.embedding} IS NOT NULL`,
      createdAt: schema.reviewChunks.createdAt,
    })
    .from(schema.reviewChunks)
    .where(eq(schema.reviewChunks.reviewId, review.id))
    .orderBy(
      // The full chunk first, then windows and sentences in text order.
      sql`${schema.reviewChunks.kind} = 'full' DESC`,
      asc(schema.reviewChunks.startOffset),
      asc(schema.reviewChunks.id),
    );
  return { review, chunks };
}

export interface SetHiddenParams {
  projectId: string;
  environment: Environment;
  /** Review ids; rows outside the scope are ignored, not errors. */
  ids: string[];
  hidden: boolean;
}

export interface SetHiddenResult {
  /** Rows whose state actually changed (already-hidden rows don't count). */
  changed: number;
  /** The project's new cache generation, or null when nothing changed. */
  generation: number | null;
}

/**
 * Hide or unhide any number of reviews in one statement, then bump the
 * project's cache generation exactly once — after the write, never inside
 * it (`@proofql/core` cache-generation module doc). Rows already in the
 * requested state are left alone, so an idempotent re-submit purges
 * nothing. Mirrors `PATCH /v1/reviews/:id { hidden }`.
 */
export async function setReviewsHidden(
  db: Db,
  kv: GenerationKv,
  params: SetHiddenParams,
): Promise<SetHiddenResult> {
  if (params.ids.length === 0) return { changed: 0, generation: null };
  const now = new Date();
  const updated = await db
    .update(schema.reviews)
    .set({ hiddenAt: params.hidden ? now : null, updatedAt: now })
    .where(
      and(
        scope(params.projectId, params.environment),
        inArray(schema.reviews.id, params.ids),
        params.hidden
          ? isNull(schema.reviews.hiddenAt)
          : isNotNull(schema.reviews.hiddenAt),
      ),
    )
    .returning({ id: schema.reviews.id });
  if (updated.length === 0) return { changed: 0, generation: null };
  const generation = await bumpProjectGeneration(kv, params.projectId);
  return { changed: updated.length, generation };
}
