/**
 * Re-enqueue sweep for reviews stuck with `indexed_at IS NULL` (#72).
 *
 * The api enqueues an `IngestMessage` after its ingest transaction commits.
 * If that `sendBatch` fails, or a message exhausts its retries into the
 * DLQ, the row sits unindexed and nothing will ever re-send it: a repeat
 * ingest with identical text is a no-op by design. This sweep, run from the
 * cron trigger in wrangler.jsonc every five minutes, is the safety net: it
 * finds reviews that have been unindexed for longer than `olderThanMinutes`
 * (so a review the consumer is about to pick up is left alone), oldest
 * first, up to `limit` per tick, and puts them back on the queue in
 * `sendBatch` calls of at most {@link QUEUE_SEND_BATCH_MAX} messages.
 *
 * Hammering guard: every re-send increments `reviews.index_attempts`, and a
 * review that has been swept `maxAttempts` times is skipped — logged once
 * per tick at warn with its id, not re-sent — so a review the pipeline can
 * never index is not DLQ'd again every five minutes forever. A successful
 * index resets the counter to 0 (src/embed-chunks.ts). Exhausted reviews
 * are excluded from the candidate query rather than merely skipped, so
 * they can never crowd fresh ones out of the per-tick `limit`.
 *
 * The counter is incremented before each `sendBatch`, for that batch only:
 * if the queue is down, each tick still burns one attempt per review it
 * tried to send, so even a prolonged outage cannot make a review's re-sends
 * unbounded. Reviews in later batches that were never tried keep their
 * count. The handler receives the whole batch of ids it enqueued as one
 * structured log line.
 *
 * The exception is the Workers Free plan's daily Queues limit (#159;
 * `isQueueLimitError` in @proofql/core). It is not the review's fault, and
 * burning an attempt on every tick until 00:00 UTC would push reviews to
 * the cap before the quota resets. On that error the sweep gives the
 * failed batch its attempt back, stops (every further send would fail the
 * same way), logs `quota.exhausted` with `resource: "queues"` once, and
 * reports the unsent reviews as `deferred`. The first tick after the reset
 * sends them.
 */

import {
  type IngestMessage,
  isQueueLimitError,
  type Logger,
  logEnqueueFailure,
} from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { and, asc, inArray, isNull, lt, sql } from "drizzle-orm";

const { reviews } = schema;

/** Queues accepts at most 100 messages per `sendBatch`. */
export const QUEUE_SEND_BATCH_MAX = 100;

/** The producer surface the sweep needs; `env.INGEST_QUEUE` fits. */
export interface IngestQueue {
  sendBatch(messages: Iterable<{ body: IngestMessage }>): Promise<unknown>;
}

export interface SweepContext {
  db: Db;
  queue: IngestQueue;
  log: Logger;
}

export interface SweepOptions {
  /** Only reviews whose `updated_at` is older than this many minutes. */
  olderThanMinutes: number;
  /** Most reviews re-enqueued in one tick. */
  limit: number;
  /** Sweeps per review before it is left alone (default 5). */
  maxAttempts?: number;
}

export interface SweepResult {
  /** Reviews found stuck and re-enqueued this tick. */
  enqueued: number;
  /**
   * Stuck reviews not sent because the Queues daily limit was reached; their
   * attempt counters are unchanged.
   */
  deferred: number;
  /** Stuck reviews skipped because they have hit `maxAttempts`. */
  exhausted: number;
  /** `sendBatch` calls made. */
  batches: number;
}

export const DEFAULT_MAX_INDEX_ATTEMPTS = 5;

/** One cron tick: find stuck reviews, bump their attempt counters, re-enqueue. */
export async function sweepUnindexed(
  ctx: SweepContext,
  options: SweepOptions,
): Promise<SweepResult> {
  const { log } = ctx;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_INDEX_ATTEMPTS;
  const cutoff = sql`now() - make_interval(mins => ${options.olderThanMinutes})`;
  const stuck = and(
    isNull(reviews.indexedAt),
    isNull(reviews.hiddenAt),
    lt(reviews.updatedAt, cutoff),
  );

  const candidates = await ctx.db
    .select({
      id: reviews.id,
      projectId: reviews.projectId,
      environment: reviews.environment,
      indexAttempts: reviews.indexAttempts,
    })
    .from(reviews)
    .where(and(stuck, lt(reviews.indexAttempts, maxAttempts)))
    .orderBy(asc(reviews.updatedAt))
    .limit(options.limit);

  const exhausted = await ctx.db
    .select({ id: reviews.id, indexAttempts: reviews.indexAttempts })
    .from(reviews)
    .where(and(stuck, sql`${reviews.indexAttempts} >= ${maxAttempts}`))
    .orderBy(asc(reviews.updatedAt))
    .limit(options.limit);
  if (exhausted.length > 0) {
    log.log("sweep.exhausted", {
      level: "warn",
      max_attempts: maxAttempts,
      count: exhausted.length,
      review_ids: exhausted.map((r) => r.id),
    });
  }

  let batches = 0;
  const sent: string[] = [];
  let deferred = 0;
  const plan = chunked(candidates, QUEUE_SEND_BATCH_MAX);
  for (const [index, rows] of plan.entries()) {
    const ids = rows.map((r) => r.id);
    const batch: IngestMessage[] = rows.map((r) => ({
      type: "review.index",
      reviewId: r.id,
      projectId: r.projectId,
      environment: r.environment,
    }));
    await ctx.db
      .update(reviews)
      .set({ indexAttempts: sql`${reviews.indexAttempts} + 1` })
      .where(inArray(reviews.id, ids));
    try {
      await ctx.queue.sendBatch(batch.map((body) => ({ body })));
    } catch (error) {
      if (!isQueueLimitError(error)) throw error;
      // Not the reviews' fault: hand the attempt back and stop (module doc).
      await ctx.db
        .update(reviews)
        .set({
          indexAttempts: sql`greatest(${reviews.indexAttempts} - 1, 0)`,
        })
        .where(inArray(reviews.id, ids));
      deferred = plan.slice(index).reduce((n, b) => n + b.length, 0);
      logEnqueueFailure(log, "pipeline.sweep", deferred, error);
      break;
    }
    batches += 1;
    sent.push(...ids);
  }

  log.log("sweep.completed", {
    older_than_minutes: options.olderThanMinutes,
    limit: options.limit,
    enqueued: sent.length,
    deferred,
    exhausted: exhausted.length,
    batches,
    review_ids: sent,
  });
  return {
    enqueued: sent.length,
    deferred,
    exhausted: exhausted.length,
    batches,
  };
}

/** Split `items` into consecutive slices of at most `size`. */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}
