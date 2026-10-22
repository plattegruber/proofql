/**
 * The roofing relevance set (#151): every label resolves to a review, a
 * positive's answers publish under the default policy (min_rating 4), and
 * ids follow the `rp`/`rn` scheme, so a corpus edit cannot orphan a label.
 */

import { describe, expect, it } from "vitest";

import { ROOFING_QUERIES, ROOFING_REVIEWS } from "./relevance-roofing.js";

const byKey = new Map(ROOFING_REVIEWS.map((r) => [r.key, r]));

describe("roofing relevance fixtures", () => {
  it("has unique review keys and texts", () => {
    expect(byKey.size).toBe(ROOFING_REVIEWS.length);
    expect(new Set(ROOFING_REVIEWS.map((r) => r.text)).size).toBe(
      ROOFING_REVIEWS.length,
    );
    for (const r of ROOFING_REVIEWS) expect(r.key).toMatch(/^r\d\d$/);
  });

  it("has unique ids in the rp/rn scheme and both kinds", () => {
    const ids = ROOFING_QUERIES.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const q of ROOFING_QUERIES) {
      expect(q.q.trim()).not.toBe("");
      expect(q.id).toMatch(q.kind === "positive" ? /^rp\d\d$/ : /^rn\d\d$/);
    }
    expect(
      ROOFING_QUERIES.filter((q) => q.kind === "positive").length,
    ).toBeGreaterThanOrEqual(20);
    expect(
      ROOFING_QUERIES.filter((q) => q.kind === "negative").length,
    ).toBeGreaterThanOrEqual(10);
  });

  it("labels only reviews that exist, and answers only with publishable ones", () => {
    for (const q of ROOFING_QUERIES) {
      for (const key of [...q.expect, ...(q.acceptable ?? [])]) {
        expect(byKey.has(key), `${q.id} → ${key}`).toBe(true);
      }
      if (q.kind === "positive") {
        expect(q.expect.length, q.id).toBeGreaterThan(0);
        for (const key of q.expect) {
          expect(byKey.get(key)?.rating, `${q.id} → ${key}`).toBeGreaterThan(3);
        }
      } else {
        expect(q.expect).toEqual([]);
      }
    }
  });
});
