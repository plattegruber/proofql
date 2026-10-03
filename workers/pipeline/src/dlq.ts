/**
 * Dead-letter consumer for `proofql-ingest-dlq` (#82).
 *
 * Queues moves an `IngestMessage` here after the ingest consumer
 * (src/handlers.ts) has retried it `max_retries` times. Nothing about the
 * message is recoverable from this side — the sweep (src/sweep.ts) already
 * re-enqueues stuck reviews from the database — so this consumer is
 * observability, not recovery: it leaves a durable, human-readable record
 * of the give-up where the dashboard reads import health, and it tells the
 * sweep to stop.
 *
 * Per message, in order:
 *
 * 1. Parse with `ingestMessageSchema`. Garbage is logged
 *    (`ingest.dlq.unparseable`) and acked: a body the ingest consumer could
 *    not parse was acked there too, so one only arrives here if the wire
 *    shape changed between the two consumers.
 * 2. Insert one `ingest_runs` row: `kind: "api"`, `status: "failed"`,
 *    `received: 1`, `failed: 1`, `error: index.dead_lettered: review <id>
 *    exhausted <attempts> queue retries`, started and finished now. `kind`
 *    is `api` because that is what produced the review this message is
 *    about (the push API, or the sweep re-sending a push-API review); a
 *    dedicated `index` kind would be more honest but changes the enum, so
 *    it is a follow-up, not this consumer's call.
 * 3. Set `reviews.index_attempts` to at least {@link DEFAULT_MAX_INDEX_ATTEMPTS}
 *    (`GREATEST`, never lowering it), so the sweep's hammering guard treats
 *    the review as exhausted and stops re-sending a message the queue has
 *    already given up on. A review that is gone (deleted, or never
 *    committed) updates nothing; the `ingest_runs` row is still written,
 *    keyed on the message's `projectId`.
 * 4. Log `ingest.dlq.recorded` and ack.
 *
 * Every message is acked, including one whose database write threw
 * (`ingest.dlq.failed`): the consumer runs with `max_retries: 0` and no
 * further dead-letter queue (wrangler.jsonc), so a retry would only drop the
 * message a second time, silently. The log line is the record of last
 * resort.
 *
 * `attempts` in the error text is the delivery count Queues reports on the
 * dead-lettered message. Should the platform reset it on the way into the
 * DLQ, the string under-counts; the log line carries the same number as
 * `attempt` so the two can be compared in one place.
 */

import { ingestMessageSchema, type Logger } from "@proofql/core";
import { createDb, type Db, schema } from "@proofql/db";
import { eq, sql } from "drizzle-orm";

import type { PipelineBindings } from "./bindings.js";
import type { QueueBatch } from "./handlers.js";
import { DEFAULT_MAX_INDEX_ATTEMPTS } from "./sweep.js";

const { ingestRuns, reviews } = schema;

export interface DeadLetterContext {
  db: Db;
  log: Logger;
}

/**
 * Whether `queue` is a dead-letter queue of the ingest pipeline. The names
 * are `proofql-ingest-dlq` locally and `proofql-ingest-dlq-<env>` deployed
 * (wrangler.jsonc, infra/environments.md): the `dlq` segment is the marker,
 * wherever the environment suffix puts it. Matching on the segment keeps
 * the worker free of a per-environment queue-name variable.
 */
export function isDeadLetterQueue(queue: string): boolean {
  return /(^|-)dlq(-|$)/.test(queue);
}

/** The `ingest_runs.error` text for a dead-lettered index message. */
export function deadLetterError(reviewId: string, attempts: number): string {
  return `index.dead_lettered: review ${reviewId} exhausted ${attempts} queue retries`;
}

/** Consume one DLQ batch: record every message, ack every message. */
export async function handleDeadLetters(
  ctx: DeadLetterContext,
  batch: QueueBatch,
): Promise<void> {
  for (const message of batch.messages) {
    const delivery = ctx.log.child({
      queue: batch.queue,
      message_id: message.id,
      attempt: message.attempts,
    });

    const parsed = ingestMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      delivery.log("ingest.dlq.unparseable", {
        level: "warn",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      message.ack();
      continue;
    }

    if (parsed.data.type !== "review.index") {
      // A `connection.sync` that exhausted its retries: the cron picks the
      // connection up again within six hours, so there is nothing to record.
      delivery.log("ingest.dlq.skipped", {
        level: "warn",
        type: parsed.data.type,
        connection_id: parsed.data.connectionId,
        project_id: parsed.data.projectId,
      });
      message.ack();
      continue;
    }
    const { reviewId, projectId, environment } = parsed.data;
    const log = delivery.child({
      review_id: reviewId,
      project_id: projectId,
      environment,
    });
    try {
      const now = new Date();
      await ctx.db.insert(ingestRuns).values({
        projectId,
        environment,
        kind: "api",
        status: "failed",
        received: 1,
        failed: 1,
        error: deadLetterError(reviewId, message.attempts),
        startedAt: now,
        finishedAt: now,
      });
      const exhausted = await ctx.db
        .update(reviews)
        .set({
          indexAttempts: sql`greatest(${reviews.indexAttempts}, ${DEFAULT_MAX_INDEX_ATTEMPTS})`,
        })
        .where(eq(reviews.id, reviewId))
        .returning({ id: reviews.id });
      log.log("ingest.dlq.recorded", {
        review_found: exhausted.length > 0,
        max_attempts: DEFAULT_MAX_INDEX_ATTEMPTS,
      });
    } catch (error) {
      log.log("ingest.dlq.failed", { error });
    }
    message.ack();
  }
}

/**
 * Wire a DLQ batch's dependencies from the worker `env`: a fresh database
 * client and the logger. No embedder, classifier, or cache — this consumer
 * never indexes. The caller must `close()` once the batch is handled.
 */
export function createDeadLetterContext(
  env: Pick<PipelineBindings, "HYPERDRIVE" | "ENVIRONMENT">,
  log: Logger,
): { ctx: DeadLetterContext; close(): Promise<void> } {
  const { db, sql } = createDb(env.HYPERDRIVE.connectionString);
  return { ctx: { db, log }, close: () => sql.end() };
}
