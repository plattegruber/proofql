/**
 * The embedding stage (#24): fill `review_chunks.embedding` for one review
 * and mark the review indexed once every chunk has a vector.
 *
 * Runs after `indexReview` has written the chunk rows (src/index-review.ts).
 * It does not trust the rows it is handed: it re-reads the review's chunks
 * `WHERE embedding IS NULL` from the database, so the same function is the
 * first pass, the retry after a provider failure (only the still-null rows
 * are embedded again), and a no-op on a review whose chunks are all
 * embedded. Vectors are written one `UPDATE ... FROM unnest(...)` per
 * provider batch: a single round trip per 50 chunks, and a batch that
 * reached the database stays written if the next provider call throws.
 *
 * Batching is done here, at `EMBEDDING_BATCH_SIZE`, not left to the
 * provider: the Workers AI embedder also batches internally, but the fake
 * does not, and the handler's retry/backoff reasoning depends on one
 * provider call never carrying more than one batch of texts.
 *
 * `reviews.indexed_at` flips from null to `now()` in one conditional UPDATE
 * (`indexed_at IS NULL AND NOT EXISTS (chunks with a null embedding)`), so
 * it is set exactly once per transition, and only that transition bumps the
 * project's cache generation (`@proofql/core`): a redelivered message for an
 * already-indexed review re-embeds its freshly rewritten chunks to the same
 * vectors and leaves `indexed_at` and the cache alone. Either way a
 * complete review zeroes `index_attempts`, the re-enqueue sweep's counter
 * (#72). Every chunk is a
 * verbatim slice of a non-empty review, so there is always at least one
 * chunk and never a token-free text to embed.
 *
 * Provider errors (`EmbeddingDimensionError`, `AiResponseError`, a thrown
 * fetch) propagate: the handler retries the message with backoff and the
 * queue parks it in the DLQ after `max_retries`. Nothing here catches them.
 */

import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  EmbeddingDimensionError,
  EmbeddingError,
  type EmbeddingProvider,
} from "@proofql/ai";
import {
  createLogger,
  type GenerationKv,
  type Logger,
  safeBumpProjectGeneration,
  silentSink,
} from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { and, eq, isNull, notExists, sql } from "drizzle-orm";

const { reviews, reviewChunks } = schema;

export interface EmbedContext {
  db: Db;
  embedder: EmbeddingProvider;
  cache: GenerationKv;
  /** Where a failed generation bump is reported (#158); silent when absent. */
  log?: Logger;
}

const silentLog = createLogger({
  service: "pipeline",
  environment: "unknown",
  sink: silentSink,
});

export interface EmbedResult {
  /** Chunks that had no embedding when the stage started. */
  pending: number;
  /** Chunks embedded and written by this call (equals `pending` on success). */
  embedded: number;
  /** Wall time spent inside the provider plus the vector writes. */
  embeddingMs: number;
  /** True when this call flipped `indexed_at` from null to set. */
  newlyIndexed: boolean;
}

/**
 * Embed every not-yet-embedded chunk of `review`, then set `indexed_at`
 * (and bump the project's cache generation) if the review is now complete.
 */
export async function embedChunks(
  ctx: EmbedContext,
  { review }: { review: { id: string; projectId: string } },
): Promise<EmbedResult> {
  const started = performance.now();
  const pending = await ctx.db
    .select({ id: reviewChunks.id, text: reviewChunks.text })
    .from(reviewChunks)
    .where(
      and(eq(reviewChunks.reviewId, review.id), isNull(reviewChunks.embedding)),
    )
    .orderBy(reviewChunks.startOffset, reviewChunks.kind);

  let embedded = 0;
  for (let start = 0; start < pending.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = pending.slice(start, start + EMBEDDING_BATCH_SIZE);
    const vectors = await ctx.embedder.embed(batch.map((c) => c.text));
    assertVectors(ctx.embedder.model, batch.length, vectors);
    await writeEmbeddings(
      ctx.db,
      review.id,
      batch.map((c) => c.id),
      vectors,
    );
    embedded += batch.length;
  }

  const newlyIndexed = await markIndexed(ctx.db, review.id);
  // Never throws (#158): the review is indexed whatever KV says; a lost
  // bump leaves cached results stale until their TTL, and is logged.
  if (newlyIndexed) {
    await safeBumpProjectGeneration(ctx.cache, review.projectId, {
      log: ctx.log ?? silentLog,
      site: "pipeline.index",
    });
  }
  await resetIndexAttempts(ctx.db, review.id);

  return {
    pending: pending.length,
    embedded,
    embeddingMs: Math.round(performance.now() - started),
    newlyIndexed,
  };
}

/**
 * The provider contract (`result[i]` embeds `texts[i]`, 1024 numbers each)
 * is what makes the positional write below safe; verify it rather than
 * store a misaligned or truncated vector against a verbatim excerpt.
 */
function assertVectors(
  model: string,
  expected: number,
  vectors: number[][],
): void {
  if (vectors.length !== expected) {
    throw new EmbeddingError(
      `Embedding model ${model} returned ${vectors.length} vectors for ${expected} texts`,
    );
  }
  for (const vector of vectors) {
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new EmbeddingDimensionError(
        EMBEDDING_DIMENSIONS,
        vector.length,
        model,
      );
    }
  }
}

/**
 * One statement per batch: `unnest` pairs each chunk id with its vector
 * literal and the join writes them. `review_id` is in the predicate so a
 * stale id can never touch another review's row. The arrays go through
 * `sql.param` so each is bound as one Postgres array parameter (a bare
 * array in a `sql` template would be spread into a row constructor).
 */
async function writeEmbeddings(
  db: Db,
  reviewId: string,
  ids: string[],
  vectors: number[][],
): Promise<void> {
  const literals = vectors.map((v) => `[${v.join(",")}]`);
  await db.execute(sql`
    UPDATE ${reviewChunks} AS c
    SET embedding = v.embedding::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))})
    FROM unnest(${sql.param(ids)}::uuid[], ${sql.param(literals)}::text[]) AS v(id, embedding)
    WHERE c.id = v.id AND c.review_id = ${reviewId}
  `);
}

/** `EXISTS` over the review's chunks that still lack an embedding. */
function pendingChunks(db: Db, reviewId: string) {
  return db
    .select({ one: sql`1` })
    .from(reviewChunks)
    .where(
      and(eq(reviewChunks.reviewId, reviewId), isNull(reviewChunks.embedding)),
    );
}

/**
 * `indexed_at := now()` iff it is null and no chunk of the review lacks an
 * embedding. Resolves to whether this call made the transition.
 */
async function markIndexed(db: Db, reviewId: string): Promise<boolean> {
  const flipped = await db
    .update(reviews)
    .set({ indexedAt: sql`now()` })
    .where(
      and(
        eq(reviews.id, reviewId),
        isNull(reviews.indexedAt),
        notExists(pendingChunks(db, reviewId)),
      ),
    )
    .returning({ id: reviews.id });
  return flipped.length > 0;
}

/**
 * A fully embedded review has been indexed successfully, whether this call
 * or an earlier one flipped `indexed_at`: zero the re-enqueue sweep's
 * attempt counter (#72, src/sweep.ts). A no-op (no row matches) when the
 * counter is already 0, which is the common case.
 */
async function resetIndexAttempts(db: Db, reviewId: string): Promise<void> {
  await db
    .update(reviews)
    .set({ indexAttempts: 0 })
    .where(
      and(
        eq(reviews.id, reviewId),
        sql`${reviews.indexAttempts} <> 0`,
        notExists(pendingChunks(db, reviewId)),
      ),
    );
}
