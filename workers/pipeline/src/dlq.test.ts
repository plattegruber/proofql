import type { IngestMessage } from "@proofql/core";
import type { Db } from "@proofql/db";
import { describe, expect, it, vi } from "vitest";

import { testLogger } from "../test/log.js";
import {
  deadLetterError,
  handleDeadLetters,
  isDeadLetterQueue,
} from "./dlq.js";
import type { QueueMessage } from "./handlers.js";

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

const validBody: IngestMessage = {
  type: "review.index",
  reviewId: REVIEW_ID,
  projectId: PROJECT_ID,
  environment: "live",
};

function fakeMessage(body: unknown, id = "d1", attempts = 1): QueueMessage {
  return { id, body, attempts, ack: vi.fn(), retry: vi.fn() };
}

describe("isDeadLetterQueue", () => {
  it("matches the dlq segment in every environment's queue name", () => {
    for (const name of [
      "proofql-ingest-dlq",
      "proofql-ingest-dlq-preview",
      "proofql-ingest-dlq-prod",
    ]) {
      expect(isDeadLetterQueue(name)).toBe(true);
    }
  });

  it("does not match the ingest queues, or a name merely containing the letters", () => {
    for (const name of [
      "proofql-ingest",
      "proofql-ingest-preview",
      "proofql-ingest-prod",
      "proofql-ingestdlq",
      "proofql-dlqs",
      "",
    ]) {
      expect(isDeadLetterQueue(name)).toBe(false);
    }
  });
});

describe("deadLetterError", () => {
  it("names the review and the delivery count in the documented shape", () => {
    expect(deadLetterError(REVIEW_ID, 4)).toBe(
      `index.dead_lettered: review ${REVIEW_ID} exhausted 4 queue retries`,
    );
  });

  it("fits ingest_runs.error comfortably", () => {
    expect(deadLetterError(REVIEW_ID, 999).length).toBeLessThan(200);
  });
});

describe("handleDeadLetters", () => {
  it("acks an unparseable body without touching the database, and logs why", async () => {
    const { log, out } = testLogger();
    const db = {
      insert: vi.fn(),
      update: vi.fn(),
    } as unknown as Db;
    const messages = [
      fakeMessage({ ...validBody, type: "review.delete" }, "d0"),
      fakeMessage("garbage", "d1"),
      fakeMessage(null, "d2"),
    ];

    await handleDeadLetters(
      { db, log },
      { queue: "proofql-ingest-dlq", messages },
    );

    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(out.find("ingest.dlq.unparseable")).toHaveLength(3);
    expect(out.find("ingest.dlq.unparseable")[0]).toMatchObject({
      service: "pipeline",
      level: "warn",
      queue: "proofql-ingest-dlq",
      message_id: "d0",
      attempt: 1,
      issues: [expect.objectContaining({ path: "type" })],
    });
    expect(out.find("ingest.dlq.recorded")).toEqual([]);
  });

  it("acks a message whose database write throws, logging the error — never a retry", async () => {
    const { log, out } = testLogger();
    const db = {
      insert: () => ({
        values: vi.fn().mockRejectedValue(new Error("connection refused")),
      }),
      update: vi.fn(),
    } as unknown as Db;
    const message = fakeMessage(validBody, "d7", 3);

    await handleDeadLetters(
      { db, log },
      { queue: "proofql-ingest-dlq-prod", messages: [message] },
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(out.only("ingest.dlq.failed")).toMatchObject({
      level: "error",
      queue: "proofql-ingest-dlq-prod",
      message_id: "d7",
      attempt: 3,
      review_id: REVIEW_ID,
      project_id: PROJECT_ID,
      environment: "live",
      error: { name: "Error", message: "connection refused" },
    });
    expect(out.find("ingest.dlq.recorded")).toEqual([]);
  });

  it("handles an empty batch", async () => {
    const { log, out } = testLogger();
    await expect(
      handleDeadLetters(
        { db: {} as Db, log },
        { queue: "proofql-ingest-dlq", messages: [] },
      ),
    ).resolves.toBeUndefined();
    expect(out.records).toEqual([]);
  });
});
