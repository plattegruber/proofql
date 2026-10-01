/**
 * Route behavior that needs no database: the body size limit and the pure
 * batch de-duplication.
 */

import { generateApiKey, type ReviewInput } from "@proofql/core";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { dedupeLastWins, REVIEW_BODY_LIMIT_BYTES } from "./reviews.js";

const app = createApp({
  dbProvider: () => {
    throw new Error("database must not be touched");
  },
});

describe("POST /v1/reviews body limit", () => {
  it("413 payload_too_large for a body over 1 MB (declared length)", async () => {
    const { plaintext } = await generateApiKey({
      kind: "secret",
      environment: "live",
    });
    const res = await app.request("/v1/reviews", {
      method: "POST",
      headers: {
        authorization: `Bearer ${plaintext}`,
        "content-type": "application/json",
        "content-length": String(REVIEW_BODY_LIMIT_BYTES + 1),
      },
      body: "x".repeat(REVIEW_BODY_LIMIT_BYTES + 1),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: {
        code: "payload_too_large",
        doc_url: "https://docs.proofql.com/errors#payload_too_large",
      },
    });
  });

  it("413 payload_too_large for a streamed body over 1 MB (no declared length)", async () => {
    const { plaintext } = await generateApiKey({
      kind: "secret",
      environment: "live",
    });
    const chunk = new TextEncoder().encode("y".repeat(64 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 17; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await app.request("/v1/reviews", {
      method: "POST",
      headers: {
        authorization: `Bearer ${plaintext}`,
        "transfer-encoding": "chunked",
      },
      body: stream,
      // @ts-expect-error duplex is required by undici for streaming bodies
      duplex: "half",
    });

    expect(res.status).toBe(413);
  });
});

describe("dedupeLastWins", () => {
  const base: ReviewInput = {
    external_id: "a",
    source: "google",
    rating: 5,
    text: "first",
    author_name: "A",
    author_avatar_url: null,
    occurred_at: "2026-03-14T18:20:00Z",
    url: null,
  };

  it("keeps the last occurrence of a (source, external_id) and counts the rest", () => {
    const { unique, skipped } = dedupeLastWins([
      base,
      { ...base, external_id: "b" },
      { ...base, text: "second" },
      { ...base, source: "yelp" },
    ]);

    expect(skipped).toBe(1);
    expect(unique.map((r) => [r.source, r.external_id, r.text])).toEqual([
      ["google", "b", "first"],
      ["google", "a", "second"],
      ["yelp", "a", "first"],
    ]);
  });
});
