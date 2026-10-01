import {
  AiResponseError,
  BGE_M3_EMBEDDING_MODEL,
  DISTILBERT_SST2_MODEL,
  FakeEmbeddingProvider,
  FakeSentimentClassifier,
} from "@proofql/ai";
import {
  type IngestMessage,
  MemoryKv,
  type RecordingSink,
} from "@proofql/core";
import type { Db } from "@proofql/db";
import { describe, expect, it, vi } from "vitest";

import { testLogger } from "../test/log.js";
import type { PipelineBindings } from "./bindings.js";
import {
  createClassifier,
  createEmbedder,
  handleFetch,
  handleQueue,
  handleQueueBatch,
  type QueueConsumers,
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
function fakeContext(): QueueContext & { out: RecordingSink } {
  const { log, out } = testLogger();
  return {
    db: {} as Db,
    classifier: new FakeSentimentClassifier(),
    embedder: new FakeEmbeddingProvider(),
    cache: new MemoryKv(),
    log,
    out,
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

    // The indexer gets the caller's context with a per-message child logger.
    expect(index).toHaveBeenCalledWith(
      expect.objectContaining({ db: ctx.db, cache: ctx.cache }),
      validBody,
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(ctx.out.only("ingest.message.processed")).toMatchObject({
      service: "pipeline",
      level: "info",
      queue: "proofql-ingest",
      message_id: "m1",
      attempt: 1,
      review_id: REVIEW_ID,
      project_id: PROJECT_ID,
      environment: "live",
      status: "indexed",
      chunks: 1,
      newly_indexed: true,
      sentiment_source: "rating",
    });
  });

  it("binds the message to the indexer's logger, so review.indexed carries message_id", async () => {
    const ctx = fakeContext();
    const index = vi.fn(async (c: QueueContext) => {
      c.log.log("review.indexed", { chunks: 2 });
      return indexed;
    });
    const message: QueueMessage = {
      ...fakeMessage(validBody, "m9"),
      attempts: 3,
    };

    await handleQueueBatch(
      { queue: "proofql-ingest", messages: [message] },
      ctx,
      { index },
    );

    expect(ctx.out.only("review.indexed")).toMatchObject({
      queue: "proofql-ingest",
      message_id: "m9",
      attempt: 3,
      review_id: REVIEW_ID,
      project_id: PROJECT_ID,
      environment: "live",
      chunks: 2,
    });
    // The context the indexer received is the caller's plus the child logger.
    expect(index.mock.calls[0]?.[0]).toMatchObject({
      db: ctx.db,
      cache: ctx.cache,
    });
    expect(index.mock.calls[0]?.[0].log.bindings).toMatchObject({
      message_id: "m9",
    });
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
    expect(ctx.out.records).toHaveLength(messages.length);
    expect(ctx.out.find("ingest.message.invalid")).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message_id: "m1",
        attempt: 1,
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
    expect(ctx.out.only("ingest.message.failed")).toMatchObject({
      level: "error",
      message_id: "m1",
      review_id: REVIEW_ID,
      error: { name: "Error", message: "connection reset" },
    });
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
    expect(ctx.out.only("ingest.message.failed")).toMatchObject({
      attempt: 2,
      error: expect.objectContaining({ name: "AiResponseError" }),
    });
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
    expect(ctx.out.records).toEqual([]);
  });
});

describe("handleQueue", () => {
  const env = { ENVIRONMENT: "test" } as PipelineBindings;

  function consumers(): QueueConsumers & {
    ingest: ReturnType<typeof vi.fn>;
    deadLetters: ReturnType<typeof vi.fn>;
  } {
    return {
      ingest: vi.fn().mockResolvedValue(undefined),
      deadLetters: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("routes the ingest queue to the indexer in every environment", async () => {
    for (const queue of [
      "proofql-ingest",
      "proofql-ingest-preview",
      "proofql-ingest-prod",
    ]) {
      const c = consumers();
      const batch = { queue, messages: [fakeMessage(validBody)] };

      await handleQueue(batch, env, c);

      expect(c.ingest).toHaveBeenCalledExactlyOnceWith(batch, env);
      expect(c.deadLetters).not.toHaveBeenCalled();
    }
  });

  it("routes the dead-letter queue to the DLQ consumer in every environment", async () => {
    for (const queue of [
      "proofql-ingest-dlq",
      "proofql-ingest-dlq-preview",
      "proofql-ingest-dlq-prod",
    ]) {
      const c = consumers();
      const batch = { queue, messages: [fakeMessage(validBody)] };

      await handleQueue(batch, env, c);

      expect(c.deadLetters).toHaveBeenCalledExactlyOnceWith(batch, env);
      expect(c.ingest).not.toHaveBeenCalled();
    }
  });

  it("propagates a consumer's failure so the runtime sees the batch fail", async () => {
    const c = consumers();
    c.ingest.mockRejectedValue(new Error("db down"));

    await expect(
      handleQueue({ queue: "proofql-ingest", messages: [] }, env, c),
    ).rejects.toThrow("db down");
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
  it("uses the deterministic fake only when AI is unbound in local", () => {
    expect(createClassifier({ ENVIRONMENT: "local" })).toBeInstanceOf(
      FakeSentimentClassifier,
    );
  });

  it("throws when AI is unbound outside local — the same rule as the embedder (#81)", () => {
    for (const ENVIRONMENT of ["preview", "prod", "staging", ""]) {
      expect(() => createClassifier({ ENVIRONMENT })).toThrow(
        /AI binding is not bound/,
      );
    }
  });

  it("uses Workers AI distilbert when AI is bound, whatever the environment", () => {
    const run = vi.fn();
    const classifier = createClassifier({
      ENVIRONMENT: "prod",
      AI: { run } as unknown as Ai,
    });

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
