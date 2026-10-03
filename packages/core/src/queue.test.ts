import { describe, expect, it } from "vitest";

import { type IngestMessage, ingestMessageSchema } from "./queue.js";

describe("ingestMessageSchema", () => {
  const valid: IngestMessage = {
    type: "review.index",
    reviewId: "5d2f0c6e-4a1b-4c3d-9e8f-7a6b5c4d3e2f",
    projectId: "0b1c2d3e-4f5a-4b6c-8d9e-0f1a2b3c4d5e",
    environment: "live",
  };

  it("accepts a well-formed message", () => {
    expect(ingestMessageSchema.parse(valid)).toEqual(valid);
  });

  it("accepts a connection.sync message", () => {
    const sync: IngestMessage = {
      type: "connection.sync",
      connectionId: "7c4a8d09-ca3b-4f2e-9a1d-2b3c4d5e6f70",
      projectId: "0b1c2d3e-4f5a-4b6c-8d9e-0f1a2b3c4d5e",
    };
    expect(ingestMessageSchema.parse(sync)).toEqual(sync);
    expect(
      ingestMessageSchema.safeParse({ ...sync, connectionId: "" }).success,
    ).toBe(false);
    // A sync message does not carry review fields, and vice versa.
    expect(
      ingestMessageSchema.safeParse({ ...sync, type: "review.index" }).success,
    ).toBe(false);
  });

  it("rejects an unknown type, environment, or empty id", () => {
    expect(
      ingestMessageSchema.safeParse({ ...valid, type: "nope" }).success,
    ).toBe(false);
    expect(
      ingestMessageSchema.safeParse({ ...valid, environment: "prod" }).success,
    ).toBe(false);
    expect(
      ingestMessageSchema.safeParse({ ...valid, reviewId: "" }).success,
    ).toBe(false);
  });
});
