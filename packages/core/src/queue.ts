/**
 * Messages on the `proofql-ingest` queue (scope.md §2 "Platform"; issues #21
 * and #23).
 *
 * The api worker produces one message per review that needs indexing — a
 * new review, or an existing one whose text changed — right after the
 * transaction that wrote the row commits. The pipeline worker consumes it,
 * re-reads the review by id, chunks, embeds, classifies sentiment when the
 * review is unrated, and sets `reviews.indexed_at`.
 *
 * The message carries ids, not content: the review row is the source of
 * truth, and a stale message (the text changed again before the consumer
 * ran) is harmless because the consumer always reads the current row.
 * `projectId` and `environment` ride along so the consumer can scope its
 * writes and purge the right cache without a second lookup.
 *
 * `connection.sync` (#46) rides the same queue: the dashboard sends one when
 * a Google connection's location mapping is saved, and the pipeline polls
 * that connection at once instead of waiting for the six-hourly cron. It
 * carries the `connections.id` only; the consumer re-reads the row.
 *
 * Both ends of the queue import this file: the schema is the contract.
 */

import { z } from "zod";

import { API_KEY_ENVIRONMENTS } from "./apiKeys.js";

export const INGEST_MESSAGE_TYPES = [
  "review.index",
  "connection.sync",
] as const;

/** Index (or re-index) one review. */
export type ReviewIndexMessage = {
  type: "review.index";
  /** `reviews.id` of the row to (re)index. */
  reviewId: string;
  /** `reviews.project_id`, so the consumer can scope and purge the cache. */
  projectId: string;
  /** `reviews.environment` — the row's live/test split. */
  environment: "live" | "test";
};

/** Poll one connector connection now (#46; the Google connector today). */
export type ConnectionSyncMessage = {
  type: "connection.sync";
  /** `connections.id`. */
  connectionId: string;
  /** `connections.project_id`, for log correlation. */
  projectId: string;
};

/** Wire shape of a `proofql-ingest` message. */
export type IngestMessage = ReviewIndexMessage | ConnectionSyncMessage;

/**
 * Validates a message body at the consumer. Ids are opaque non-empty
 * strings here (Postgres enforces the uuid shape); the enum values are the
 * single source of truth from the key/environment model.
 */
export const ingestMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("review.index"),
    reviewId: z.string().min(1),
    projectId: z.string().min(1),
    environment: z.enum(API_KEY_ENVIRONMENTS),
  }),
  z.object({
    type: z.literal("connection.sync"),
    connectionId: z.string().min(1),
    projectId: z.string().min(1),
  }),
]);

// The hand-written type and the schema must agree; a mismatch is a compile
// error here rather than a runtime surprise at one end of the queue.
type SchemaOutput = z.output<typeof ingestMessageSchema>;
const _check: [
  SchemaOutput extends IngestMessage ? true : never,
  IngestMessage extends SchemaOutput ? true : never,
] = [true, true];
void _check;
