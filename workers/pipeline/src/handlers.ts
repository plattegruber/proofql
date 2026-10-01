/**
 * Pipeline handlers, kept out of the wrangler entrypoint (src/worker.ts) so
 * unit tests can call them under Node with hand-built batches.
 *
 * Queue consumer contract (`proofql-ingest`, wrangler.jsonc):
 *
 * - Every body is validated with `ingestMessageSchema` first. A body that
 *   does not parse is **acknowledged** and logged, never retried: garbage
 *   does not become valid on redelivery, and retrying it would only park
 *   it in the DLQ three attempts later.
 * - A valid message runs `indexReview`. Success → `ack()`. Any thrown error
 *   (database, classifier) → `retry()`; after `max_retries` Queues moves the
 *   message to `proofql-ingest-dlq` (#24 owns what happens there).
 * - Messages are processed sequentially within a batch. Batches are small
 *   (max 10) and the work is per-review; ordering is deterministic and a
 *   failure never affects a sibling's ack/retry decision.
 */

import {
  createWorkersAiSentimentClassifier,
  FakeSentimentClassifier,
  type SentimentClassifier,
} from "@proofql/ai";
import { type IngestMessage, ingestMessageSchema } from "@proofql/core";
import { createDb } from "@proofql/db";

import type { PipelineBindings } from "./bindings.js";
import {
  type IndexContext,
  type IndexOutcome,
  indexReview,
} from "./index-review.js";
import { log as defaultLog, errorFields } from "./log.js";

/** The subset of a Queues `Message` the handler reads and decides on. */
export interface QueueMessage {
  readonly id: string;
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(): void;
}

/** The subset of `MessageBatch` the handler touches. */
export interface QueueBatch {
  readonly queue: string;
  readonly messages: readonly QueueMessage[];
}

export type QueueContext = IndexContext;

export interface QueueHandlerOptions {
  /** The per-message indexer; tests substitute a fake. */
  index?: (ctx: QueueContext, message: IngestMessage) => Promise<IndexOutcome>;
}

/** Consume one batch: parse, index, ack or retry — per message, in order. */
export async function handleQueueBatch(
  batch: QueueBatch,
  ctx: QueueContext,
  options: QueueHandlerOptions = {},
): Promise<void> {
  const log = ctx.log ?? defaultLog;
  const index = options.index ?? indexReview;

  for (const message of batch.messages) {
    const base = {
      queue: batch.queue,
      messageId: message.id,
      attempts: message.attempts,
    };

    const parsed = ingestMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      log("ingest.message.invalid", {
        ...base,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      message.ack();
      continue;
    }

    try {
      const outcome = await index(ctx, parsed.data);
      log("ingest.message.processed", { ...base, ...outcome });
      message.ack();
    } catch (error) {
      log("ingest.message.failed", {
        ...base,
        reviewId: parsed.data.reviewId,
        error: errorFields(error),
      });
      message.retry();
    }
  }
}

/**
 * Workers AI when bound (preview/prod), the deterministic fake otherwise
 * (local dev and CI have no `AI` binding — infra/environments.md).
 */
export function createClassifier(
  env: Pick<PipelineBindings, "AI">,
): SentimentClassifier {
  return env.AI
    ? createWorkersAiSentimentClassifier(env.AI)
    : new FakeSentimentClassifier();
}

/**
 * Wire a batch's dependencies from the worker `env`: a fresh database client
 * (per invocation, as Hyperdrive wants) and the classifier. The caller must
 * `close()` once the batch is handled so the isolate does not leak sockets.
 */
export function createQueueContext(env: PipelineBindings): {
  ctx: QueueContext;
  close(): Promise<void>;
} {
  const { db, sql } = createDb(env.HYPERDRIVE.connectionString);
  return {
    ctx: { db, classifier: createClassifier(env) },
    close: () => sql.end(),
  };
}

/** `GET /health` → `{ ok: true }`; everything else 404. */
export function handleFetch(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/health") {
    return Response.json({ ok: true });
  }
  return new Response("Not found", { status: 404 });
}
