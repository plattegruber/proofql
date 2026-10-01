import {
  AiResponseError,
  BGE_M3_EMBEDDING_MODEL,
  DISTILBERT_SST2_MODEL,
  FakeEmbeddingProvider,
  FakeSentimentClassifier,
} from "@proofql/ai";
import type { IngestMessage } from "@proofql/core";
import type { Db } from "@proofql/db";
import { describe, expect, it, vi } from "vitest";

import { MemoryKv } from "./cache.js";
import {
  createClassifier,
  createEmbedder,
  handleFetch,
  handleQueueBatch,
  type QueueContext,
  type QueueMessage,
  retryDelaySeconds,
} from "./handlers.js";
import type { IndexOutcome } from "./index-review.js";

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

const validBody: IngestMessage = {
  type: "review.index",
  reviewId: REVIEW_ID,
  projectId: PROJECT_ID,
  environment: "live",
};

function fakeMessage(body: unknown, id = "m1"): QueueMessage {
  return { id, body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
}

/** A context whose `db` is never touched: the indexer is always substituted. */
function fakeContext(): QueueContext & { log: ReturnType<typeof vi.fn> } {
  return {
    db: {} as Db,
    classifier: new FakeSentimentClassifier(),
    embedder: new FakeEmbeddingProvider(),
    cache: new MemoryKv(),
    log: vi.fn(),
  };
}

const indexed: IndexOutcome = {
  status: "indexed",
  reviewId: REVIEW_ID,
  chunks: 1,
  windows: 0,
  embedded: 1,
  newlyIndexed: true,
  sentiment: "positive",
  sentimentSource: "rating",
};

describe("handleQueueBatch", () => {
  it("acks a valid message after indexing it", async () => {
    const ctx = fakeContext();
    const index = vi.fn().mockResolvedValue(indexed);
    const message = fakeMessage(validBody);

    await handleQueueBatch(
      { queue: "proofql-ingest", messages: [message] },
      ctx,
      { index },
    );

    expect(index).toHaveBeenCalledWith(ctx, validBody);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "ingest.message.processed",
      expect.objectContaining({ messageId: "m1", status: "indexed" }),
    );
  });

  it("acks (never retries) a message that fails validation, and logs why", async () => {
    const ctx = fakeContext();
    const index = vi.fn();
    const bodies: unknown[] = [
      { ...validBody, type: "review.delete" },
      { ...validBody, environment: "staging" },
      { ...validBody, reviewId: undefined },
      "not even an object",
      null,
    ];
    const messages = bodies.map((body, i) => fakeMessage(body, `m${i}`));

    await handleQueueBatch({ queue: "proofql-ingest", messages }, ctx, {
      index,
    });

    expect(index).not.toHaveBeenCalled();
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect(ctx.log).toHaveBeenCalledTimes(messages.length);
    expect(ctx.log).toHaveBeenCalledWith(
      "ingest.message.invalid",
      expect.objectContaining({
        messageId: "m1",
        issues: [expect.objectContaining({ path: "environment" })],
      }),
    );
  });

  it("retries a message whose indexing throws, without acking it", async () => {
    const ctx = fakeContext();
    const index = vi.fn().mockRejectedValue(new Error("connection reset"));
    const message = fakeMessage(validBody);

    await handleQueueBatch(
      { queue: "proofql-ingest", messages: [message] },
      ctx,
      { index },
    );

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "ingest.message.failed",
      expect.objectContaining({
        reviewId: REVIEW_ID,
        error: { name: "Error", message: "connection reset" },
      }),
    );
  });

  it("retries embedding-provider errors with a longer delay on later attempts", async () => {
    const ctx = fakeContext();
    const index = vi
      .fn()
      .mockRejectedValue(new AiResponseError("@cf/baai/bge-m3", "no data"));
    const message: QueueMessage = {
      ...fakeMessage(validBody),
      attempts: 2,
    };

    await handleQueueBatch(
      { queue: "proofql-ingest", messages: [message] },
      ctx,
      { index },
    );

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "ingest.message.failed",
      expect.objectContaining({
        attempts: 2,
        error: expect.objectContaining({ name: "AiResponseError" }),
      }),
    );
  });

  it("decides per message, in order: one failure does not affect its siblings", async () => {
    const ctx = fakeContext();
    const order: string[] = [];
    const index = vi.fn(async (_ctx: QueueContext, m: IngestMessage) => {
      order.push(m.reviewId);
      if (m.reviewId.endsWith("2")) throw new Error("boom");
      return { ...indexed, reviewId: m.reviewId };
    });
    const ids = [1, 2, 3].map((n) => `${REVIEW_ID.slice(0, -1)}${n}`);
    const messages = [
      fakeMessage({ ...validBody, reviewId: ids[0] }, "a"),
      fakeMessage({ ...validBody, reviewId: ids[1] }, "b"),
      fakeMessage({ garbage: true }, "c"),
      fakeMessage({ ...validBody, reviewId: ids[2] }, "d"),
    ];

    await handleQueueBatch({ queue: "proofql-ingest", messages }, ctx, {
      index,
    });

    expect(order).toEqual(ids);
    expect(messages.map((m) => vi.mocked(m.ack).mock.calls.length)).toEqual([
      1, 0, 1, 1,
    ]);
    expect(messages.map((m) => vi.mocked(m.retry).mock.calls.length)).toEqual([
      0, 1, 0, 0,
    ]);
  });

  it("acks a skipped outcome (missing or hidden review) — redelivery cannot help", async () => {
    const ctx = fakeContext();
    const index = vi.fn().mockResolvedValue({
      status: "skipped",
      reviewId: REVIEW_ID,
      reason: "not_found",
    } satisfies IndexOutcome);
    const message = fakeMessage(validBody);

    await handleQueueBatch(
      { queue: "proofql-ingest", messages: [message] },
      ctx,
      { index },
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("handles an empty batch", async () => {
    const ctx = fakeContext();
    await expect(
      handleQueueBatch({ queue: "proofql-ingest", messages: [] }, ctx, {
        index: vi.fn(),
      }),
    ).resolves.toBeUndefined();
    expect(ctx.log).not.toHaveBeenCalled();
  });
});

describe("retryDelaySeconds", () => {
  it("doubles from 30s per attempt and caps at five minutes", () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelaySeconds)).toEqual([
      30, 60, 120, 240, 300, 300,
    ]);
    expect(retryDelaySeconds(0)).toBe(30);
  });
});

describe("createEmbedder", () => {
  it("uses the deterministic fake only when AI is unbound in local", () => {
    expect(createEmbedder({ ENVIRONMENT: "local" })).toBeInstanceOf(
      FakeEmbeddingProvider,
    );
  });

  it("throws when AI is unbound outside local — never fake vectors in prod", () => {
    for (const ENVIRONMENT of ["preview", "prod", "staging", ""]) {
      expect(() => createEmbedder({ ENVIRONMENT })).toThrow(
        /AI binding is not bound/,
      );
    }
  });

  it("uses Workers AI bge-m3 when AI is bound, whatever the environment", () => {
    const run = vi.fn();
    const embedder = createEmbedder({
      ENVIRONMENT: "prod",
      AI: { run } as unknown as Ai,
    });

    expect(embedder.model).toBe(BGE_M3_EMBEDDING_MODEL);
    expect(embedder).not.toBeInstanceOf(FakeEmbeddingProvider);
  });
});

describe("createClassifier", () => {
  it("uses the deterministic fake when AI is not bound (local, CI)", () => {
    expect(createClassifier({})).toBeInstanceOf(FakeSentimentClassifier);
  });

  it("uses Workers AI distilbert when AI is bound", () => {
    const run = vi.fn();
    const classifier = createClassifier({ AI: { run } as unknown as Ai });

    expect(classifier.model).toBe(DISTILBERT_SST2_MODEL);
    expect(classifier).not.toBeInstanceOf(FakeSentimentClassifier);
  });
});

describe("handleFetch", () => {
  it("GET /health returns { ok: true }", async () => {
    const res = handleFetch(new Request("http://pipeline.local/health"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("other paths 404", () => {
    const res = handleFetch(new Request("http://pipeline.local/nope"));

    expect(res.status).toBe(404);
  });
});
