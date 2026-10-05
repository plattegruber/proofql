import { describe, expect, it } from "vitest";

import { createLogger, recordingSink } from "./log.js";
import type { IngestMessage } from "./queue.js";
import {
  createEnqueueSession,
  ENQUEUE_BATCH_MAX,
  enqueueOrDefer,
  isQueueLimitError,
  logEnqueueFailure,
  nextUtcMidnight,
} from "./queue-guard.js";

/** What workerd throws from `sendBatch` once the free plan's daily Queues operations are spent. */
const QUEUE_LIMIT_MESSAGE = "Queue sendBatch failed: Free tier limit exceeded";

const message: IngestMessage = {
  type: "review.index",
  reviewId: "5d2f0c6e-4a1b-4c3d-9e8f-7a6b5c4d3e2f",
  projectId: "0b1c2d3e-4f5a-4b6c-8d9e-0f1a2b3c4d5e",
  environment: "live",
};

function logger() {
  const out = recordingSink();
  return {
    out,
    log: createLogger({ service: "api", environment: "test", sink: out.sink }),
  };
}

describe("isQueueLimitError", () => {
  it("matches the literal daily-limit error, from send and sendBatch, and as a cause", () => {
    expect(isQueueLimitError(new Error(QUEUE_LIMIT_MESSAGE))).toBe(true);
    expect(
      isQueueLimitError(
        new Error("Queue send failed: Free tier limit exceeded"),
      ),
    ).toBe(true);
    expect(
      isQueueLimitError(
        new Error("wrapped", { cause: new Error(QUEUE_LIMIT_MESSAGE) }),
      ),
    ).toBe(true);
  });

  it("does not match other queue failures", () => {
    expect(
      isQueueLimitError(
        new Error(
          "Queue sendBatch failed: Queue is overloaded. Please back off.",
        ),
      ),
    ).toBe(false);
    expect(
      isQueueLimitError(new Error("Queue sendBatch failed: Too Many Requests")),
    ).toBe(false);
    expect(
      isQueueLimitError(new Error("KV put() limit exceeded for the day.")),
    ).toBe(false);
  });
});

describe("nextUtcMidnight", () => {
  it("is the next 00:00 UTC, strictly after now", () => {
    expect(
      nextUtcMidnight(Date.parse("2026-10-05T13:30:00Z")).toISOString(),
    ).toBe("2026-10-06T00:00:00.000Z");
    expect(
      nextUtcMidnight(Date.parse("2026-10-05T00:00:00Z")).toISOString(),
    ).toBe("2026-10-06T00:00:00.000Z");
    expect(
      nextUtcMidnight(Date.parse("2026-12-31T23:59:59Z")).toISOString(),
    ).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("logEnqueueFailure", () => {
  it("logs the daily limit as quota.exhausted with resource queues and the renewal", () => {
    const { out, log } = logger();
    const now = Date.parse("2026-10-05T23:00:00Z");
    expect(
      logEnqueueFailure(
        log,
        "api.ingest",
        3,
        new Error(QUEUE_LIMIT_MESSAGE),
        now,
      ),
    ).toBe(true);
    expect(out.only("quota.exhausted")).toMatchObject({
      level: "error",
      resource: "queues",
      site: "api.ingest",
      messages: 3,
      retry_after: 3600,
      renews_at: "2026-10-06T00:00:00.000Z",
      error: { message: QUEUE_LIMIT_MESSAGE },
    });
    expect(out.find("ingest.enqueue_deferred")).toHaveLength(0);
  });

  it("logs anything else as ingest.enqueue_deferred at warn", () => {
    const { out, log } = logger();
    expect(
      logEnqueueFailure(
        log,
        "dashboard.csv_import",
        2,
        new Error("Queue sendBatch failed: Unknown error"),
      ),
    ).toBe(false);
    expect(out.only("ingest.enqueue_deferred")).toMatchObject({
      level: "warn",
      site: "dashboard.csv_import",
      messages: 2,
    });
    expect(out.find("quota.exhausted")).toHaveLength(0);
  });
});

describe("enqueueOrDefer", () => {
  it("sends the messages as one batch", async () => {
    const sent: unknown[] = [];
    const outcome = await enqueueOrDefer(
      { sendBatch: async (m) => void sent.push([...m]) },
      [message],
      { site: "test" },
    );
    expect(outcome).toEqual({ sent: true });
    expect(sent).toEqual([[{ body: message }]]);
  });

  it("does not call the queue for nothing", async () => {
    const outcome = await enqueueOrDefer(
      {
        sendBatch: async () => {
          throw new Error("must not be called");
        },
      },
      [],
      { site: "test" },
    );
    expect(outcome).toEqual({ sent: true });
  });

  it("never throws: a quota error is reported as such", async () => {
    const { out, log } = logger();
    const outcome = await enqueueOrDefer(
      {
        sendBatch: async () => {
          throw new Error(QUEUE_LIMIT_MESSAGE);
        },
      },
      [message, message],
      { site: "api.ingest", log },
    );
    expect(outcome).toEqual({ sent: false, quota: true });
    expect(out.only("quota.exhausted")).toMatchObject({ messages: 2 });
  });

  it("never throws: any other failure is reported as deferred", async () => {
    const { out, log } = logger();
    const outcome = await enqueueOrDefer(
      {
        sendBatch: async () => {
          throw new Error("Queue sendBatch failed: Unknown error");
        },
      },
      [message],
      { site: "api.ingest", log },
    );
    expect(outcome).toEqual({ sent: false, quota: false });
    expect(out.only("ingest.enqueue_deferred")).toMatchObject({ messages: 1 });
  });
});

describe("createEnqueueSession", () => {
  const many = (n: number) => Array.from({ length: n }, () => message);

  it("sends in batches of at most 100 and counts what it sent", async () => {
    const sizes: number[] = [];
    const session = createEnqueueSession(
      { sendBatch: async (m) => void sizes.push([...m].length) },
      { site: "test" },
    );
    expect(await session.send(many(250))).toBe(250);
    expect(sizes).toEqual([ENQUEUE_BATCH_MAX, ENQUEUE_BATCH_MAX, 50]);
    expect(session.deferred).toBe(0);
    expect(session.exhausted).toBe(false);
  });

  it("stops calling the queue after the daily limit and counts the rest as deferred", async () => {
    const { out, log } = logger();
    let calls = 0;
    const session = createEnqueueSession(
      {
        sendBatch: async () => {
          calls += 1;
          if (calls === 2) throw new Error(QUEUE_LIMIT_MESSAGE);
        },
      },
      { site: "pipeline.google_poll", log },
    );
    expect(await session.send(many(250))).toBe(100);
    // A later commit in the same tick: not even tried.
    expect(await session.send(many(30))).toBe(0);
    expect(calls).toBe(2);
    expect(session.exhausted).toBe(true);
    expect(session.deferred).toBe(180);
    expect(out.only("quota.exhausted")).toMatchObject({
      site: "pipeline.google_poll",
      messages: 100,
    });
  });

  it("a non-quota failure defers only that batch; the next is still tried", async () => {
    const { out, log } = logger();
    let calls = 0;
    const session = createEnqueueSession(
      {
        sendBatch: async () => {
          calls += 1;
          if (calls === 1) throw new Error("Queue sendBatch failed: Unknown");
        },
      },
      { site: "test", log },
    );
    expect(await session.send(many(150))).toBe(50);
    expect(calls).toBe(2);
    expect(session).toMatchObject({ deferred: 100, exhausted: false });
    expect(out.only("ingest.enqueue_deferred")).toMatchObject({
      messages: 100,
    });
  });

  it("logs through the per-call logger when one is given", async () => {
    const session = createEnqueueSession(
      {
        sendBatch: async () => {
          throw new Error(QUEUE_LIMIT_MESSAGE);
        },
      },
      { site: "test", log: logger().log },
    );
    const call = logger();
    await session.send([message], { log: call.log });
    expect(call.out.only("quota.exhausted")).toMatchObject({ messages: 1 });
  });
});
