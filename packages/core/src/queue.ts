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
 * Both ends of the queue import this file: the schema is the contract.
 */

import { z } from "zod";

import { API_KEY_ENVIRONMENTS } from "./apiKeys.js";

export const INGEST_MESSAGE_TYPES = ["review.index"] as const;

/** Wire shape of a `proofql-ingest` message. */
export type IngestMessage = {
  type: "review.index";
  /** `reviews.id` of the row to (re)index. */
  reviewId: string;
  /** `reviews.project_id`, so the consumer can scope and purge the cache. */
  projectId: string;
  /** `reviews.environment` — the row's live/test split. */
  environment: "live" | "test";
};

/**
 * Validates a message body at the consumer. Ids are opaque non-empty
 * strings here (Postgres enforces the uuid shape); the enum values are the
 * single source of truth from the key/environment model.
 */
export const ingestMessageSchema = z.object({
  type: z.enum(INGEST_MESSAGE_TYPES),
  reviewId: z.string().min(1),
  projectId: z.string().min(1),
  environment: z.enum(API_KEY_ENVIRONMENTS),
});

// The hand-written type and the schema must agree; a mismatch is a compile
// error here rather than a runtime surprise at one end of the queue.
type SchemaOutput = z.output<typeof ingestMessageSchema>;
const _check: [
  SchemaOutput extends IngestMessage ? true : never,
  IngestMessage extends SchemaOutput ? true : never,
] = [true, true];
void _check;
