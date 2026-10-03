/**
 * The DLQ consumer against the real schema: a dead-lettered `IngestMessage`
 * becomes one failed `ingest_runs` row, the review's `index_attempts` is
 * raised to the sweep's cap so the sweep leaves it alone, and every message
 * is acked whatever happened to it.
 */

import type { IngestMessage, ReviewIndexMessage } from "@proofql/core";
import { schema } from "@proofql/db";
import { project, review, setupTestDb } from "@proofql/db/test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { testLogger } from "../test/log.js";
import { deadLetterError, handleDeadLetters } from "./dlq.js";
import type { QueueMessage } from "./handlers.js";
import {
  DEFAULT_MAX_INDEX_ATTEMPTS,
  type IngestQueue,
  sweepUnindexed,
} from "./sweep.js";

const { ingestRuns, reviews } = schema;

const t = setupTestDb();

afterEach(async () => {
  await t.db.delete(reviews);
  await t.db.delete(ingestRuns);
});

const DLQ = "proofql-ingest-dlq";

/** A dead letter: by default on its fourth delivery (3 retries exhausted). */
function deadLetter(body: unknown, id = "dl1", attempts = 4): QueueMessage {
  return { id, body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function messageFor(r: {
  id: string;
  projectId: string;
  environment?: ReviewIndexMessage["environment"];
}): ReviewIndexMessage {
  return {
    type: "review.index",
    reviewId: r.id,
    projectId: r.projectId,
    environment: r.environment ?? "live",
  };
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

async function runsFor(projectId: string) {
  return t.db
    .select()
    .from(ingestRuns)
    .where(eq(ingestRuns.projectId, projectId))
    .orderBy(ingestRuns.startedAt);
}

async function attemptsOf(reviewId: string): Promise<number> {
  const [row] = await t.db
    .select({ indexAttempts: reviews.indexAttempts })
    .from(reviews)
    .where(eq(reviews.id, reviewId));
  if (!row) throw new Error(`review ${reviewId} vanished`);
  return row.indexAttempts;
}

class FakeQueue implements IngestQueue {
  readonly sent: IngestMessage[] = [];
  async sendBatch(messages: Iterable<{ body: IngestMessage }>): Promise<void> {
    for (const m of messages) this.sent.push(m.body);
  }
}

function run(messages: QueueMessage[]) {
  const { log, out } = testLogger();
  return {
    out,
    done: handleDeadLetters({ db: t.db, log }, { queue: DLQ, messages }),
  };
}

describe("handleDeadLetters", () => {
  it("records a dead-lettered review as a failed ingest run, caps its attempts, and the sweep then skips it", async () => {
    // Stuck for ten minutes with two sweeps behind it: a sweep candidate.
    const stuck = await review(t.db, {
      updatedAt: minutesAgo(10),
      indexAttempts: 2,
    });
    const message = deadLetter(messageFor(stuck), "dl1", 4);
    const before = new Date();

    const { out, done } = run([message]);
    await done;

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();

    const runs = await runsFor(stuck.projectId);
    expect(runs).toHaveLength(1);
    const [row] = runs;
    expect(row).toMatchObject({
      projectId: stuck.projectId,
      environment: "live",
      kind: "api",
      status: "failed",
      received: 1,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 1,
      error: `index.dead_lettered: review ${stuck.id} exhausted 4 queue retries`,
      artifactKey: null,
    });
    expect(row?.error).toBe(deadLetterError(stuck.id, 4));
    expect(row?.startedAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
    expect(row?.finishedAt).toEqual(row?.startedAt);

    expect(await attemptsOf(stuck.id)).toBe(DEFAULT_MAX_INDEX_ATTEMPTS);

    expect(out.only("ingest.dlq.recorded")).toMatchObject({
      service: "pipeline",
      level: "info",
      queue: DLQ,
      message_id: "dl1",
      attempt: 4,
      review_id: stuck.id,
      project_id: stuck.projectId,
      environment: "live",
      review_found: true,
      max_attempts: DEFAULT_MAX_INDEX_ATTEMPTS,
    });
    expect(out.find("ingest.dlq.failed")).toEqual([]);

    // The sweep now treats it as exhausted: warned about, not re-sent.
    const queue = new FakeQueue();
    const sweepLog = testLogger();
    const result = await sweepUnindexed(
      { db: t.db, queue, log: sweepLog.log },
      { olderThanMinutes: 5, limit: 500 },
    );
    expect(result).toEqual({ enqueued: 0, exhausted: 1, batches: 0 });
    expect(queue.sent).toEqual([]);
    expect(sweepLog.out.only("sweep.exhausted")).toMatchObject({
      review_ids: [stuck.id],
    });
  });

  it("never lowers index_attempts already above the cap", async () => {
    const r = await review(t.db, {
      indexAttempts: DEFAULT_MAX_INDEX_ATTEMPTS + 3,
    });

    await run([deadLetter(messageFor(r))]).done;

    expect(await attemptsOf(r.id)).toBe(DEFAULT_MAX_INDEX_ATTEMPTS + 3);
  });

  it("carries the message's environment onto the run row", async () => {
    const r = await review(t.db, { environment: "test" });

    await run([deadLetter(messageFor({ ...r, environment: "test" }))]).done;

    const [row] = await runsFor(r.projectId);
    expect(row).toMatchObject({ environment: "test", status: "failed" });
  });

  it("acks an unparseable message and writes no row", async () => {
    const p = await project(t.db);
    const messages = [
      deadLetter({ projectId: p.id, nonsense: true }, "dl0"),
      deadLetter("not even an object", "dl1"),
    ];

    const { out, done } = run(messages);
    await done;

    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect(await runsFor(p.id)).toEqual([]);
    expect(out.find("ingest.dlq.unparseable")).toHaveLength(2);
    expect(out.find("ingest.dlq.recorded")).toEqual([]);
  });

  it("still writes the run row when the review is gone, keyed on the message's project", async () => {
    const p = await project(t.db);
    const missing = "99999999-9999-4999-8999-999999999999";
    const message = deadLetter(
      messageFor({ id: missing, projectId: p.id }),
      "dl5",
      4,
    );

    const { out, done } = run([message]);
    await done;

    expect(message.ack).toHaveBeenCalledOnce();
    const [row] = await runsFor(p.id);
    expect(row).toMatchObject({
      projectId: p.id,
      kind: "api",
      status: "failed",
      received: 1,
      failed: 1,
      error: deadLetterError(missing, 4),
    });
    expect(out.only("ingest.dlq.recorded")).toMatchObject({
      review_id: missing,
      project_id: p.id,
      review_found: false,
    });
  });

  it("acks a message for a project that no longer exists, logging the refused insert", async () => {
    const gone = "88888888-8888-4888-8888-888888888888";
    const message = deadLetter(
      messageFor({ id: gone, projectId: gone }),
      "dl6",
    );

    const { out, done } = run([message]);
    await done;

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await runsFor(gone)).toEqual([]);
    expect(out.only("ingest.dlq.failed")).toMatchObject({
      level: "error",
      project_id: gone,
      error: expect.objectContaining({ message: expect.any(String) }),
    });
  });

  it("decides per message, in order: a bad sibling does not stop a good one", async () => {
    const a = await review(t.db);
    const b = await review(t.db);
    const messages = [
      deadLetter(messageFor(a), "x"),
      deadLetter({ garbage: true }, "y"),
      deadLetter(messageFor(b), "z"),
    ];

    await run(messages).done;

    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledOnce();
    }
    expect(await runsFor(a.projectId)).toHaveLength(1);
    expect(await runsFor(b.projectId)).toHaveLength(1);
    expect(await attemptsOf(a.id)).toBe(DEFAULT_MAX_INDEX_ATTEMPTS);
    expect(await attemptsOf(b.id)).toBe(DEFAULT_MAX_INDEX_ATTEMPTS);
  });
});
