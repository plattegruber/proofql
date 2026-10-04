/**
 * Index one review: sentiment, chunks (#23), then embeddings (#24) via
 * {@link EmbedChunks} — by default `embedChunks` from src/embed-chunks.ts.
 *
 * Sentiment (scope.md §2 "Sentiment gate"): a star rating is the signal when
 * there is one — `sentimentFromRating`, `sentiment_source = 'rating'`. Only
 * unrated reviews consult the classifier (`'model'`). No LLM anywhere.
 *
 * Chunks (scope.md §2 "Chunking"): `chunkReview` from `@proofql/core`, one
 * `full` chunk plus sentence windows for longer reviews and one `sentence`
 * chunk per sentence for reviews of two or more (#127), every one a
 * verbatim slice — asserted twice before the insert (core's invariant on the
 * chunk list, db's `assertVerbatimSlice` per row, the gate the schema
 * documents). Chunk rows are inserted with `embedding` NULL; the embedding
 * stage fills them and sets `indexed_at` once every chunk has a vector, and
 * the API reports `status: "indexing"` until then.
 *
 * Idempotent by construction: the existing chunks for the review are deleted
 * and the new set inserted in one transaction, so a redelivered message
 * (Queues are at-least-once) converges on the same rows instead of
 * duplicating them. The review row is scoped to the message's `project_id`
 * and `environment`, so a message can never index another tenant's review.
 */

import type { EmbeddingProvider, SentimentClassifier } from "@proofql/ai";
import {
  assertVerbatimChunks,
  type Chunk,
  chunkReview,
  type GenerationKv,
  type Logger,
  type ReviewIndexMessage,
  type Sentiment,
  sentimentFromRating,
} from "@proofql/core";
import { assertVerbatimSlice, type Db, schema } from "@proofql/db";
import { and, eq } from "drizzle-orm";

import {
  type EmbedResult,
  embedChunks as realEmbedChunks,
} from "./embed-chunks.js";

const { reviews, reviewChunks } = schema;

export type ReviewRow = typeof reviews.$inferSelect;
export type ChunkRow = typeof reviewChunks.$inferSelect;
export type SentimentSource = NonNullable<ReviewRow["sentimentSource"]>;

/**
 * The embedding stage (#24): receives the review and the chunk rows just
 * written (with their ids), fills `embedding`, and sets `reviews.indexed_at`
 * once every chunk has a vector. Tests substitute a fake to isolate the
 * chunking stage; production uses `embedChunks` from src/embed-chunks.ts.
 */
export type EmbedChunks = (
  ctx: IndexContext,
  input: { review: ReviewRow; chunks: ChunkRow[] },
) => Promise<EmbedResult>;

export interface IndexContext {
  db: Db;
  classifier: SentimentClassifier;
  /** bge-m3 in preview/prod, the deterministic fake locally (`createEmbedder`). */
  embedder: EmbeddingProvider;
  /** `env.CACHE`: the project's query-cache generation is bumped on index. */
  cache: GenerationKv;
  /**
   * The logger for this unit of work. `handleQueueBatch` passes a child
   * bound to the message (`message_id`, `attempt`, `review_id`, …), so the
   * lines below carry those without naming them.
   */
  log: Logger;
  embedChunks?: EmbedChunks;
}

export type SkipReason = "not_found" | "hidden" | "empty_text";

export type IndexOutcome =
  | {
      status: "indexed";
      reviewId: string;
      chunks: number;
      windows: number;
      /** Single-sentence chunks (#127); 0 for a one-sentence review. */
      sentences: number;
      /** Chunks embedded by this run (0 when every chunk already had one). */
      embedded: number;
      /** Whether this run flipped `indexed_at` from null to set. */
      newlyIndexed: boolean;
      sentiment: Sentiment;
      sentimentSource: SentimentSource;
    }
  | { status: "skipped"; reviewId: string; reason: SkipReason };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Index the review a message names. Resolves to an outcome for anything
 * that is a property of the review (missing, hidden, empty) — those are
 * logged and acknowledged, since redelivery cannot change them — and
 * rejects on infrastructure failures (database, classifier, embedding
 * provider) so the handler retries.
 */
export async function indexReview(
  ctx: IndexContext,
  message: ReviewIndexMessage,
): Promise<IndexOutcome> {
  const embedChunks = ctx.embedChunks ?? realEmbedChunks;
  const { reviewId, projectId, environment } = message;
  // Bound explicitly as well as via the handler's child: `indexReview` is
  // also called directly (the sweep's reset path, tests).
  const log = ctx.log.child({
    review_id: reviewId,
    project_id: projectId,
    environment,
  });

  const review = await loadReview(ctx.db, message);
  if (!review) {
    log.log("review.skipped", { reason: "not_found" });
    return { status: "skipped", reviewId, reason: "not_found" };
  }
  if (review.hiddenAt !== null) {
    log.log("review.skipped", { reason: "hidden" });
    return { status: "skipped", reviewId, reason: "hidden" };
  }

  let chunks: Chunk[];
  try {
    chunks = chunkReview(review.text, { locale: review.language });
  } catch (error) {
    if (error instanceof RangeError) {
      log.log("review.skipped", { reason: "empty_text" });
      return { status: "skipped", reviewId, reason: "empty_text" };
    }
    throw error;
  }
  assertVerbatimChunks(review.text, chunks);
  for (const chunk of chunks) assertVerbatimSlice(review, chunk);

  const { sentiment, sentimentSource } = await classify(ctx, review);

  const now = new Date();
  const { written, updated } = await ctx.db.transaction(async (tx) => {
    await tx.delete(reviewChunks).where(eq(reviewChunks.reviewId, review.id));
    const written = await tx
      .insert(reviewChunks)
      .values(
        chunks.map((chunk) => ({
          reviewId: review.id,
          projectId: review.projectId,
          environment: review.environment,
          kind: chunk.kind,
          text: chunk.text,
          startOffset: chunk.startOffset,
          embedding: null,
        })),
      )
      .returning();
    const [updated] = await tx
      .update(reviews)
      .set({ sentiment, sentimentSource, updatedAt: now })
      .where(eq(reviews.id, review.id))
      .returning();
    return { written, updated: updated ?? review };
  });

  const embedding = await embedChunks(ctx, {
    review: updated,
    chunks: written,
  });

  const windows = written.filter((c) => c.kind === "window").length;
  const sentences = written.filter((c) => c.kind === "sentence").length;
  // The one line per review: chunking and embedding figures together.
  log.log("review.indexed", {
    chunks: written.length,
    windows,
    sentences,
    embedded: embedding.embedded,
    embedding_ms: embedding.embeddingMs,
    newly_indexed: embedding.newlyIndexed,
    sentiment,
    sentiment_source: sentimentSource,
  });
  return {
    status: "indexed",
    reviewId,
    chunks: written.length,
    windows,
    sentences,
    embedded: embedding.embedded,
    newlyIndexed: embedding.newlyIndexed,
    sentiment,
    sentimentSource,
  };
}

/**
 * The review by id, scoped to the message's tenant and environment. A
 * `reviewId` that is not a UUID can never match and would make Postgres
 * raise `22P02` on the comparison, so it is treated as not found.
 */
async function loadReview(
  db: Db,
  { reviewId, projectId, environment }: ReviewIndexMessage,
): Promise<ReviewRow | undefined> {
  if (!UUID_RE.test(reviewId) || !UUID_RE.test(projectId)) return undefined;
  const [row] = await db
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.id, reviewId),
        eq(reviews.projectId, projectId),
        eq(reviews.environment, environment),
      ),
    )
    .limit(1);
  return row;
}

async function classify(
  ctx: IndexContext,
  review: ReviewRow,
): Promise<{ sentiment: Sentiment; sentimentSource: SentimentSource }> {
  if (review.rating !== null) {
    return {
      sentiment: sentimentFromRating(review.rating),
      sentimentSource: "rating",
    };
  }
  const result = await ctx.classifier.classify(review.text);
  return { sentiment: result.sentiment, sentimentSource: "model" };
}
