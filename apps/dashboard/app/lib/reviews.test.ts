// Pure helpers of the review browser: status and sentiment judgments, the
// excerpt cut, list parameters ↔ query string, and the keyset cursor.
import { describe, expect, it } from "vitest";

import {
  cursorFor,
  decodeCursor,
  encodeCursor,
  excerptOf,
  listSearchParams,
  parseListParams,
  reviewStatus,
  sentimentJudgment,
} from "./reviews";

describe("reviewStatus", () => {
  it("is indexed once indexed_at is set, whatever the attempts", () => {
    expect(reviewStatus({ indexedAt: new Date(), indexAttempts: 7 })).toBe(
      "indexed",
    );
  });
  it("is indexing while attempts are under the sweep's cap, stuck at it", () => {
    expect(reviewStatus({ indexedAt: null, indexAttempts: 0 })).toBe("indexing");
    expect(reviewStatus({ indexedAt: null, indexAttempts: 4 })).toBe("indexing");
    expect(reviewStatus({ indexedAt: null, indexAttempts: 5 })).toBe("stuck");
  });
});

describe("sentimentJudgment", () => {
  it("names the sentiment and where it came from", () => {
    expect(
      sentimentJudgment({ sentiment: "positive", sentimentSource: "rating" }),
    ).toBe("positive · from rating");
    expect(
      sentimentJudgment({ sentiment: "negative", sentimentSource: "model" }),
    ).toBe("negative · model");
  });
  it("is null before the pipeline has looked", () => {
    expect(sentimentJudgment({ sentiment: null, sentimentSource: null })).toBe(
      null,
    );
  });
  it("tolerates a sentiment without a recorded source", () => {
    expect(
      sentimentJudgment({ sentiment: "neutral", sentimentSource: null }),
    ).toBe("neutral");
  });
});

describe("excerptOf", () => {
  it("returns short text untouched, whitespace collapsed", () => {
    expect(excerptOf("  Great   visit.\n Thanks. ")).toBe("Great visit. Thanks.");
  });
  it("cuts at a word boundary near the limit with an ellipsis", () => {
    const text = "word ".repeat(40).trim();
    const out = excerptOf(text, 120);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(121);
    expect(out).not.toMatch(/wor…$/);
  });
  it("hard-cuts when there is no space to break on", () => {
    expect(excerptOf("x".repeat(200), 50)).toBe(`${"x".repeat(50)}…`);
  });
});

describe("list parameters", () => {
  it("parses the query string with defaults for anything malformed", () => {
    const params = parseListParams(
      new URLSearchParams(
        "env=test&source=yelp&min_rating=9&hidden=hidden&indexed=nope&cursor=abc",
      ),
    );
    expect(params).toEqual({
      environment: "test",
      cursor: "abc",
      filters: {
        source: "yelp",
        minRating: undefined,
        hidden: "hidden",
        indexed: "all",
      },
    });
    expect(parseListParams(new URLSearchParams("env=prod")).environment).toBe(
      "live",
    );
  });

  it("round-trips through listSearchParams and omits defaults", () => {
    expect(listSearchParams({ environment: "live" }).toString()).toBe("");
    const params = parseListParams(
      new URLSearchParams("env=test&min_rating=4&indexed=pending&cursor=c1"),
    );
    const search = listSearchParams(params);
    expect(search.toString()).toBe(
      "env=test&min_rating=4&indexed=pending&cursor=c1",
    );
    expect(parseListParams(search)).toEqual(params);
  });
});

describe("cursor", () => {
  const id = "0e2b2b4a-5b1a-4d55-9f44-7b0b2b3e8d11";

  it("encodes the keyset as URL-safe text and decodes it back", () => {
    const at = new Date("2026-03-14T18:20:00.123Z");
    const encoded = encodeCursor(cursorFor({ id, occurredAt: at }));
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual({ o: at.toISOString(), i: id });
    expect(decodeCursor(encodeCursor(cursorFor({ id, occurredAt: null })))).toEqual(
      { o: null, i: id },
    );
  });

  it("rejects anything that is not exactly what encodeCursor produces", () => {
    expect(decodeCursor("not base64!")).toBeNull();
    expect(decodeCursor(btoa("[]"))).toBeNull();
    expect(decodeCursor(btoa(JSON.stringify({ o: null, i: "nope" })))).toBeNull();
    expect(
      decodeCursor(btoa(JSON.stringify({ o: "yesterday", i: id }))),
    ).toBeNull();
  });
});
