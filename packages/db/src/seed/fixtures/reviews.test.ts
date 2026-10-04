/**
 * The corpus contract, pinned without a database: the shape the query API's
 * tests and the playground rely on (see the module doc in ./reviews.ts).
 * Changing a fixture that breaks one of these is a SEED_VERSION bump and a
 * conscious decision, not an accident.
 */

import { chunkReview, REVIEW_SOURCES, segmentSentences } from "@proofql/core";
import { describe, expect, it } from "vitest";

import {
  DEMO_LIVE_REVIEWS,
  DEMO_REVIEW_FIXTURES,
  DEMO_TEST_REVIEWS,
  demoExternalId,
  demoLanguage,
} from "./reviews.js";

/** The chunks the seed (and the pipeline) would write for a fixture. */
function chunksFor(fixture: (typeof DEMO_REVIEW_FIXTURES)[number]) {
  return chunkReview(fixture.text, { locale: demoLanguage(fixture) });
}

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

  it("varies length as the chunker sees it: ~60% short, ~30% medium, ~10% long", () => {
    // Sentences are counted the way `chunkReview` counts them (UAX #29 via
    // `Intl.Segmenter` plus the abbreviation merge from #77), which is what
    // decides whether a review gets window chunks. Since #77 that matches a
    // reader's count: "Dr. Patel did my implant." is one sentence, not two.
    const lengths = DEMO_LIVE_REVIEWS.map(
      (f) => segmentSentences(f.text, demoLanguage(f)).length,
    );
    const short = lengths.filter((n) => n <= 2).length;
    const medium = lengths.filter((n) => n >= 3 && n <= 5).length;
    const long = lengths.filter((n) => n >= 6).length;
    const total = DEMO_LIVE_REVIEWS.length;
    expect(short / total).toBeGreaterThanOrEqual(0.5);
    expect(medium / total).toBeGreaterThanOrEqual(0.25);
    expect(long / total).toBeGreaterThanOrEqual(0.08);
  });

  it("no review text splits on an honorific once chunked", () => {
    // The reason for seed v3 (#77): before the abbreviation merge, 19 of 90
    // reviews produced a sentence that was just "Dr." or began mid-name.
    for (const f of DEMO_REVIEW_FIXTURES) {
      const spans = segmentSentences(f.text, demoLanguage(f));
      for (const s of spans) {
        expect(f.text.slice(s.start, s.end), f.key).not.toMatch(/\bDr\.$/);
      }
    }
  });

  it("chunks to 90 full + 30 window + 236 sentence chunks, windows on 10 live and 1 test review", () => {
    // Pinned output of `chunkReview` over the corpus — the same numbers
    // `runSeed` reports and the integration test checks against the DB. A
    // change here is a change to the dataset: bump SEED_VERSION with it.
    const all = DEMO_REVIEW_FIXTURES.map((f) => ({
      fixture: f,
      chunks: chunksFor(f),
    }));
    const windows = (c: { kind: string }[]) =>
      c.filter((chunk) => chunk.kind === "window").length;
    const sentences = (c: { kind: string }[]) =>
      c.filter((chunk) => chunk.kind === "sentence").length;

    expect(all.every(({ chunks }) => chunks[0]?.kind === "full")).toBe(true);
    expect(all.reduce((n, { chunks }) => n + windows(chunks), 0)).toBe(30);
    // Seed v5 (#127): one sentence chunk per sentence on every review of two
    // or more sentences — 87 of 90 (79 live, 8 test); the other three are
    // single sentences and stay full-only. Live: 80 full, 28 window, 218
    // sentence = 326 chunks, ~4.1 per review (docs/performance.md §2).
    expect(all.reduce((n, { chunks }) => n + sentences(chunks), 0)).toBe(236);
    const withSentences = all.filter(({ chunks }) => sentences(chunks) > 0);
    expect(
      withSentences.filter((e) => e.fixture.environment === "live"),
    ).toHaveLength(79);
    expect(
      withSentences.filter((e) => e.fixture.environment === "test"),
    ).toHaveLength(8);
    for (const { fixture, chunks } of all) {
      const count = segmentSentences(
        fixture.text,
        demoLanguage(fixture),
      ).length;
      expect(sentences(chunks), fixture.key).toBe(count >= 2 ? count : 0);
    }
    const live = all.filter((e) => e.fixture.environment === "live");
    expect(live.reduce((n, { chunks }) => n + chunks.length, 0)).toBe(326);

    const withWindows = all.filter(({ chunks }) => windows(chunks) > 0);
    expect(
      withWindows.filter((e) => e.fixture.environment === "live"),
    ).toHaveLength(10);
    expect(
      withWindows.filter((e) => e.fixture.environment === "test"),
    ).toHaveLength(1);
    // Windows exist only from four sentences up, and never a lone sentence.
    for (const { fixture, chunks } of withWindows) {
      expect(
        segmentSentences(fixture.text, demoLanguage(fixture)).length,
        fixture.key,
      ).toBeGreaterThanOrEqual(4);
      expect(windows(chunks), fixture.key).toBeGreaterThanOrEqual(2);
    }
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
