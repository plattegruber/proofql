import { describe, expect, it } from "vitest";

import { SENTIMENTS, sentimentFromRating } from "./sentiment.js";

describe("sentimentFromRating", () => {
  it.each([
    [5, "positive"],
    [4, "positive"],
    [3, "neutral"],
    [2, "negative"],
    [1, "negative"],
  ] as const)("maps %i stars to %s", (rating, sentiment) => {
    expect(sentimentFromRating(rating)).toBe(sentiment);
  });

  it("only ever returns a known sentiment", () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      expect(SENTIMENTS).toContain(sentimentFromRating(rating));
    }
  });

  it("throws on ratings outside 1..5 or non-integers", () => {
    for (const bad of [0, 6, -1, 3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sentimentFromRating(bad)).toThrow(RangeError);
    }
  });
});
