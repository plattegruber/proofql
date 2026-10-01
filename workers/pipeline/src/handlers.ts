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
 *   → `retry({ delaySeconds })` with exponential backoff
 *   (`retryDelaySeconds`); after `max_retries` (3) Queues moves the message
 *   to `proofql-ingest-dlq`, which nothing consumes yet (#72 re-enqueues
 *   stuck reviews from the database instead). Every failure retries, on
 *   purpose: a database or Workers AI outage is transient, and a persistent
 *   provider fault (`EmbeddingDimensionError` from a model swap,
 *   `AiResponseError` from a binding drift) is exactly what the DLQ is for —
 *   three attempts spread over a few minutes, then it is parked with its
 *   error logged, never silently acked.
 * - Messages are processed sequentially within a batch. Batches are small
 *   (max 10) and the work is per-review; ordering is deterministic and a
 *   failure never affects a sibling's ack/retry decision.
 */

import {
  createWorkersAiEmbedder,
  createWorkersAiSentimentClassifier,
  type EmbeddingProvider,
  FakeEmbeddingProvider,
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
  retry(options?: { delaySeconds?: number }): void;
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
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}

/** First retry after 30s; doubles per attempt; never more than five minutes. */
export const RETRY_BASE_DELAY_SECONDS = 30;
export const RETRY_MAX_DELAY_SECONDS = 300;

/**
 * Exponential backoff for `message.retry()`: 30s, 60s, 120s, ... capped at
 * five minutes. `attempts` is the queue's 1-based count including the
 * current delivery. Static `retry_delay` in wrangler.jsonc is the floor
 * Queues applies when a retry carries no explicit delay.
 */
export function retryDelaySeconds(attempts: number): number {
  const exponent = Math.max(0, Math.floor(attempts) - 1);
  return Math.min(
    RETRY_MAX_DELAY_SECONDS,
    RETRY_BASE_DELAY_SECONDS * 2 ** exponent,
  );
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
 * bge-m3 over Workers AI when bound (preview/prod). Locally — and only
 * locally — the deterministic fake stands in, since there is no AI
 * simulator (infra/environments.md). Anywhere else a missing binding is a
 * deployment bug: fail the batch (it retries, then DLQs) rather than index
 * real reviews with fake vectors. Same rule as workers/api/src/embedder.ts.
 */
export function createEmbedder(
  env: Pick<PipelineBindings, "AI" | "ENVIRONMENT">,
): EmbeddingProvider {
  if (env.AI) return createWorkersAiEmbedder(env.AI);
  if (env.ENVIRONMENT === "local") return new FakeEmbeddingProvider();
  throw new Error(
    `AI binding is not bound in environment "${env.ENVIRONMENT}" — add it to wrangler.jsonc (infra/environments.md)`,
  );
}

/**
 * Wire a batch's dependencies from the worker `env`: a fresh database client
 * (per invocation, as Hyperdrive wants), the classifier, the embedder (once
 * per batch, shared by every message in it), and the KV cache. The caller
 * must `close()` once the batch is handled so the isolate does not leak
 * sockets.
 */
export function createQueueContext(env: PipelineBindings): {
  ctx: QueueContext;
  close(): Promise<void>;
} {
  const { db, sql } = createDb(env.HYPERDRIVE.connectionString);
  return {
    ctx: {
      db,
      classifier: createClassifier(env),
      embedder: createEmbedder(env),
      cache: env.CACHE,
    },
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
