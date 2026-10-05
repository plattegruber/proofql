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

/** Queues accepts at most 100 messages per `sendBatch`. */
export const ENQUEUE_BATCH_MAX = 100;

/**
 * Sends for one unit of work that enqueues after several commits (a
 * pipeline cron tick, #162). Every call goes through
 * {@link enqueueOrDefer}, in batches of at most {@link ENQUEUE_BATCH_MAX},
 * so a refused send never throws. After the first daily-limit error the
 * session stops calling the queue: every later send would fail the same
 * way until 00:00 UTC, so it counts the messages as deferred instead, as
 * the sweep and the CSV import do. A non-quota failure defers only that
 * batch; the next one is still tried.
 */
export interface EnqueueSession {
  /** Send `messages`; returns how many were sent. Never throws. */
  send(
    messages: readonly IngestMessage[],
    options?: { log?: Logger | undefined },
  ): Promise<number>;
  /** Messages not sent so far; the sweep indexes their reviews later. */
  readonly deferred: number;
  /** The daily limit was hit; nothing more is sent this session. */
  readonly exhausted: boolean;
}

export function createEnqueueSession(
  queue: IngestProducer,
  options: { log?: Logger | undefined; site: string },
): EnqueueSession {
  let deferred = 0;
  let exhausted = false;
  return {
    get deferred() {
      return deferred;
    },
    get exhausted() {
      return exhausted;
    },
    async send(messages, call = {}) {
      let sent = 0;
      for (let at = 0; at < messages.length; at += ENQUEUE_BATCH_MAX) {
        const batch = messages.slice(at, at + ENQUEUE_BATCH_MAX);
        if (exhausted) {
          deferred += batch.length;
          continue;
        }
        const outcome = await enqueueOrDefer(queue, batch, {
          log: call.log ?? options.log,
          site: options.site,
        });
        if (outcome.sent) {
          sent += batch.length;
        } else {
          deferred += batch.length;
          if (outcome.quota) exhausted = true;
        }
      }
      return sent;
    },
  };
}
