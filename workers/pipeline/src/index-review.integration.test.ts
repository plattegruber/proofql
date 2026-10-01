/**
 * The consumer end to end against the real schema: a hand-built queue batch
 * goes through `handleQueueBatch` → `indexReview` and the assertions read
 * `reviews` and `review_chunks` back. Sentiment for unrated reviews comes
 * from `FakeSentimentClassifier` (deterministic lexicon), never Workers AI.
 */

import { FakeSentimentClassifier } from "@proofql/ai";
import type { IngestMessage } from "@proofql/core";
import { assertVerbatimSlice, schema } from "@proofql/db";
import { project, review, setupTestDb } from "@proofql/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  handleQueueBatch,
  type QueueContext,
  type QueueMessage,
} from "./handlers.js";
import { indexReview, type ReviewRow } from "./index-review.js";

const { reviews, reviewChunks } = schema;

const t = setupTestDb();

function context(overrides: Partial<QueueContext> = {}): QueueContext {
  return {
    db: t.db,
    classifier: new FakeSentimentClassifier(),
    log: vi.fn(),
    ...overrides,
  };
}

/** `context()` with a fake classifier whose `calls` the test can read. */
function contextWithFake(): QueueContext & {
  classifier: FakeSentimentClassifier;
} {
  const classifier = new FakeSentimentClassifier();
  return { db: t.db, classifier, log: vi.fn() };
}

function messageFor(
  r: Pick<ReviewRow, "id" | "projectId">,
  environment: IngestMessage["environment"] = "live",
): IngestMessage {
  return {
    type: "review.index",
    reviewId: r.id,
    projectId: r.projectId,
    environment,
  };
}

function queued(body: unknown): QueueMessage {
  return { id: `msg_${body}`, body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
}

async function chunksOf(reviewId: string) {
  return t.db
    .select()
    .from(reviewChunks)
    .where(eq(reviewChunks.reviewId, reviewId))
    .orderBy(reviewChunks.startOffset, reviewChunks.kind);
}

async function reload(reviewId: string): Promise<ReviewRow> {
  const [row] = await t.db
    .select()
    .from(reviews)
    .where(eq(reviews.id, reviewId));
  if (!row) throw new Error(`review ${reviewId} vanished`);
  return row;
}

const LONG_TEXT =
  "The implant consult was thorough and unhurried. Dr Patel walked me " +
  "through every option with x-rays on the screen. The surgery itself took " +
  "forty minutes and I felt nothing. Recovery was two days of mild soreness. " +
  "The front desk explained every charge before I paid a cent. Parking " +
  "behind the building was easy. I would recommend this office to anyone.";

describe("indexReview via the queue handler", () => {
  it("rated review → chunks written, sentiment from the rating", async () => {
    const r = await review(t.db, {
      rating: 2,
      text: "Short and sour. Would not return.",
    });
    const ctx = contextWithFake();
    const msg = queued(messageFor(r));

    await handleQueueBatch({ queue: "proofql-ingest", messages: [msg] }, ctx);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();

    const chunks = await chunksOf(r.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      kind: "full",
      text: r.text,
      startOffset: 0,
      embedding: null,
      projectId: r.projectId,
      environment: "live",
    });

    const after = await reload(r.id);
    expect(after.sentiment).toBe("negative");
    expect(after.sentimentSource).toBe("rating");
    expect(after.indexedAt).toBeNull(); // #24 sets it once embeddings exist
    expect(after.updatedAt.getTime()).toBeGreaterThan(r.updatedAt.getTime());
    expect(ctx.classifier.calls).toEqual([]);
  });

  it("unrated review → fake classifier decides, source is model", async () => {
    const r = await review(t.db, {
      rating: null,
      text: "Wonderful, friendly, professional team. Loved every visit.",
    });
    const ctx = contextWithFake();

    const outcome = await indexReview(ctx, messageFor(r));

    expect(outcome).toMatchObject({
      status: "indexed",
      sentiment: "positive",
      sentimentSource: "model",
    });
    expect(ctx.classifier.calls).toEqual([r.text]);
    const after = await reload(r.id);
    expect(after.sentiment).toBe("positive");
    expect(after.sentimentSource).toBe("model");
  });

  it("long review → window chunks exist and every chunk is a verbatim slice", async () => {
    const r = await review(t.db, { text: LONG_TEXT, language: "en" });

    const outcome = await indexReview(context(), messageFor(r));

    expect(outcome.status).toBe("indexed");
    const chunks = await chunksOf(r.id);
    const full = chunks.filter((c) => c.kind === "full");
    const windows = chunks.filter((c) => c.kind === "window");
    expect(full).toHaveLength(1);
    expect(windows.length).toBeGreaterThanOrEqual(2);
    expect(outcome).toMatchObject({
      chunks: chunks.length,
      windows: windows.length,
    });
    for (const c of chunks) {
      expect(() => assertVerbatimSlice(r, c)).not.toThrow();
      expect(c.embedding).toBeNull();
    }
    // Consecutive windows overlap by one sentence: each starts inside the previous.
    for (let i = 1; i < windows.length; i++) {
      const prev = windows[i - 1];
      const next = windows[i];
      if (!prev || !next) throw new Error("unreachable");
      expect(next.startOffset).toBeGreaterThan(prev.startOffset);
      expect(next.startOffset).toBeLessThan(
        prev.startOffset + prev.text.length,
      );
    }
  });

  it("redelivery twice → same chunk count, no duplicates, new rows replace old", async () => {
    const r = await review(t.db, { text: LONG_TEXT });
    const ctx = context();
    const msg = messageFor(r);

    const first = await indexReview(ctx, msg);
    const firstIds = (await chunksOf(r.id)).map((c) => c.id);
    const second = await indexReview(ctx, msg);
    const afterSecond = await chunksOf(r.id);

    expect(first.status).toBe("indexed");
    expect(second).toEqual(first);
    expect(afterSecond).toHaveLength(firstIds.length);
    expect(afterSecond.map((c) => c.id)).not.toEqual(firstIds);
    expect(
      new Set(afterSecond.map((c) => `${c.kind}:${c.startOffset}`)).size,
    ).toBe(afterSecond.length);
  });

  it("hidden review → skipped, nothing written, message acked", async () => {
    const r = await review(t.db, { hiddenAt: new Date() });
    const ctx = context();
    const msg = queued(messageFor(r));

    await handleQueueBatch({ queue: "proofql-ingest", messages: [msg] }, ctx);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(await chunksOf(r.id)).toEqual([]);
    const after = await reload(r.id);
    expect(after.sentiment).toBeNull();
    expect(ctx.log).toHaveBeenCalledWith(
      "review.skipped",
      expect.objectContaining({ reviewId: r.id, reason: "hidden" }),
    );
  });

  it("message for a different environment → not found, acked, nothing written", async () => {
    const r = await review(t.db, { environment: "live" });
    const ctx = context();
    const msg = queued(messageFor(r, "test"));

    await handleQueueBatch({ queue: "proofql-ingest", messages: [msg] }, ctx);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(await chunksOf(r.id)).toEqual([]);
    expect(ctx.log).toHaveBeenCalledWith(
      "review.skipped",
      expect.objectContaining({ reviewId: r.id, reason: "not_found" }),
    );
  });

  it("message for a different project → not found (tenant scoping)", async () => {
    const r = await review(t.db);
    const other = await project(t.db);

    const outcome = await indexReview(context(), {
      ...messageFor(r),
      projectId: other.id,
    });

    expect(outcome).toEqual({
      status: "skipped",
      reviewId: r.id,
      reason: "not_found",
    });
    expect(await chunksOf(r.id)).toEqual([]);
  });

  it("a reviewId that is not a UUID is not found rather than a database error", async () => {
    const r = await review(t.db);

    const outcome = await indexReview(context(), {
      ...messageFor(r),
      reviewId: "rev_123",
    });

    expect(outcome).toMatchObject({ status: "skipped", reason: "not_found" });
  });

  it("a classifier failure propagates so the handler retries", async () => {
    const r = await review(t.db, { rating: null });
    const classifier = {
      model: "exploding",
      classify: vi.fn().mockRejectedValue(new Error("AI unavailable")),
    };
    const msg = queued(messageFor(r));

    await handleQueueBatch(
      { queue: "proofql-ingest", messages: [msg] },
      context({ classifier }),
    );

    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
    expect(await chunksOf(r.id)).toEqual([]);
  });

  it("calls the embedding hook with the written chunk rows", async () => {
    const r = await review(t.db, { text: LONG_TEXT });
    const embedChunks = vi.fn().mockResolvedValue(undefined);
    const ctx = context({ embedChunks });

    await indexReview(ctx, messageFor(r));

    expect(embedChunks).toHaveBeenCalledOnce();
    const [, input] = embedChunks.mock.calls[0] ?? [];
    expect(input.review.id).toBe(r.id);
    expect(input.chunks.map((c: { id: string }) => c.id).sort()).toEqual(
      (await chunksOf(r.id)).map((c) => c.id).sort(),
    );
  });
});
