/**
 * The consumer end to end against the real schema: a hand-built queue batch
 * goes through `handleQueueBatch` → `indexReview` → `embedChunks` and the
 * assertions read `reviews`, `review_chunks`, and the fake KV back.
 * Sentiment for unrated reviews comes from `FakeSentimentClassifier`
 * (deterministic lexicon) and vectors from `FakeEmbeddingProvider`
 * (deterministic hashed bag-of-words), never Workers AI.
 */

import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  FakeEmbeddingProvider,
  FakeSentimentClassifier,
} from "@proofql/ai";
import type { IngestMessage } from "@proofql/core";
import { assertVerbatimSlice, schema } from "@proofql/db";
import { project, review, setupTestDb } from "@proofql/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { generationKey, MemoryKv } from "./cache.js";
import { embedChunks } from "./embed-chunks.js";
import {
  handleQueueBatch,
  type QueueContext,
  type QueueMessage,
} from "./handlers.js";
import { indexReview, type ReviewRow } from "./index-review.js";

const { reviews, reviewChunks } = schema;

const t = setupTestDb();

/** A context whose fakes the test can read: `classifier.calls`, `embedder.calls`, `cache.puts`. */
type FakeContext = QueueContext & {
  classifier: FakeSentimentClassifier;
  embedder: FakeEmbeddingProvider;
  cache: MemoryKv;
};

function context(overrides: Partial<QueueContext> = {}): FakeContext {
  return {
    db: t.db,
    classifier: new FakeSentimentClassifier(),
    embedder: new FakeEmbeddingProvider(),
    cache: new MemoryKv(),
    log: vi.fn(),
    ...overrides,
  } as FakeContext;
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

/** Every chunk carries a 1024-dim vector; returns them keyed by position. */
function embeddingsByPosition(
  chunks: { kind: string; startOffset: number; embedding: number[] | null }[],
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const c of chunks) {
    expect(c.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    out.set(`${c.kind}:${c.startOffset}`, c.embedding ?? []);
  }
  return out;
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
    const ctx = context();
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
      projectId: r.projectId,
      environment: "live",
    });
    expect(chunks[0]?.embedding).toHaveLength(EMBEDDING_DIMENSIONS);

    const after = await reload(r.id);
    expect(after.sentiment).toBe("negative");
    expect(after.sentimentSource).toBe("rating");
    expect(after.indexedAt).not.toBeNull();
    expect(after.updatedAt.getTime()).toBeGreaterThan(r.updatedAt.getTime());
    expect(ctx.classifier.calls).toEqual([]);
    expect(ctx.embedder.calls).toEqual([[r.text]]);
    expect(ctx.log).toHaveBeenCalledWith(
      "review.indexed",
      expect.objectContaining({
        reviewId: r.id,
        chunks: 1,
        embedded: 1,
        embeddingMs: expect.any(Number),
        newlyIndexed: true,
      }),
    );
  });

  it("unrated review → fake classifier decides, source is model", async () => {
    const r = await review(t.db, {
      rating: null,
      text: "Wonderful, friendly, professional team. Loved every visit.",
    });
    const ctx = context();

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

  it("long review → window chunks exist, every chunk is a verbatim slice with a vector", async () => {
    const r = await review(t.db, { text: LONG_TEXT, language: "en" });
    const ctx = context();

    const outcome = await indexReview(ctx, messageFor(r));

    expect(outcome.status).toBe("indexed");
    const chunks = await chunksOf(r.id);
    const full = chunks.filter((c) => c.kind === "full");
    const windows = chunks.filter((c) => c.kind === "window");
    expect(full).toHaveLength(1);
    expect(windows.length).toBeGreaterThanOrEqual(2);
    expect(outcome).toMatchObject({
      chunks: chunks.length,
      windows: windows.length,
      embedded: chunks.length,
      newlyIndexed: true,
    });
    for (const c of chunks) {
      expect(() => assertVerbatimSlice(r, c)).not.toThrow();
      expect(c.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    }
    // One provider call carried every chunk text, in chunk order.
    expect(ctx.embedder.calls).toEqual([chunks.map((c) => c.text)]);
    expect((await reload(r.id)).indexedAt).not.toBeNull();
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

  it("redelivery twice → same chunks, stable vectors, indexed_at and the cache untouched", async () => {
    const r = await review(t.db, { text: LONG_TEXT });
    const ctx = context();
    const msg = messageFor(r);

    const first = await indexReview(ctx, msg);
    const afterFirst = await chunksOf(r.id);
    const indexedAt = (await reload(r.id)).indexedAt;
    const second = await indexReview(ctx, msg);
    const afterSecond = await chunksOf(r.id);

    expect(first).toMatchObject({ status: "indexed", newlyIndexed: true });
    expect(second).toEqual({ ...first, newlyIndexed: false });
    expect(afterSecond).toHaveLength(afterFirst.length);
    expect(afterSecond.map((c) => c.id)).not.toEqual(
      afterFirst.map((c) => c.id),
    );
    expect(
      new Set(afterSecond.map((c) => `${c.kind}:${c.startOffset}`)).size,
    ).toBe(afterSecond.length);
    // Same text → the same (fake, deterministic) vector lands on the new row.
    expect(embeddingsByPosition(afterSecond)).toEqual(
      embeddingsByPosition(afterFirst),
    );
    expect(indexedAt).not.toBeNull();
    expect((await reload(r.id)).indexedAt).toEqual(indexedAt);
    // The project's cache generation moved exactly once, on the first pass.
    expect(ctx.cache.puts).toEqual([
      { key: generationKey(r.projectId), value: "1" },
    ]);
  });

  it("embedChunks on an already-embedded review is a no-op", async () => {
    const r = await review(t.db, { text: LONG_TEXT });
    const ctx = context();
    await indexReview(ctx, messageFor(r));
    const before = await reload(r.id);
    const calls = ctx.embedder.calls.length;

    const result = await embedChunks(ctx, { review: before });

    expect(result).toMatchObject({
      pending: 0,
      embedded: 0,
      newlyIndexed: false,
    });
    expect(ctx.embedder.calls).toHaveLength(calls);
    expect((await reload(r.id)).indexedAt).toEqual(before.indexedAt);
    expect(ctx.cache.puts).toHaveLength(1);
  });

  it("embedder failure → message retried, indexed_at stays null, chunks wait; next attempt succeeds", async () => {
    const r = await review(t.db, { text: LONG_TEXT });
    const ctx = context({
      embedder: new FakeEmbeddingProvider({
        shouldFail: ({ index }) =>
          index === 0 ? new Error("Workers AI 503") : undefined,
      }),
    });
    const first = queued(messageFor(r));

    await handleQueueBatch({ queue: "proofql-ingest", messages: [first] }, ctx);

    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(first.ack).not.toHaveBeenCalled();
    const stalled = await chunksOf(r.id);
    expect(stalled.length).toBeGreaterThan(1);
    for (const c of stalled) expect(c.embedding).toBeNull();
    expect((await reload(r.id)).indexedAt).toBeNull();
    expect(ctx.cache.puts).toEqual([]);
    expect(ctx.log).toHaveBeenCalledWith(
      "ingest.message.failed",
      expect.objectContaining({
        reviewId: r.id,
        error: expect.objectContaining({ message: "Workers AI 503" }),
      }),
    );

    const second: QueueMessage = { ...queued(messageFor(r)), attempts: 2 };
    await handleQueueBatch(
      { queue: "proofql-ingest", messages: [second] },
      ctx,
    );

    expect(second.ack).toHaveBeenCalledOnce();
    const done = await chunksOf(r.id);
    expect(done).toHaveLength(stalled.length);
    for (const c of done)
      expect(c.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect((await reload(r.id)).indexedAt).not.toBeNull();
    expect(ctx.cache.puts).toEqual([
      { key: generationKey(r.projectId), value: "1" },
    ]);
  });

  it("a batch of many reviews → every chunk embedded, ≤50 texts per provider call, one cache bump per review", async () => {
    const p = await project(t.db);
    const rows = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        review(t.db, {
          projectId: p.id,
          text: `${LONG_TEXT} Visit number ${i + 1} was just as good.`,
        }),
      ),
    );
    const ctx = context();
    const messages = rows.map((r) => queued(messageFor(r)));

    await handleQueueBatch({ queue: "proofql-ingest", messages }, ctx);

    for (const m of messages) expect(m.ack).toHaveBeenCalledOnce();
    let totalChunks = 0;
    for (const r of rows) {
      const chunks = await chunksOf(r.id);
      totalChunks += chunks.length;
      for (const c of chunks) {
        expect(c.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
      }
      expect((await reload(r.id)).indexedAt).not.toBeNull();
    }
    expect(totalChunks).toBeGreaterThan(rows.length);
    expect(ctx.embedder.calls.length).toBeGreaterThanOrEqual(rows.length);
    for (const call of ctx.embedder.calls) {
      expect(call.length).toBeLessThanOrEqual(EMBEDDING_BATCH_SIZE);
      expect(call.length).toBeGreaterThan(0);
    }
    expect(ctx.embedder.calls.flat()).toHaveLength(totalChunks);
    // One generation bump per newly indexed review, all on this project.
    expect(ctx.cache.puts).toHaveLength(rows.length);
    expect(await ctx.cache.get(generationKey(p.id))).toBe(String(rows.length));
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
    const embedChunks = vi.fn().mockResolvedValue({
      pending: 0,
      embedded: 0,
      embeddingMs: 0,
      newlyIndexed: false,
    });
    const ctx = context({ embedChunks });

    const outcome = await indexReview(ctx, messageFor(r));

    expect(outcome).toMatchObject({ embedded: 0, newlyIndexed: false });
    expect(embedChunks).toHaveBeenCalledOnce();
    const [, input] = embedChunks.mock.calls[0] ?? [];
    expect(input.review.id).toBe(r.id);
    expect(input.chunks.map((c: { id: string }) => c.id).sort()).toEqual(
      (await chunksOf(r.id)).map((c) => c.id).sort(),
    );
  });
});
