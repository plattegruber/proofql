/**
 * Pipeline handlers, kept out of the wrangler entrypoint (src/worker.ts) so
 * unit tests can call them under Node with hand-built batches.
 *
 * Cron contract (`triggers.crons`, every five minutes): `handleScheduled`
 * runs the re-enqueue sweep (src/sweep.ts) for reviews stuck unindexed.
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
 *
 * Logging (#30; docs/observability.md): the batch's logger is the worker's
 * base logger (`@proofql/core` `createLogger`, service `pipeline`). Every
 * message gets a child bound to `queue`, `message_id`, `attempt`, and —
 * once the body parses — `review_id`, `project_id`, `environment`, so the
 * `review.indexed` line the indexer emits and the `ingest.message.*`
 * decision here share those fields without passing them around. Filtering
 * on one `message_id` shows one delivery end to end.
 */

import {
  createWorkersAiEmbedder,
  createWorkersAiSentimentClassifier,
  type EmbeddingProvider,
  FakeEmbeddingProvider,
  FakeSentimentClassifier,
  type SentimentClassifier,
} from "@proofql/ai";
import {
  createLogger,
  type IngestMessage,
  ingestMessageSchema,
  type Logger,
} from "@proofql/core";
import { createDb } from "@proofql/db";

import type { PipelineBindings } from "./bindings.js";
import {
  type IndexContext,
  type IndexOutcome,
  indexReview,
} from "./index-review.js";
import { type SweepResult, sweepUnindexed } from "./sweep.js";

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
  const index = options.index ?? indexReview;

  for (const message of batch.messages) {
    const delivery = ctx.log.child({
      queue: batch.queue,
      message_id: message.id,
      attempt: message.attempts,
    });

    const parsed = ingestMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      delivery.log("ingest.message.invalid", {
        level: "warn",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      message.ack();
      continue;
    }

    const log = delivery.child({
      review_id: parsed.data.reviewId,
      project_id: parsed.data.projectId,
      environment: parsed.data.environment,
    });
    try {
      const outcome = await index({ ...ctx, log }, parsed.data);
      log.log("ingest.message.processed", outcomeFields(outcome));
      message.ack();
    } catch (error) {
      log.log("ingest.message.failed", { error });
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}

/** An outcome as snake_case log fields (`review_id` is already bound). */
function outcomeFields(outcome: IndexOutcome): Record<string, unknown> {
  if (outcome.status === "skipped") {
    return { status: outcome.status, reason: outcome.reason };
  }
  return {
    status: outcome.status,
    chunks: outcome.chunks,
    windows: outcome.windows,
    embedded: outcome.embedded,
    newly_indexed: outcome.newlyIndexed,
    sentiment: outcome.sentiment,
    sentiment_source: outcome.sentimentSource,
  };
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
 * distilbert over Workers AI when bound (preview/prod). Locally — and only
 * locally — the deterministic fake stands in (#81: the same rule as
 * `createEmbedder`, for the same reason). The classifier only decides the
 * sentiment of *unrated* reviews, so a fake in production would be quieter
 * than fake vectors — but it would still publish or hide real reviews on a
 * lexicon's say-so, silently, which is exactly the kind of drift a missing
 * binding must not be allowed to cause.
 */
export function createClassifier(
  env: Pick<PipelineBindings, "AI" | "ENVIRONMENT">,
): SentimentClassifier {
  if (env.AI) return createWorkersAiSentimentClassifier(env.AI);
  if (env.ENVIRONMENT === "local") return new FakeSentimentClassifier();
  throw missingAiBinding(env.ENVIRONMENT);
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
  throw missingAiBinding(env.ENVIRONMENT);
}

function missingAiBinding(environment: string): Error {
  return new Error(
    `AI binding is not bound in environment "${environment}" — add it to wrangler.jsonc (infra/environments.md)`,
  );
}

/** The worker's base logger for an invocation. */
export function createPipelineLogger(
  env: Pick<PipelineBindings, "ENVIRONMENT">,
): Logger {
  return createLogger({ service: "pipeline", environment: env.ENVIRONMENT });
}

/**
 * Wire a batch's dependencies from the worker `env`: a fresh database client
 * (per invocation, as Hyperdrive wants), the classifier, the embedder (once
 * per batch, shared by every message in it), the KV cache, and the logger.
 * The caller must `close()` once the batch is handled so the isolate does
 * not leak sockets.
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
      log: createPipelineLogger(env),
    },
    close: () => sql.end(),
  };
}

/** Cron sweep tuning (#72): reviews unindexed for 5+ minutes, 500 per tick. */
export const SWEEP_OLDER_THAN_MINUTES = 5;
export const SWEEP_LIMIT = 500;

/**
 * One cron tick (`triggers.crons` in wrangler.jsonc): re-enqueue reviews
 * stuck with `indexed_at IS NULL`. Opens its own database client, as the
 * queue handler does, and closes it when the sweep is done.
 */
export async function handleScheduled(
  env: Pick<PipelineBindings, "HYPERDRIVE" | "INGEST_QUEUE" | "ENVIRONMENT">,
): Promise<SweepResult> {
  const { db, sql } = createDb(env.HYPERDRIVE.connectionString);
  try {
    return await sweepUnindexed(
      {
        db,
        queue: env.INGEST_QUEUE,
        log: createPipelineLogger(env).child({ trigger: "cron" }),
      },
      { olderThanMinutes: SWEEP_OLDER_THAN_MINUTES, limit: SWEEP_LIMIT },
    );
  } finally {
    await sql.end();
  }
}

/** `GET /health` → `{ ok: true }`; everything else 404. */
export function handleFetch(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/health") {
    return Response.json({ ok: true });
  }
  return new Response("Not found", { status: 404 });
}
