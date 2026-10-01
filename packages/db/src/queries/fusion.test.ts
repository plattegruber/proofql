import { describe, expect, it } from "vitest";

import {
  fuseRanked,
  maxRrfScore,
  normalizeRrf,
  RRF_K,
  rrfContribution,
  rrfScore,
} from "./fusion.js";

describe("rrfContribution", () => {
  it("is 1 / (k + rank) for a ranked item", () => {
    expect(rrfContribution(1)).toBeCloseTo(1 / 61, 12);
    expect(rrfContribution(10)).toBeCloseTo(1 / 70, 12);
    expect(rrfContribution(1, 0)).toBe(1);
  });

  it("is 0 for an item absent from the list", () => {
    expect(rrfContribution(null)).toBe(0);
  });

  it("rejects non-positive or fractional ranks", () => {
    expect(() => rrfContribution(0)).toThrow(RangeError);
    expect(() => rrfContribution(-1)).toThrow(RangeError);
    expect(() => rrfContribution(1.5)).toThrow(RangeError);
  });
});

describe("rrfScore", () => {
  it("sums the contribution of every list", () => {
    expect(rrfScore([1, 1])).toBeCloseTo(2 / 61, 12);
    expect(rrfScore([2, null])).toBeCloseTo(1 / 62, 12);
    expect(rrfScore([null, null])).toBe(0);
  });

  it("ranks an item first in one list and third in the other above one that is second in both", () => {
    // 1/61 + 1/63 > 2/62: RRF rewards a top rank even when the other list
    // is lukewarm — with k = 60 the gaps are gentle but still ordered.
    expect(rrfScore([1, 3])).toBeGreaterThan(rrfScore([2, 2]));
  });
});

describe("normalizeRrf", () => {
  it("maps rank 1 in every active list to exactly 1", () => {
    expect(normalizeRrf(rrfScore([1, 1]), 2)).toBe(1);
    expect(normalizeRrf(rrfScore([1]), 1)).toBe(1);
  });

  it("maps an item in only one of two lists to at most 0.5", () => {
    expect(normalizeRrf(rrfScore([1, null]), 2)).toBeCloseTo(0.5, 12);
    expect(normalizeRrf(rrfScore([null, 5]), 2)).toBeLessThan(0.5);
  });

  it("maps absence from every list to 0 and preserves order", () => {
    expect(normalizeRrf(0, 2)).toBe(0);
    const a = normalizeRrf(rrfScore([1, 3]), 2);
    const b = normalizeRrf(rrfScore([2, 2]), 2);
    const c = normalizeRrf(rrfScore([7, null]), 2);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(c).toBeGreaterThan(0);
  });

  it("clamps float noise into [0, 1]", () => {
    expect(normalizeRrf(maxRrfScore(2) * (1 + 1e-15), 2)).toBe(1);
    expect(normalizeRrf(-1e-15, 2)).toBe(0);
  });

  it("rejects a non-positive list count", () => {
    expect(() => normalizeRrf(0.01, 0)).toThrow(RangeError);
  });
});

describe("maxRrfScore", () => {
  it("is lists / (k + 1)", () => {
    expect(maxRrfScore(2)).toBeCloseTo(2 / (RRF_K + 1), 12);
    expect(maxRrfScore(1, 10)).toBeCloseTo(1 / 11, 12);
  });
});

describe("fuseRanked", () => {
  it("fuses two lists by summed reciprocal ranks", () => {
    const fused = fuseRanked([
      ["a", "b", "c"],
      ["b", "d"],
    ]);
    expect(fused.map((f) => f.item)).toEqual(["b", "a", "d", "c"]);
    expect(fused[0]).toEqual({
      item: "b",
      score: rrfScore([2, 1]),
      ranks: [2, 1],
    });
    expect(fused[3]).toEqual({
      item: "c",
      score: rrfScore([3, null]),
      ranks: [3, null],
    });
  });

  it("an item present in both lists beats one that only tops a single list when the gap is small", () => {
    // a: rank 1 in vector only → 1/61. b: rank 2 in both → 2/62.
    const fused = fuseRanked([
      ["a", "b"],
      ["x", "b"],
    ]);
    expect(fused[0]?.item).toBe("b");
  });

  it("handles a single list (vector-only search) and an empty list", () => {
    expect(fuseRanked([["a", "b"], []]).map((f) => f.item)).toEqual(["a", "b"]);
    expect(fuseRanked([[], []])).toEqual([]);
  });

  it("breaks ties with tieBreak, then by first appearance", () => {
    const byOrder = fuseRanked([["a"], ["b"]]);
    expect(byOrder.map((f) => f.item)).toEqual(["a", "b"]);

    const byTieBreak = fuseRanked([["a"], ["b"]], {
      tieBreak: (x, y) => y.localeCompare(x),
    });
    expect(byTieBreak.map((f) => f.item)).toEqual(["b", "a"]);
  });

  it("compares items by key when given and keeps the best rank per list", () => {
    const fused = fuseRanked([[{ id: 1 }, { id: 2 }, { id: 1 }], [{ id: 2 }]], {
      key: (item) => item.id,
    });
    expect(fused.map((f) => f.item.id)).toEqual([2, 1]);
    expect(fused[1]?.ranks).toEqual([1, null]);
  });

  it("honors a custom k", () => {
    const [top] = fuseRanked([["a"], ["a"]], { k: 0 });
    expect(top?.score).toBe(2);
  });
});
