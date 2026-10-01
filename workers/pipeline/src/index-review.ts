/**
 * Index one review: sentiment, then chunks (#23). The embedding stage (#24)
 * slots in after chunking via {@link EmbedChunks}.
 *
 * Sentiment (scope.md §2 "Sentiment gate"): a star rating is the signal when
 * there is one — `sentimentFromRating`, `sentiment_source = 'rating'`. Only
 * unrated reviews consult the classifier (`'model'`). No LLM anywhere.
 *
 * Chunks (scope.md §2 "Chunking"): `chunkReview` from `@proofql/core`, one
 * `full` chunk plus sentence windows for longer reviews, every one a
 * verbatim slice — asserted twice before the insert (core's invariant on the
 * chunk list, db's `assertVerbatimSlice` per row, the gate the schema
 * documents). `embedding` is left NULL and `indexed_at` untouched: #24
 * fills both once vectors exist, and the API reports `status: "indexing"`
 * until then.
 *
 * Idempotent by construction: the existing chunks for the review are deleted
 * and the new set inserted in one transaction, so a redelivered message
 * (Queues are at-least-once) converges on the same rows instead of
 * duplicating them. The review row is scoped to the message's `project_id`
 * and `environment`, so a message can never index another tenant's review.
 */

import type { SentimentClassifier } from "@proofql/ai";
import {
  assertVerbatimChunks,
  type Chunk,
  chunkReview,
  type IngestMessage,
  type Sentiment,
  sentimentFromRating,
} from "@proofql/core";
import { assertVerbatimSlice, type Db, schema } from "@proofql/db";
import { and, eq } from "drizzle-orm";

import { log as defaultLog, type Logger } from "./log.js";

const { reviews, reviewChunks } = schema;

export type ReviewRow = typeof reviews.$inferSelect;
export type ChunkRow = typeof reviewChunks.$inferSelect;
export type SentimentSource = NonNullable<ReviewRow["sentimentSource"]>;

/**
 * The embedding stage (#24): receives the review and the chunk rows just
 * written (with their ids) and is expected to fill `embedding` and set
 * `reviews.indexed_at`. The default does nothing.
 */
export type EmbedChunks = (
  ctx: IndexContext,
  input: { review: ReviewRow; chunks: ChunkRow[] },
) => Promise<void>;

/** TODO(#24): replace with the bge-m3 embedding step. */
export const noopEmbedChunks: EmbedChunks = async () => {};

export interface IndexContext {
  db: Db;
  classifier: SentimentClassifier;
  log?: Logger;
  embedChunks?: EmbedChunks;
}

export type SkipReason = "not_found" | "hidden" | "empty_text";

export type IndexOutcome =
  | {
      status: "indexed";
      reviewId: string;
      chunks: number;
      windows: number;
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
 * rejects on infrastructure failures (database, classifier) so the handler
 * retries.
 */
export async function indexReview(
  ctx: IndexContext,
  message: IngestMessage,
): Promise<IndexOutcome> {
  const log = ctx.log ?? defaultLog;
  const embedChunks = ctx.embedChunks ?? noopEmbedChunks;
  const { reviewId, projectId, environment } = message;

  const review = await loadReview(ctx.db, message);
  if (!review) {
    log("review.skipped", {
      reviewId,
      projectId,
      environment,
      reason: "not_found",
    });
    return { status: "skipped", reviewId, reason: "not_found" };
  }
  if (review.hiddenAt !== null) {
    log("review.skipped", {
      reviewId,
      projectId,
      environment,
      reason: "hidden",
    });
    return { status: "skipped", reviewId, reason: "hidden" };
  }

  let chunks: Chunk[];
  try {
    chunks = chunkReview(review.text, { locale: review.language });
  } catch (error) {
    if (error instanceof RangeError) {
      log("review.skipped", {
        reviewId,
        projectId,
        environment,
        reason: "empty_text",
      });
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

  await embedChunks(ctx, { review: updated, chunks: written });

  const windows = written.filter((c) => c.kind === "window").length;
  log("review.indexed", {
    reviewId,
    projectId,
    environment,
    chunks: written.length,
    windows,
    sentiment,
    sentimentSource,
  });
  return {
    status: "indexed",
    reviewId,
    chunks: written.length,
    windows,
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
  { reviewId, projectId, environment }: IngestMessage,
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
