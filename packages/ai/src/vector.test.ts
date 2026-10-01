import { describe, expect, it } from "vitest";

import { cosineSimilarity } from "./vector.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical directions regardless of magnitude", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it("is 0 for orthogonal vectors and -1 for opposite ones", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
  });

  it("returns 0 when either vector has zero norm", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("throws on mismatched lengths", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(RangeError);
  });
});
