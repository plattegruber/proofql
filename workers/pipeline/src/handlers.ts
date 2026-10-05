/**
 * Pipeline handlers, kept out of the wrangler entrypoint (src/worker.ts) so
 * unit tests can call them under Node with hand-built batches.
 *
 * Cron contract (`triggers.crons`): `handleScheduled` routes on the cron
 * expression the runtime reports — the five-minute cron runs the re-enqueue
 * sweep (src/sweep.ts) for reviews stuck unindexed, the six-hourly one
 * polls every Google connection (src/google-poll.ts, #46), the daily one
 * at 03:30 UTC refreshes Places-bootstrapped reviews older than 25 days
 * (src/places-refresh.ts, #116).
 *
 * Queue consumer contract (`proofql-ingest`, wrangler.jsonc):
 *
 * - Every body is validated with `ingestMessageSchema` first. A body that
 *   does not parse is **acknowledged** and logged, never retried: garbage
 *   does not become valid on redelivery, and retrying it would only park
 *   it in the DLQ three attempts later.
 * - A valid `review.index` runs `indexReview`; a valid `connection.sync`
 *   (#46) polls that one Google connection at once (`pollGoogleConnections`
 *   with `connectionIds`), so a freshly mapped location is imported in
 *   seconds rather than at the next six-hourly tick. Success → `ack()`. Any thrown error
 *   → `retry({ delaySeconds })` with exponential backoff
 *   (`retryDelaySeconds`); after `max_retries` (3) Queues moves the message
 *   to `proofql-ingest-dlq`, where `handleDeadLetters` (src/dlq.ts, #82)
 *   records the give-up in `ingest_runs` — #72's sweep re-enqueues stuck
 *   reviews from the database, so that is observability, not recovery.
 *   Every failure retries, on
 *   purpose: a database or Workers AI outage is transient, and a persistent
 *   provider fault (`EmbeddingDimensionError` from a model swap,
 *   `AiResponseError` from a binding drift) is exactly what the DLQ is for —
 *   three attempts spread over a few minutes, then it is parked with its
 *   error logged, never silently acked.
 * - Messages are processed sequentially within a batch. Batches are small
 *   (max 10) and the work is per-review; ordering is deterministic and a
 *   failure never affects a sibling's ack/retry decision.
 *
 * One Worker, two queues: wrangler.jsonc attaches this worker as the
 * consumer of both `proofql-ingest[-<env>]` and `proofql-ingest-dlq[-<env>]`,
 * and the runtime calls the one `queue()` export for either. `handleQueue`
 * routes on `batch.queue` — `isDeadLetterQueue` matches the `dlq` name
 * segment, so no per-environment queue-name variable is needed — and
 * builds the context each consumer wants: the ingest side gets the
 * indexer's full context (db, AI, KV), the DLQ side only a db and a logger.
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
  type CoalescedGenerations,
  coalesceGenerationBumps,
  createLogger,
  type IngestMessage,
  ingestMessageSchema,
  kvFaults,
  type Logger,
} from "@proofql/core";
import { createDb } from "@proofql/db";

import type { PipelineBindings } from "./bindings.js";
import {
  createDeadLetterContext,
  handleDeadLetters,
  isDeadLetterQueue,
} from "./dlq.js";
import {
  type GooglePollEnv,
  type GooglePollResult,
  pollGoogleConnections,
} from "./google-poll.js";
import {
  type IndexContext,
  type IndexOutcome,
  indexReview,
} from "./index-review.js";
import {
  PLACES_REFRESH_CRON,
  type PlacesRefreshResult,
  refreshPlacesBootstraps,
} from "./places-refresh.js";
import { type IngestQueue, type SweepResult, sweepUnindexed } from "./sweep.js";

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

/**
 * The indexer's context plus what a `connection.sync` needs: the queue
 * (the poller enqueues the reviews it imports) and the connector's env.
 */
export type QueueContext = IndexContext & {
  queue: IngestQueue;
  env: GooglePollEnv;
};

export interface QueueHandlerOptions {
  /** The per-message indexer; tests substitute a fake. */
  index?: (
    ctx: QueueContext,
    message: Extract<IngestMessage, { type: "review.index" }>,
  ) => Promise<IndexOutcome>;
  /** The per-message connection sync; tests substitute a fake. */
  sync?: (
    ctx: QueueContext,
    message: Extract<IngestMessage, { type: "connection.sync" }>,
  ) => Promise<GooglePollResult>;
}

/** `connection.sync` → poll exactly that connection now. */
export async function syncConnectionNow(
  ctx: QueueContext,
  message: Extract<IngestMessage, { type: "connection.sync" }>,
): Promise<GooglePollResult> {
  return pollGoogleConnections(
    {
      db: ctx.db,
      queue: ctx.queue,
      log: ctx.log,
      env: ctx.env,
      cache: ctx.cache,
    },
    { connectionIds: [message.connectionId], trigger: "queue" },
  );
}

/** Consume one batch: parse, index, ack or retry — per message, in order. */
export async function handleQueueBatch(
  batch: QueueBatch,
  outer: QueueContext,
  options: QueueHandlerOptions = {},
): Promise<void> {
  const index = options.index ?? indexReview;
  const sync = options.sync ?? syncConnectionNow;
  // One generation bump per project per batch, not per review (#158): the
  // free plan's KV allows 1,000 writes a day, and a 10-message batch of one
  // project's import used to spend ten. Written once the batch is done.
  const bumps = coalesceGenerationBumps(outer.cache);
  const ctx: QueueContext = { ...outer, cache: bumps.kv };
  try {
    await handleMessages(batch, ctx, index, sync);
  } finally {
    await flushGenerationBumps(bumps, outer.log);
  }
}

/** Write a batch's held bumps; a KV failure is logged, never thrown (#158). */
export async function flushGenerationBumps(
  bumps: CoalescedGenerations,
  log: Logger,
): Promise<void> {
  if (bumps.pending.length === 0) return;
  try {
    const written = await bumps.flush();
    log.log("cache.generation_bumped", {
      projects: written.length,
    });
  } catch (error) {
    kvFaults.report(log, "put", "pipeline.generation_bump", error);
  }
}

async function handleMessages(
  batch: QueueBatch,
  ctx: QueueContext,
  index: NonNullable<QueueHandlerOptions["index"]>,
  sync: NonNullable<QueueHandlerOptions["sync"]>,
): Promise<void> {
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

    if (parsed.data.type === "connection.sync") {
      const log = delivery.child({
        connection_id: parsed.data.connectionId,
        project_id: parsed.data.projectId,
      });
      try {
        const result = await sync({ ...ctx, log }, parsed.data);
        log.log("ingest.message.processed", {
          status: "synced",
          connections: result.connections,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
          rate_limited: result.rateLimited,
        });
        message.ack();
      } catch (error) {
        log.log("ingest.message.failed", { error });
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
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
      queue: env.INGEST_QUEUE,
      env,
    },
    close: () => sql.end(),
  };
}

/** The two consumers one `queue()` invocation can dispatch to. */
export interface QueueConsumers {
  /** `proofql-ingest[-<env>]`: index reviews. */
  ingest: (batch: QueueBatch, env: PipelineBindings) => Promise<void>;
  /** `proofql-ingest-dlq[-<env>]`: record give-ups (src/dlq.ts). */
  deadLetters: (batch: QueueBatch, env: PipelineBindings) => Promise<void>;
}

/** Index one `proofql-ingest` batch with a context built from `env`. */
export async function consumeIngestBatch(
  batch: QueueBatch,
  env: PipelineBindings,
): Promise<void> {
  const { ctx, close } = createQueueContext(env);
  try {
    await handleQueueBatch(batch, ctx);
  } finally {
    await close();
  }
}

/** Record one `proofql-ingest-dlq` batch with a context built from `env`. */
export async function consumeDeadLetterBatch(
  batch: QueueBatch,
  env: PipelineBindings,
): Promise<void> {
  const { ctx, close } = createDeadLetterContext(
    env,
    createPipelineLogger(env),
  );
  try {
    await handleDeadLetters(ctx, batch);
  } finally {
    await close();
  }
}

const defaultConsumers: QueueConsumers = {
  ingest: consumeIngestBatch,
  deadLetters: consumeDeadLetterBatch,
};

/**
 * The worker's `queue()` body: route a batch to the consumer its queue name
 * selects. `consumers` is injectable so the routing is unit-testable
 * without a database.
 */
export async function handleQueue(
  batch: QueueBatch,
  env: PipelineBindings,
  consumers: QueueConsumers = defaultConsumers,
): Promise<void> {
  if (isDeadLetterQueue(batch.queue)) {
    await consumers.deadLetters(batch, env);
  } else {
    await consumers.ingest(batch, env);
  }
}

/** Cron sweep tuning (#72): reviews unindexed for 5+ minutes, 500 per tick. */
export const SWEEP_OLDER_THAN_MINUTES = 5;
export const SWEEP_LIMIT = 500;

/** The three cron expressions in wrangler.jsonc (all three env blocks). */
export const SWEEP_CRON = "*/5 * * * *";
export const GOOGLE_POLL_CRON = "0 */6 * * *";
export { PLACES_REFRESH_CRON };

export type ScheduledResult =
  | { job: "sweep"; result: SweepResult }
  | { job: "google_poll"; result: GooglePollResult }
  | { job: "places_refresh"; result: PlacesRefreshResult };

/**
 * Which job a cron expression runs. Anything that is neither the Google
 * poll nor the Places refresh is the sweep: it is the older, more important
 * job, and a typo in a cron expression should still re-enqueue stuck
 * reviews rather than silently do nothing.
 */
export function scheduledJob(cron: string | undefined): ScheduledResult["job"] {
  if (cron === GOOGLE_POLL_CRON) return "google_poll";
  if (cron === PLACES_REFRESH_CRON) return "places_refresh";
  return "sweep";
}

/**
 * One cron tick (`triggers.crons` in wrangler.jsonc), routed on the cron
 * expression (`controller.cron`): re-enqueue reviews stuck with
 * `indexed_at IS NULL`, poll every Google connection, or refresh the
 * Places bootstraps that are due. Opens its own database client, as the
 * queue handler does, and closes it when done.
 */
export async function handleScheduled(
  env: Omit<PipelineBindings, "AI">,
  cron: string | undefined,
): Promise<ScheduledResult> {
  const { db, sql } = createDb(env.HYPERDRIVE.connectionString);
  const log = createPipelineLogger(env).child({ trigger: "cron" });
  try {
    const job = scheduledJob(cron);
    if (job === "google_poll") {
      const result = await pollGoogleConnections(
        { db, queue: env.INGEST_QUEUE, log, env, cache: env.CACHE },
        { trigger: "cron" },
      );
      return { job: "google_poll", result };
    }
    if (job === "places_refresh") {
      const result = await refreshPlacesBootstraps({
        db,
        queue: env.INGEST_QUEUE,
        log,
        env,
        kv: env.CACHE,
      });
      return { job: "places_refresh", result };
    }
    const result = await sweepUnindexed(
      { db, queue: env.INGEST_QUEUE, log },
      { olderThanMinutes: SWEEP_OLDER_THAN_MINUTES, limit: SWEEP_LIMIT },
    );
    return { job: "sweep", result };
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
