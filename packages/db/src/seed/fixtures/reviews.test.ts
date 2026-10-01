/**
 * The corpus contract, pinned without a database: the shape the query API's
 * tests and the playground rely on (see the module doc in ./reviews.ts).
 * Changing a fixture that breaks one of these is a SEED_VERSION bump and a
 * conscious decision, not an accident.
 */

import { REVIEW_SOURCES } from "@proofql/core";
import { describe, expect, it } from "vitest";

import { splitSentences } from "../chunking.js";
import {
  DEMO_LIVE_REVIEWS,
  DEMO_REVIEW_FIXTURES,
  DEMO_TEST_REVIEWS,
  demoExternalId,
} from "./reviews.js";

describe("demo review fixtures", () => {
  it("has ~80 live and 10 test reviews, live first", () => {
    expect(DEMO_LIVE_REVIEWS).toHaveLength(80);
    expect(DEMO_TEST_REVIEWS).toHaveLength(10);
    expect(DEMO_REVIEW_FIXTURES).toEqual([
      ...DEMO_LIVE_REVIEWS,
      ...DEMO_TEST_REVIEWS,
    ]);
    expect(DEMO_LIVE_REVIEWS.every((f) => f.environment === "live")).toBe(true);
    expect(DEMO_TEST_REVIEWS.every((f) => f.environment === "test")).toBe(true);
  });

  it("has unique keys per environment and well-formed external ids", () => {
    for (const list of [DEMO_LIVE_REVIEWS, DEMO_TEST_REVIEWS]) {
      expect(new Set(list.map((f) => f.key)).size).toBe(list.length);
    }
    expect(demoExternalId({ key: "g01" })).toBe("demo-g01");
  });

  it("uses only known sources, mostly google", () => {
    const bySource = countBy(DEMO_LIVE_REVIEWS, (f) => f.source);
    for (const source of Object.keys(bySource)) {
      expect(REVIEW_SOURCES).toContain(source);
    }
    expect(bySource.google).toBeGreaterThan(DEMO_LIVE_REVIEWS.length / 2);
    expect(bySource.yelp).toBeGreaterThan(0);
    expect(bySource.custom).toBeGreaterThan(0);
  });

  it("skews 4–5 stars with at least 8 on-topic reviews rated 1–3", () => {
    const rated = DEMO_LIVE_REVIEWS.filter((f) => f.rating !== null);
    const low = rated.filter((f) => (f.rating ?? 0) <= 3);
    const high = rated.filter((f) => (f.rating ?? 0) >= 4);
    expect(low.length).toBeGreaterThanOrEqual(8);
    expect(high.length).toBeGreaterThan(low.length * 4);
    // Each excluded review is on a topic a positive query would also hit.
    const topics = [
      /implant/i,
      /invisalign/i,
      /bill/i,
      /parking/i,
      /front desk|appointment/i,
      /hygienist/i,
      /emergency|cracked/i,
      /kid|year-old|son|daughter/i,
      /sedation|nitrous/i,
      /insurance|in-network/i,
    ];
    for (const pattern of topics) {
      expect(
        low.some((f) => pattern.test(f.text)),
        `no low-rated review about ${pattern}`,
      ).toBe(true);
    }
  });

  it("has a few unrated custom reviews, hand-labeled, two clearly negative", () => {
    const unrated = DEMO_LIVE_REVIEWS.filter((f) => f.rating === null);
    expect(unrated.length).toBeGreaterThanOrEqual(3);
    expect(unrated.every((f) => f.source === "custom")).toBe(true);
    expect(unrated.every((f) => f.sentiment !== undefined)).toBe(true);
    expect(unrated.filter((f) => f.sentiment === "negative")).toHaveLength(2);
    // Rated reviews never carry a hand label — sentiment comes from the rating.
    expect(
      DEMO_REVIEW_FIXTURES.filter((f) => f.rating !== null && f.sentiment),
    ).toHaveLength(0);
  });

  it("covers both locations and spreads over ~18 months", () => {
    const byLocation = countBy(DEMO_LIVE_REVIEWS, (f) => f.location);
    expect(Object.keys(byLocation).sort()).toEqual(["downtown", "north"]);
    const days = DEMO_LIVE_REVIEWS.map((f) => f.daysAgo);
    expect(Math.min(...days)).toBeLessThan(14);
    expect(Math.max(...days)).toBeGreaterThan(500);
    expect(Math.max(...days)).toBeLessThanOrEqual(548);
  });

  it("varies length: ~60% short, ~30% medium, ~10% long multi-topic", () => {
    const lengths = DEMO_LIVE_REVIEWS.map((f) => splitSentences(f.text).length);
    const short = lengths.filter((n) => n <= 2).length;
    const medium = lengths.filter((n) => n >= 3 && n <= 5).length;
    const long = lengths.filter((n) => n >= 6).length;
    const total = DEMO_LIVE_REVIEWS.length;
    expect(short / total).toBeGreaterThanOrEqual(0.5);
    expect(medium / total).toBeGreaterThanOrEqual(0.25);
    expect(long / total).toBeGreaterThanOrEqual(0.08);
    // Window chunks exist only for > 3 sentences — the long tail guarantees them.
    expect(lengths.filter((n) => n > 3).length).toBeGreaterThanOrEqual(8);
  });

  it("has trimmed, non-empty text and fictional author names", () => {
    for (const f of DEMO_REVIEW_FIXTURES) {
      expect(f.text).toBe(f.text.trim());
      expect(f.text.length).toBeGreaterThan(20);
      expect(f.authorName.trim().length).toBeGreaterThan(0);
      if (f.rating !== null) expect([1, 2, 3, 4, 5]).toContain(f.rating);
    }
  });
});

function countBy<T>(items: readonly T[], key: (item: T) => string) {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}
