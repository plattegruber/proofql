/**
 * Unit tests for the ingest review shape (scope.md §3 "Ingest"): the
 * documented example parses, each field's constraints hold, metadata stays
 * flat, and batches are capped at 100.
 */

import { describe, expect, it } from "vitest";

import {
  REVIEW_BATCH_MAX,
  REVIEW_SOURCES,
  type ReviewInput,
  reviewBatchSchema,
  reviewIngestBodySchema,
  reviewInputSchema,
} from "./review.js";

/** The example body from scope.md §3, verbatim. */
const scopeExample = {
  external_id: "accounts/1/locations/2/reviews/abc",
  source: "google",
  rating: 5,
  text: "Dr. Patel did my implant and I honestly forgot it wasn't my own tooth within a week.",
  author_name: "Marcus T.",
  author_avatar_url: null,
  occurred_at: "2026-03-14T18:20:00Z",
  url: "https://maps.google.com/?cid=123",
  language: "en",
  metadata: { location: "north" },
};

function withField(overrides: Record<string, unknown>) {
  return { ...scopeExample, ...overrides };
}

function without(...fields: (keyof typeof scopeExample)[]) {
  const copy: Record<string, unknown> = { ...scopeExample };
  for (const f of fields) delete copy[f];
  return copy;
}

describe("reviewInputSchema", () => {
  it("accepts the scope.md example unchanged", () => {
    const parsed: ReviewInput = reviewInputSchema.parse(scopeExample);
    expect(parsed).toEqual(scopeExample);
  });

  it("accepts the minimal shape and defaults nullable fields to null", () => {
    const parsed = reviewInputSchema.parse(
      without("rating", "author_avatar_url", "url", "language", "metadata"),
    );
    expect(parsed.rating).toBeNull();
    expect(parsed.author_avatar_url).toBeNull();
    expect(parsed.url).toBeNull();
    expect(parsed.language).toBeUndefined();
    expect(parsed.metadata).toBeUndefined();
  });

  it("accepts explicit nulls for rating, avatar, and url", () => {
    const parsed = reviewInputSchema.parse(
      withField({ rating: null, author_avatar_url: null, url: null }),
    );
    expect(parsed.rating).toBeNull();
    expect(parsed.url).toBeNull();
  });

  it("accepts every known source", () => {
    for (const source of REVIEW_SOURCES) {
      expect(reviewInputSchema.safeParse(withField({ source })).success).toBe(
        true,
      );
    }
  });

  it("rejects unknown sources", () => {
    for (const source of ["Google", "tripadvisor", "", 42, null]) {
      expect(reviewInputSchema.safeParse(withField({ source })).success).toBe(
        false,
      );
    }
  });

  it("rejects ratings outside 1..5, non-integers, and strings", () => {
    for (const rating of [0, 6, 3.5, -1, "5", Number.NaN]) {
      const result = reviewInputSchema.safeParse(withField({ rating }));
      expect(result.success, `rating=${String(rating)}`).toBe(false);
    }
  });

  it("accepts every integer rating 1..5", () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      expect(reviewInputSchema.safeParse(withField({ rating })).success).toBe(
        true,
      );
    }
  });

  it("rejects empty or whitespace-only text and trims the rest", () => {
    expect(reviewInputSchema.safeParse(withField({ text: "" })).success).toBe(
      false,
    );
    expect(
      reviewInputSchema.safeParse(withField({ text: "   \n\t" })).success,
    ).toBe(false);
    expect(reviewInputSchema.safeParse(without("text")).success).toBe(false);
    expect(
      reviewInputSchema.parse(withField({ text: "  Great.  " })).text,
    ).toBe("Great.");
  });

  it("rejects empty external_id and author_name", () => {
    expect(
      reviewInputSchema.safeParse(withField({ external_id: "" })).success,
    ).toBe(false);
    expect(
      reviewInputSchema.safeParse(withField({ author_name: " " })).success,
    ).toBe(false);
  });

  it("requires occurred_at to be an ISO datetime, not a bare date", () => {
    for (const ok of [
      "2026-03-14T18:20:00Z",
      "2026-03-14T18:20:00.123Z",
      "2026-03-14T18:20:00+02:00",
    ]) {
      expect(
        reviewInputSchema.safeParse(withField({ occurred_at: ok })).success,
        ok,
      ).toBe(true);
    }
    for (const bad of ["2026-03-14", "March 14, 2026", 1710440400000, ""]) {
      expect(
        reviewInputSchema.safeParse(withField({ occurred_at: bad })).success,
        String(bad),
      ).toBe(false);
    }
  });

  it("requires url and author_avatar_url to be URLs when present", () => {
    expect(
      reviewInputSchema.safeParse(withField({ url: "maps.google.com" }))
        .success,
    ).toBe(false);
    expect(
      reviewInputSchema.safeParse(withField({ author_avatar_url: "not a url" }))
        .success,
    ).toBe(false);
    expect(
      reviewInputSchema.safeParse(
        withField({
          author_avatar_url: "https://lh3.googleusercontent.com/a/x",
        }),
      ).success,
    ).toBe(true);
  });

  it("requires metadata to be a flat string-to-string map", () => {
    expect(
      reviewInputSchema.safeParse(
        withField({ metadata: { location: "north", floor: "2" } }),
      ).success,
    ).toBe(true);
    expect(
      reviewInputSchema.safeParse(withField({ metadata: {} })).success,
    ).toBe(true);
    for (const metadata of [
      { location: { city: "Austin" } }, // nested object
      { tags: ["a", "b"] }, // array
      { floor: 2 }, // number
      { vip: true }, // boolean
      { nothing: null }, // null
      { "": "empty key" },
      ["north"], // array at the top level
      "north", // string at the top level
    ]) {
      expect(
        reviewInputSchema.safeParse(withField({ metadata })).success,
        JSON.stringify(metadata),
      ).toBe(false);
    }
  });

  it("caps metadata at 32 entries", () => {
    const entries = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));
    expect(
      reviewInputSchema.safeParse(withField({ metadata: entries(32) })).success,
    ).toBe(true);
    expect(
      reviewInputSchema.safeParse(withField({ metadata: entries(33) })).success,
    ).toBe(false);
  });

  it("rejects unknown fields so typos do not drop data silently", () => {
    const result = reviewInputSchema.safeParse(withField({ occured_at: "x" }));
    expect(result.success).toBe(false);
  });
});

describe("reviewBatchSchema", () => {
  it("accepts 1 to 100 reviews", () => {
    expect(reviewBatchSchema.safeParse([scopeExample]).success).toBe(true);
    expect(
      reviewBatchSchema.safeParse(
        Array.from({ length: REVIEW_BATCH_MAX }, () => scopeExample),
      ).success,
    ).toBe(true);
  });

  it("rejects empty and oversized batches", () => {
    expect(reviewBatchSchema.safeParse([]).success).toBe(false);
    expect(
      reviewBatchSchema.safeParse(
        Array.from({ length: REVIEW_BATCH_MAX + 1 }, () => scopeExample),
      ).success,
    ).toBe(false);
  });

  it("reports the index of a bad item", () => {
    const result = reviewBatchSchema.safeParse([
      scopeExample,
      withField({ rating: 9 }),
    ]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([1, "rating"]);
    }
  });
});

describe("reviewIngestBodySchema", () => {
  it("normalizes a single review to a one-element array", () => {
    expect(reviewIngestBodySchema.parse(scopeExample)).toEqual([scopeExample]);
  });

  it("passes arrays through", () => {
    expect(
      reviewIngestBodySchema.parse([scopeExample, scopeExample]),
    ).toHaveLength(2);
  });

  it("rejects non-review bodies", () => {
    for (const body of [null, "review", 5, [], {}]) {
      expect(
        reviewIngestBodySchema.safeParse(body).success,
        JSON.stringify(body),
      ).toBe(false);
    }
  });
});
