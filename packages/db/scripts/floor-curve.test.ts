import { describe, expect, it } from "vitest";

import {
  computeCurve,
  floorSteps,
  type ObservedQuery,
  percentiles,
  pointAt,
  verdictAt,
  verdictsAt,
} from "./floor-curve.js";

const positive: ObservedQuery = {
  id: "p01",
  q: "implants",
  kind: "positive",
  expect: ["g01", "g25", "g55"],
  acceptable: ["g59"],
  rows: [
    { key: "g01", similarity: 0.8 },
    { key: "g59", similarity: 0.7 }, // acceptable: neither hit nor FP
    { key: "g25", similarity: 0.65 },
    { key: "g44", similarity: 0.6 }, // unrelated: FP while above the floor
    // g55 never returned at the scratch floor: a miss at every floor
  ],
};

const negative: ObservedQuery = {
  id: "n01",
  q: "lobby kiosk",
  kind: "negative",
  expect: [],
  rows: [
    { key: "g51", similarity: 0.58 },
    { key: "g05", similarity: 0.55 },
  ],
};

const filtered: ObservedQuery = {
  id: "f01",
  q: "collections",
  kind: "policy-filtered",
  expect: ["g13"],
  rows: [{ key: "g48", similarity: 0.62 }],
};

const spanish: ObservedQuery = {
  id: "p36",
  q: "seguro",
  kind: "positive",
  tags: ["cross-language"],
  expect: ["g07"],
  rows: [{ key: "g07", similarity: 0.5 }],
};

describe("floorSteps", () => {
  it("walks 0.50–0.80 in 31 clean steps", () => {
    const steps = floorSteps(0.5, 0.8, 0.01);
    expect(steps).toHaveLength(31);
    expect(steps[0]).toBe(0.5);
    expect(steps[13]).toBe(0.63);
    expect(steps[30]).toBe(0.8);
  });

  it("rejects a non-positive step", () => {
    expect(() => floorSteps(0.5, 0.8, 0)).toThrow(RangeError);
  });
});

describe("percentiles", () => {
  it("is nearest-rank and null on empty input", () => {
    expect(percentiles([])).toEqual({
      n: 0,
      p10: null,
      p50: null,
      p90: null,
      min: null,
      max: null,
    });
    const p = percentiles([0.9, 0.1, 0.5, 0.3, 0.7]);
    expect(p).toEqual({
      n: 5,
      p10: 0.1,
      p50: 0.5,
      p90: 0.9,
      min: 0.1,
      max: 0.9,
    });
  });
});

describe("verdictAt", () => {
  it("splits a positive's rows into hits, false positives, and misses", () => {
    const v = verdictAt(positive, 0.6);
    expect(v.hits.map((r) => r.key)).toEqual(["g01", "g25"]);
    expect(v.falsePositives.map((r) => r.key)).toEqual(["g44"]);
    expect(v.missed).toEqual([{ key: "g55", similarity: null }]);
  });

  it("reports the similarity an expected review fell short with", () => {
    const v = verdictAt(positive, 0.7);
    expect(v.hits.map((r) => r.key)).toEqual(["g01"]);
    expect(v.falsePositives).toEqual([]);
    expect(v.missed).toEqual([
      { key: "g25", similarity: 0.65 },
      { key: "g55", similarity: null },
    ]);
  });

  it("treats every row of a must-be-empty query as a false positive", () => {
    expect(verdictAt(negative, 0.56).falsePositives).toHaveLength(1);
    expect(verdictAt(negative, 0.59).falsePositives).toHaveLength(0);
    // The hidden review a policy-filtered query names is not "missed".
    const f = verdictAt(filtered, 0.5);
    expect(f.missed).toEqual([]);
    expect(f.falsePositives.map((r) => r.key)).toEqual(["g48"]);
  });

  it("uses `>=`, like the SQL", () => {
    expect(verdictAt(negative, 0.58).falsePositives).toHaveLength(1);
  });
});

describe("pointAt", () => {
  it("pools precision and recall and counts negatives per query", () => {
    const p = pointAt([positive], [negative, filtered], 0.6);
    expect(p.truePositives).toBe(2);
    expect(p.falsePositives).toBe(1);
    expect(p.misses).toBe(1);
    expect(p.precision).toBeCloseTo(2 / 3);
    expect(p.recall).toBeCloseTo(2 / 3);
    expect(p.emptyPositives).toBe(0);
    expect(p.negativeQueriesHit).toBe(1); // only f01 (0.62) is above 0.6
    expect(p.negativeRate).toBe(0.5);
    expect(p.negativeRows).toBe(1);
    // Query level: p01 has a hit, and its top 3 (g01, g59 acceptable,
    // g25) are on topic; the unrelated g44 is fourth, below the fold.
    expect(p.answered).toBe(1);
    expect(p.answeredRate).toBe(1);
    expect(p.topClean).toBe(1);
    const leadsWithNoise: ObservedQuery = {
      ...positive,
      rows: [{ key: "g44", similarity: 0.9 }, ...positive.rows],
    };
    expect(pointAt([leadsWithNoise], [], 0.6)).toMatchObject({
      answered: 1,
      topClean: 0,
    });
  });

  it("has null precision and counts an empty positive when nothing clears the floor", () => {
    const p = pointAt([positive], [negative], 0.9);
    expect(p.precision).toBeNull();
    expect(p.recall).toBe(0);
    expect(p.emptyPositives).toBe(1);
    expect(p.negativeRate).toBe(0);
  });
});

describe("computeCurve", () => {
  const queries = [positive, negative, filtered, spanish];

  it("tunes on untagged positives only and reports the counts", () => {
    const curve = computeCurve(queries);
    expect(curve.counts).toEqual({
      positives: 1,
      negatives: 1,
      policyFiltered: 1,
      crossLanguage: 1,
    });
    expect(curve.floors).toHaveLength(31);
    // The Spanish query's 0.5 hit is not in the positives' distribution.
    expect(curve.distributions.positiveHits.n).toBe(2);
    expect(curve.distributions.positiveFalse).toMatchObject({ n: 1, p50: 0.6 });
    expect(curve.distributions.negativeTop).toMatchObject({
      n: 2,
      min: 0.58,
      max: 0.62,
    });
    expect(curve.distributions.negativeAll.n).toBe(3);
  });

  it("recommends the lowest floor that meets both targets", () => {
    // Recall can be at most 2/3 here, so lower the bar to make them meet.
    const curve = computeCurve(queries, { minRecall: 0.6, maxNegativeRate: 0 });
    expect(curve.recommendation).toEqual({
      minRecall: 0.6,
      maxNegativeRate: 0,
      recommended: 0.63, // first floor above f01's 0.62
      lowestSafe: 0.63,
      highestRecall: 0.65, // g25 at 0.65 still counts (>=)
      chosen: 0.63,
    });
  });

  it("states both boundaries when the targets conflict", () => {
    const curve = computeCurve(queries, { minRecall: 0.6, maxNegativeRate: 0 });
    expect(curve.recommendation.recommended).toBe(0.63);
    const strict = computeCurve(queries, {
      minRecall: 0.9,
      maxNegativeRate: 0,
    });
    expect(strict.recommendation.recommended).toBeNull();
    expect(strict.recommendation.lowestSafe).toBe(0.63);
    expect(strict.recommendation.highestRecall).toBeNull();
    // The conflict resolves toward the false-positive cap.
    expect(strict.recommendation.chosen).toBe(0.63);
  });
});

describe("verdictsAt", () => {
  it("lists the failing queries first", () => {
    const clean: ObservedQuery = {
      id: "p02",
      q: "whitening",
      kind: "positive",
      expect: ["g24"],
      rows: [{ key: "g24", similarity: 0.9 }],
    };
    const ids = verdictsAt([clean, positive, negative], 0.55).map((v) => v.id);
    expect(ids.slice(-1)).toEqual(["p02"]);
    expect(new Set(ids.slice(0, 2))).toEqual(new Set(["p01", "n01"]));
  });
});
