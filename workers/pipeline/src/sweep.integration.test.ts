/**
 * The re-enqueue sweep against the real schema: stuck reviews are found by
 * `indexed_at`/`hidden_at`/`updated_at`, re-sent as `IngestMessage`s to a
 * fake producer, and bounded by `index_attempts`. The reset path runs the
 * real indexer with the deterministic fakes.
 */

import { FakeEmbeddingProvider, FakeSentimentClassifier } from "@proofql/ai";
import { type IngestMessage, MemoryKv } from "@proofql/core";
import { schema } from "@proofql/db";
import { project, review, setupTestDb } from "@proofql/db/test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { testLogger } from "../test/log.js";
import { indexReview, type ReviewRow } from "./index-review.js";
import {
  DEFAULT_MAX_INDEX_ATTEMPTS,
  type IngestQueue,
  sweepUnindexed,
} from "./sweep.js";

const { reviews } = schema;

const t = setupTestDb();

// Stuck reviews stay stuck across tests by design; start each one clean.
afterEach(async () => {
  await t.db.delete(reviews);
});

class FakeQueue implements IngestQueue {
  /** Every `sendBatch` call's bodies, in order. */
  readonly batches: IngestMessage[][] = [];
  failWith: Error | undefined;

  async sendBatch(messages: Iterable<{ body: IngestMessage }>): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.batches.push([...messages].map((m) => m.body));
  }

  get sent(): IngestMessage[] {
    return this.batches.flat();
  }
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

/** A review whose `updated_at` is `minutes` in the past (default: stuck for 10). */
function stale(
  overrides: Partial<typeof reviews.$inferInsert> = {},
  minutes = 10,
) {
  return review(t.db, { updatedAt: minutesAgo(minutes), ...overrides });
}

async function reload(reviewId: string): Promise<ReviewRow> {
  const [row] = await t.db
    .select()
    .from(reviews)
    .where(eq(reviews.id, reviewId));
  if (!row) throw new Error(`review ${reviewId} vanished`);
  return row;
}

function sweep(queue: FakeQueue, options: { limit?: number } = {}) {
  const { log, out } = testLogger();
  return {
    out,
    run: () =>
      sweepUnindexed(
        { db: t.db, queue, log },
        { olderThanMinutes: 5, limit: options.limit ?? 500 },
      ),
  };
}

describe("sweepUnindexed", () => {
  it("re-enqueues only the stale unindexed review, not the fresh or hidden ones", async () => {
    const fresh = await review(t.db);
    const stuck = await stale();
    const hidden = await stale({ hiddenAt: new Date() });
    const indexed = await stale({ indexedAt: minutesAgo(9) });
    const queue = new FakeQueue();
    const { run, out } = sweep(queue);

    const result = await run();

    expect(result).toEqual({ enqueued: 1, exhausted: 0, batches: 1 });
    expect(queue.sent).toEqual([
      {
        type: "review.index",
        reviewId: stuck.id,
        projectId: stuck.projectId,
        environment: "live",
      },
    ]);
    expect((await reload(stuck.id)).indexAttempts).toBe(1);
    for (const r of [fresh, hidden, indexed]) {
      expect((await reload(r.id)).indexAttempts).toBe(0);
    }
    expect(out.only("sweep.completed")).toMatchObject({
      service: "pipeline",
      level: "info",
      older_than_minutes: 5,
      limit: 500,
      enqueued: 1,
      exhausted: 0,
      batches: 1,
      review_ids: [stuck.id],
    });
    expect(out.find("sweep.exhausted")).toEqual([]);
  });

  it("skips a review at the attempt cap and warns with its id; one below the cap is sent", async () => {
    const exhausted = await stale({
      indexAttempts: DEFAULT_MAX_INDEX_ATTEMPTS,
    });
    const lastChance = await stale({
      indexAttempts: DEFAULT_MAX_INDEX_ATTEMPTS - 1,
    });
    const queue = new FakeQueue();
    const { run, out } = sweep(queue);

    const result = await run();

    expect(result).toEqual({ enqueued: 1, exhausted: 1, batches: 1 });
    expect(queue.sent.map((m) => m.reviewId)).toEqual([lastChance.id]);
    expect((await reload(exhausted.id)).indexAttempts).toBe(
      DEFAULT_MAX_INDEX_ATTEMPTS,
    );
    expect((await reload(lastChance.id)).indexAttempts).toBe(
      DEFAULT_MAX_INDEX_ATTEMPTS,
    );
    expect(out.only("sweep.exhausted")).toMatchObject({
      level: "warn",
      count: 1,
      review_ids: [exhausted.id],
      max_attempts: DEFAULT_MAX_INDEX_ATTEMPTS,
    });

    // Next tick: the one that just hit the cap is now exhausted too.
    const again = await run();
    expect(again).toEqual({ enqueued: 0, exhausted: 2, batches: 0 });
    expect(queue.sent).toHaveLength(1);
  });

  it("a successful index resets the attempt counter", async () => {
    const r = await stale({ indexAttempts: 3 });
    const queue = new FakeQueue();
    await sweep(queue).run();
    expect((await reload(r.id)).indexAttempts).toBe(4);

    const outcome = await indexReview(
      {
        db: t.db,
        classifier: new FakeSentimentClassifier(),
        embedder: new FakeEmbeddingProvider(),
        cache: new MemoryKv(),
        log: testLogger().log,
      },
      {
        type: "review.index",
        reviewId: r.id,
        projectId: r.projectId,
        environment: "live",
      },
    );

    expect(outcome).toMatchObject({ status: "indexed", newlyIndexed: true });
    const after = await reload(r.id);
    expect(after.indexAttempts).toBe(0);
    expect(after.indexedAt).not.toBeNull();

    // Indexed now, so no longer a candidate.
    const next = await sweep(queue).run();
    expect(next.enqueued).toBe(0);
  });

  it("sends oldest first, honours the per-tick limit, and splits into batches of 100", async () => {
    const p = await project(t.db);
    const rows: ReviewRow[] = [];
    for (let i = 0; i < 120; i++) {
      rows.push(await stale({ projectId: p.id }, 10 + i));
    }
    const oldestFirst = [...rows].reverse().map((r) => r.id);

    const limited = new FakeQueue();
    const first = await sweep(limited, { limit: 50 }).run();
    expect(first).toEqual({ enqueued: 50, exhausted: 0, batches: 1 });
    expect(limited.sent.map((m) => m.reviewId)).toEqual(
      oldestFirst.slice(0, 50),
    );

    const full = new FakeQueue();
    const second = await sweep(full).run();
    expect(second).toEqual({ enqueued: 120, exhausted: 0, batches: 2 });
    expect(full.batches.map((b) => b.length)).toEqual([100, 20]);
    expect(full.sent.map((m) => m.reviewId)).toEqual(oldestFirst);
    for (const m of full.sent) expect(m.projectId).toBe(p.id);
  });

  it("a queue failure propagates after the attempt was counted, so a dead queue cannot make re-sends unbounded", async () => {
    const r = await stale();
    const queue = new FakeQueue();
    queue.failWith = new Error("queue unavailable");

    await expect(sweep(queue).run()).rejects.toThrow("queue unavailable");

    expect(queue.sent).toEqual([]);
    expect((await reload(r.id)).indexAttempts).toBe(1);
  });
});
