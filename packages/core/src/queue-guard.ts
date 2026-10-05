/**
 * Enqueueing after a commit must never fail the write it follows (#159).
 *
 * On the Workers Free plan Queues allows 10,000 operations a day (each
 * indexed review costs 3: write, read, delete), and once they are spent
 * every `send()`/`sendBatch()` throws until 00:00 UTC. workerd formats the
 * error as `Queue sendBatch failed: <status text>` (`Queue send failed: …`
 * for `send`), and the status text of Queues error 10253
 * (`FreeTierLimitExceeded`, developers.cloudflare.com/queues/reference/
 * error-codes) is `Free tier limit exceeded`, so the producer sees
 *
 *   Error: Queue sendBatch failed: Free tier limit exceeded
 *
 * Every ingest path (the api's `POST /v1/reviews`, the dashboard's CSV and
 * Places imports) writes its rows first, with `indexed_at` null, and then
 * enqueues one message per review to index. When that send throws, the
 * rows are already committed and the pipeline's five-minute sweep
 * (workers/pipeline/src/sweep.ts) re-enqueues every review that stays
 * unindexed, so the caller reports "indexing deferred" instead of an
 * error. `enqueueOrDefer` is that rule in one place:
 *
 *   quota.exhausted          error  the message is the daily-limit error
 *                                   (`resource: "queues"`, `retry_after`
 *                                   and `renews_at` = the next 00:00 UTC)
 *   ingest.enqueue_deferred  warn   any other send failure
 *
 * Both carry `site` (which caller), `messages` (how many were not sent)
 * and `error`. docs/observability.md has the catalogue entries.
 */

import { errorMessages } from "./kv-guard.js";
import type { Logger } from "./log.js";
import type { IngestMessage } from "./queue.js";

/** The status text of Queues error 10253 (`FreeTierLimitExceeded`). */
export const QUEUE_LIMIT_PATTERN = /\bFree tier limit exceeded\b/i;

/** Whether `error` (or a cause) is the Queues daily-limit error. */
export function isQueueLimitError(error: unknown): boolean {
  return errorMessages(error).some((m) => QUEUE_LIMIT_PATTERN.test(m));
}

/** The next 00:00 UTC strictly after `now`, when the daily allowances reset. */
export function nextUtcMidnight(now: number = Date.now()): Date {
  const d = new Date(now);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1),
  );
}

/** The producer surface every ingest path has (`env.INGEST_QUEUE` fits). */
export interface IngestProducer {
  sendBatch(messages: Iterable<{ body: IngestMessage }>): Promise<unknown>;
}

export type EnqueueOutcome =
  /** Every message was sent (or there were none). */
  | { sent: true }
  /** The send threw; nothing was sent. `quota` when it was the daily limit. */
  | { sent: false; quota: boolean };

/**
 * Log one failed send of `count` messages from `site`: `quota.exhausted`
 * (error) for the daily limit, `ingest.enqueue_deferred` (warn) otherwise.
 * Returns whether it was the quota.
 */
export function logEnqueueFailure(
  log: Logger | undefined,
  site: string,
  count: number,
  error: unknown,
  now: number = Date.now(),
): boolean {
  if (isQueueLimitError(error)) {
    const renews = nextUtcMidnight(now);
    log?.log("quota.exhausted", {
      level: "error",
      resource: "queues",
      site,
      messages: count,
      retry_after: Math.max(1, Math.ceil((renews.getTime() - now) / 1000)),
      renews_at: renews.toISOString(),
      error,
    });
    return true;
  }
  log?.log("ingest.enqueue_deferred", {
    level: "warn",
    site,
    messages: count,
    error,
  });
  return false;
}

/**
 * Send `messages` in one `sendBatch` (callers keep batches within the
 * 100-message limit). A throwing send is logged and reported, never
 * rethrown: the rows behind the messages are committed and the sweep will
 * index them.
 */
export async function enqueueOrDefer(
  queue: IngestProducer,
  messages: readonly IngestMessage[],
  options: { log?: Logger | undefined; site: string },
): Promise<EnqueueOutcome> {
  if (messages.length === 0) return { sent: true };
  try {
    await queue.sendBatch(messages.map((body) => ({ body })));
    return { sent: true };
  } catch (error) {
    const quota = logEnqueueFailure(
      options.log,
      options.site,
      messages.length,
      error,
    );
    return { sent: false, quota };
  }
}
