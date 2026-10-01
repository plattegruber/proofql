/**
 * `searchChunks` against the real schema (#16). Embeddings come from
 * `fakeEmbed` in `@proofql/ai`: a hashed bag of content words, so texts that
 * share vocabulary are near each other and unrelated texts are near
 * orthogonal. That is exactly the fidelity these tests need — they assert
 * the policy, the floor, the isolation, the fusion, and the collapse, not
 * the semantics of bge-m3.
 */

import { fakeEmbed } from "@proofql/ai";
import { describe, expect, it } from "vitest";

import { chunk, project, type Review, review } from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import type { Db } from "../client.js";
import type { reviews } from "../schema/reviews.js";
import { normalizeRrf, rrfScore } from "./fusion.js";
import {
  MAX_SEARCH_LIMIT,
  type SearchChunksParams,
  type SearchPolicy,
  searchChunks,
} from "./searchChunks.js";

type ReviewInsert = typeof reviews.$inferInsert;

const DEFAULT_POLICY: SearchPolicy = { minRating: 4, similarityFloor: 0.55 };

function embed(text: string): number[] {
  const [vector] = fakeEmbed([text]);
  if (!vector) throw new Error("fakeEmbed returned nothing");
  return vector;
}

/**
 * A review with its `full` chunk embedded, plus an embedded `window` chunk
 * for every substring in `windows` — what the pipeline produces for an
 * indexed review.
 */
async function indexed(
  db: Db,
  overrides: Partial<ReviewInsert> & { text: string },
  windows: string[] = [],
): Promise<Review> {
  const r = await review(db, overrides);
  await chunk(db, {
    reviewId: r.id,
    kind: "full",
    text: r.text,
    startOffset: 0,
    embedding: embed(r.text),
  });
  for (const w of windows) {
    const startOffset = r.text.indexOf(w);
    if (startOffset < 0) throw new Error(`window not in review: ${w}`);
    await chunk(db, {
      reviewId: r.id,
      kind: "window",
      text: w,
      startOffset,
      embedding: embed(w),
    });
  }
  return r;
}

/** Hybrid query for `text` with sensible defaults; override anything. */
function query(
  projectId: string,
  text: string,
  overrides: Partial<SearchChunksParams> = {},
): SearchChunksParams {
  return {
    projectId,
    environment: "live",
    queryEmbedding: embed(text),
    queryText: text,
    limit: 10,
    policy: DEFAULT_POLICY,
    mode: "excerpts",
    ...overrides,
  };
}

const IMPLANT = "The implant procedure was painless and quick.";
const PARKING = "Parking behind the building was easy.";

describe("relevance: paraphrase match and the similarity floor", () => {
  const t = setupTestDb();

  it("finds a paraphrase and ranks it above an unrelated chunk", async () => {
    const p = await project(t.db);
    const implant = await indexed(t.db, { projectId: p.id, text: IMPLANT });
    const parking = await indexed(t.db, { projectId: p.id, text: PARKING });

    // Floor 0 keeps both so the ordering itself is observable.
    const results = await searchChunks(
      t.db,
      query(p.id, "painless implant", {
        policy: { ...DEFAULT_POLICY, similarityFloor: 0 },
      }),
    );

    expect(results.map((r) => r.reviewId)).toEqual([implant.id, parking.id]);
    const [top, bottom] = results;
    expect(top?.excerpt).toBe(IMPLANT);
    expect(top?.startOffset).toBe(0);
    // {painless, implant} against {implant, procedure, painless, quick}.
    expect(top?.similarity).toBeCloseTo(Math.SQRT1_2, 2);
    expect(bottom?.similarity).toBeCloseTo(0, 2);
    // Rank 1 in both branches normalizes to exactly 1; the unrelated chunk
    // is rank 2 by vector only.
    expect(top?.score).toBeCloseTo(1, 6);
    expect(bottom?.score).toBeCloseTo(normalizeRrf(rrfScore([2, null]), 2), 6);
    expect(top?.review).toMatchObject({
      rating: 5,
      source: "google",
      authorName: implant.authorName,
      text: IMPLANT,
    });
  });

  it("drops candidates below the floor even when they match by keyword", async () => {
    const p = await project(t.db);
    await indexed(t.db, { projectId: p.id, text: IMPLANT });
    await indexed(t.db, { projectId: p.id, text: PARKING });

    // Unrelated vocabulary: nothing clears 0.55.
    expect(
      await searchChunks(t.db, query(p.id, "mortgage refinancing rates")),
    ).toEqual([]);

    // "parking" is a full-text hit on the parking chunk, but with the floor
    // above its (perfect) similarity nothing survives — text-only matches
    // cannot carry a result past the floor.
    expect(
      await searchChunks(
        t.db,
        query(p.id, "parking", {
          policy: { ...DEFAULT_POLICY, similarityFloor: 1.01 },
        }),
      ),
    ).toEqual([]);

    // With the default floor the topical chunk alone comes back.
    const results = await searchChunks(t.db, query(p.id, "painless implant"));
    expect(results.map((r) => r.excerpt)).toEqual([IMPLANT]);
  });

  it("lets the full-text branch break a vector tie", async () => {
    const p = await project(t.db);
    // Both chunks share exactly one content word with the query
    // {painless, implant}; `newer` would win the pure vector tie-break.
    const older = await indexed(t.db, {
      projectId: p.id,
      text: "Painless dentist.",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    });
    const newer = await indexed(t.db, {
      projectId: p.id,
      text: "Implant dentist.",
      occurredAt: new Date("2026-02-01T00:00:00Z"),
    });

    const vectorOnly = await searchChunks(
      t.db,
      query(p.id, "painless implant", {
        queryText: undefined,
        policy: { ...DEFAULT_POLICY, similarityFloor: 0 },
      }),
    );
    expect(vectorOnly.map((r) => r.reviewId)).toEqual([newer.id, older.id]);
    expect(vectorOnly[0]?.score).toBe(1);

    const hybrid = await searchChunks(
      t.db,
      query(p.id, "painless implant", {
        queryText: "painless",
        policy: { ...DEFAULT_POLICY, similarityFloor: 0 },
      }),
    );
    expect(hybrid.map((r) => r.reviewId)).toEqual([older.id, newer.id]);
    // older: vector rank 2, text rank 1. newer: vector rank 1, no text hit.
    expect(hybrid[0]?.score).toBeCloseTo(normalizeRrf(rrfScore([2, 1]), 2), 6);
    expect(hybrid[1]?.score).toBeCloseTo(
      normalizeRrf(rrfScore([1, null]), 2),
      6,
    );
    // similarity is reported raw, separate from the fused rank.
    expect(hybrid[0]?.similarity).toBeCloseTo(0.5, 2);
    expect(hybrid[1]?.similarity).toBeCloseTo(0.5, 2);
  });

  it("ignores chunks whose embedding is still null", async () => {
    const p = await project(t.db);
    const r = await review(t.db, { projectId: p.id, text: IMPLANT });
    await chunk(t.db, { reviewId: r.id }); // full chunk, embedding NULL

    expect(
      await searchChunks(
        t.db,
        query(p.id, "painless implant", {
          policy: { ...DEFAULT_POLICY, similarityFloor: 0 },
        }),
      ),
    ).toEqual([]);
  });
});

describe("publication policy in the same statement", () => {
  const t = setupTestDb();

  it("excludes hidden reviews, low ratings, and unrated negatives; keeps unrated neutral/positive", async () => {
    const p = await project(t.db);
    const base = { projectId: p.id, text: IMPLANT };
    const visible = await indexed(t.db, base);
    await indexed(t.db, { ...base, hiddenAt: new Date() });
    await indexed(t.db, { ...base, rating: 2 });
    await indexed(t.db, { ...base, rating: 3 });
    await indexed(t.db, {
      ...base,
      rating: null,
      sentiment: "negative",
      sentimentSource: "model",
    });
    const neutral = await indexed(t.db, {
      ...base,
      rating: null,
      sentiment: "neutral",
      sentimentSource: "model",
    });
    const positive = await indexed(t.db, {
      ...base,
      rating: null,
      sentiment: "positive",
      sentimentSource: "model",
    });
    const unclassified = await indexed(t.db, { ...base, rating: null });

    const results = await searchChunks(t.db, query(p.id, "painless implant"));
    expect(new Set(results.map((r) => r.reviewId))).toEqual(
      new Set([visible.id, neutral.id, positive.id, unclassified.id]),
    );
  });

  it("applies the caller's minRating, so a 3-star review is publishable under a looser policy", async () => {
    const p = await project(t.db);
    const three = await indexed(t.db, {
      projectId: p.id,
      text: IMPLANT,
      rating: 3,
    });
    await indexed(t.db, { projectId: p.id, text: IMPLANT, rating: 2 });

    const strict = await searchChunks(t.db, query(p.id, "painless implant"));
    expect(strict).toEqual([]);

    const loose = await searchChunks(
      t.db,
      query(p.id, "painless implant", {
        policy: { ...DEFAULT_POLICY, minRating: 3 },
      }),
    );
    expect(loose.map((r) => r.reviewId)).toEqual([three.id]);
  });
});

describe("tenant isolation", () => {
  const t = setupTestDb();

  it("never returns the same text from another environment or another project", async () => {
    const mine = await project(t.db);
    const other = await project(t.db);
    const own = await indexed(t.db, { projectId: mine.id, text: IMPLANT });
    await indexed(t.db, {
      projectId: mine.id,
      text: IMPLANT,
      environment: "test",
    });
    await indexed(t.db, { projectId: other.id, text: IMPLANT });
    await indexed(t.db, {
      projectId: other.id,
      text: IMPLANT,
      environment: "test",
    });

    const live = await searchChunks(t.db, query(mine.id, "painless implant"));
    expect(live.map((r) => r.reviewId)).toEqual([own.id]);

    const test = await searchChunks(
      t.db,
      query(mine.id, "painless implant", { environment: "test" }),
    );
    expect(test).toHaveLength(1);
    expect(test[0]?.reviewId).not.toBe(own.id);

    const recency = await searchChunks(t.db, {
      projectId: mine.id,
      environment: "live",
      limit: 10,
      policy: DEFAULT_POLICY,
      mode: "excerpts",
    });
    expect(recency.map((r) => r.reviewId)).toEqual([own.id]);
  });
});

describe("modes: one row per review", () => {
  const t = setupTestDb();

  // Three chunks of one review take part in the vector branch: the first
  // window ({painless, implant, honestly}: similarity ~0.82), the full chunk
  // (14 content words: ~0.38) and the second window ({implant, process,
  // simple}: ~0.41). Only the first window and the full chunk match the
  // full-text query; whichever of those ts_rank_cd puts first, the window
  // wins the fused score (a rank swap is an exact RRF tie, broken by
  // similarity).
  const TEXT =
    "Painless implant, honestly. The front desk explained every charge. The implant process was simple.";
  const WINDOWS = [
    "Painless implant, honestly.",
    "The implant process was simple.",
  ];
  const OPEN_FLOOR = { ...DEFAULT_POLICY, similarityFloor: 0 };

  it("excerpts: a review with several matching chunks yields one row — its best chunk", async () => {
    const p = await project(t.db);
    const multi = await indexed(t.db, { projectId: p.id, text: TEXT }, WINDOWS);
    const single = await indexed(t.db, { projectId: p.id, text: IMPLANT });

    const results = await searchChunks(
      t.db,
      query(p.id, "painless implant", { policy: OPEN_FLOOR }),
    );
    expect(results.map((r) => r.reviewId)).toEqual([multi.id, single.id]);

    const [best] = results;
    expect(best?.excerpt).toBe(WINDOWS[0]);
    expect(best?.startOffset).toBe(0);
    expect(best?.similarity).toBeCloseTo(2 / Math.sqrt(6), 2);
    expect(best?.review.text).toBe(TEXT);
    expect(
      TEXT.slice(
        best?.startOffset ?? 0,
        (best?.startOffset ?? 0) + (best?.excerpt.length ?? 0),
      ),
    ).toBe(best?.excerpt);

    // The default floor removes the review's weaker chunks from the vector
    // branch altogether; the answer is the same.
    const strict = await searchChunks(t.db, query(p.id, "painless implant"));
    expect(strict.map((r) => [r.reviewId, r.excerpt])).toEqual([
      [multi.id, WINDOWS[0]],
      [single.id, IMPLANT],
    ]);
  });

  it("reviews: collapses to the review, scored by and quoting its best chunk", async () => {
    const p = await project(t.db);
    const multi = await indexed(t.db, { projectId: p.id, text: TEXT }, WINDOWS);
    const single = await indexed(t.db, { projectId: p.id, text: IMPLANT });

    const results = await searchChunks(
      t.db,
      query(p.id, "painless implant", { mode: "reviews", policy: OPEN_FLOOR }),
    );
    expect(results.map((r) => r.reviewId)).toEqual([multi.id, single.id]);
    const [top, second] = results;
    expect(top?.excerpt).toBe(WINDOWS[0]);
    expect(top?.review.text).toBe(TEXT);
    expect(top?.similarity).toBeCloseTo(2 / Math.sqrt(6), 2);
    expect(top?.score).toBeGreaterThan(second?.score ?? Number.NaN);
    expect(top?.score).toBeLessThanOrEqual(1);
  });
});

describe("filters", () => {
  const t = setupTestDb();

  it("source", async () => {
    const p = await project(t.db);
    const google = await indexed(t.db, { projectId: p.id, text: IMPLANT });
    const yelp = await indexed(t.db, {
      projectId: p.id,
      text: IMPLANT,
      source: "yelp",
    });
    await indexed(t.db, { projectId: p.id, text: IMPLANT, source: "facebook" });

    const one = await searchChunks(
      t.db,
      query(p.id, "painless implant", { filters: { source: ["yelp"] } }),
    );
    expect(one.map((r) => r.reviewId)).toEqual([yelp.id]);

    const two = await searchChunks(
      t.db,
      query(p.id, "painless implant", {
        filters: { source: ["google", "yelp"] },
      }),
    );
    expect(new Set(two.map((r) => r.reviewId))).toEqual(
      new Set([google.id, yelp.id]),
    );

    // An empty list is "no restriction", not "nothing".
    const all = await searchChunks(
      t.db,
      query(p.id, "painless implant", { filters: { source: [] } }),
    );
    expect(all).toHaveLength(3);
  });

  it("since", async () => {
    const p = await project(t.db);
    await indexed(t.db, {
      projectId: p.id,
      text: IMPLANT,
      occurredAt: new Date("2025-06-01T00:00:00Z"),
    });
    const recent = await indexed(t.db, {
      projectId: p.id,
      text: IMPLANT,
      occurredAt: new Date("2026-02-01T00:00:00Z"),
    });
    await indexed(t.db, { projectId: p.id, text: IMPLANT, occurredAt: null });

    const results = await searchChunks(
      t.db,
      query(p.id, "painless implant", {
        filters: { since: new Date("2026-01-01T00:00:00Z") },
      }),
    );
    expect(results.map((r) => r.reviewId)).toEqual([recent.id]);
  });

  it("metadata equality via containment", async () => {
    const p = await project(t.db);
    const north = await indexed(t.db, {
      projectId: p.id,
      text: IMPLANT,
      metadata: { location: "north", tier: "vip" },
    });
    await indexed(t.db, {
      projectId: p.id,
      text: IMPLANT,
      metadata: { location: "south" },
    });
    await indexed(t.db, { projectId: p.id, text: IMPLANT });

    const byLocation = await searchChunks(
      t.db,
      query(p.id, "painless implant", {
        filters: { metadata: { location: "north" } },
      }),
    );
    expect(byLocation.map((r) => r.reviewId)).toEqual([north.id]);
    expect(byLocation[0]?.review.metadata).toEqual({
      location: "north",
      tier: "vip",
    });

    const twoKeys = await searchChunks(
      t.db,
      query(p.id, "painless implant", {
        filters: { metadata: { location: "north", tier: "basic" } },
      }),
    );
    expect(twoKeys).toEqual([]);

    // Filters also apply in no-query mode.
    const recency = await searchChunks(t.db, {
      projectId: p.id,
      environment: "live",
      limit: 10,
      policy: DEFAULT_POLICY,
      filters: { metadata: { location: "north" } },
      mode: "excerpts",
    });
    expect(recency.map((r) => r.reviewId)).toEqual([north.id]);
  });
});

describe("no-query mode", () => {
  const t = setupTestDb();

  it("returns the newest publishable reviews with the full chunk as excerpt", async () => {
    const p = await project(t.db);
    const dates = [
      "2026-01-01T00:00:00Z",
      "2026-03-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
    ];
    const created: Review[] = [];
    for (const d of dates) {
      created.push(
        await indexed(
          t.db,
          { projectId: p.id, text: IMPLANT, occurredAt: new Date(d) },
          ["The implant procedure was painless"],
        ),
      );
    }
    await indexed(t.db, {
      projectId: p.id,
      text: IMPLANT,
      occurredAt: new Date("2026-04-01T00:00:00Z"),
      hiddenAt: new Date(),
    });
    await indexed(t.db, {
      projectId: p.id,
      text: IMPLANT,
      occurredAt: new Date("2026-04-02T00:00:00Z"),
      rating: 1,
    });
    // Not yet chunked: not queryable.
    await review(t.db, {
      projectId: p.id,
      occurredAt: new Date("2026-05-01T00:00:00Z"),
    });

    const results = await searchChunks(t.db, {
      projectId: p.id,
      environment: "live",
      limit: 10,
      policy: DEFAULT_POLICY,
      mode: "excerpts",
    });
    expect(results.map((r) => r.reviewId)).toEqual([
      created[1]?.id,
      created[2]?.id,
      created[0]?.id,
    ]);
    for (const r of results) {
      expect(r.excerpt).toBe(IMPLANT);
      expect(r.startOffset).toBe(0);
      expect(r.similarity).toBeNull();
      expect(r.score).toBeNull();
    }
    expect(results[0]?.review.occurredAt).toEqual(new Date(dates[1] ?? ""));
  });

  it("rejects query text without an embedding", async () => {
    const p = await project(t.db);
    await expect(
      searchChunks(t.db, {
        projectId: p.id,
        environment: "live",
        queryText: "implant",
        limit: 5,
        policy: DEFAULT_POLICY,
        mode: "excerpts",
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("limit", () => {
  const t = setupTestDb();

  it("caps the rows returned, in both modes of operation", async () => {
    const p = await project(t.db);
    for (let i = 0; i < 5; i++) {
      await indexed(t.db, {
        projectId: p.id,
        text: IMPLANT,
        occurredAt: new Date(Date.UTC(2026, i, 1)),
      });
    }
    const hybrid = await searchChunks(
      t.db,
      query(p.id, "painless implant", { limit: 2 }),
    );
    expect(hybrid).toHaveLength(2);

    const recency = await searchChunks(t.db, {
      projectId: p.id,
      environment: "live",
      limit: 3,
      policy: DEFAULT_POLICY,
      mode: "reviews",
    });
    expect(recency).toHaveLength(3);
  });

  it("rejects limits outside 1..MAX_SEARCH_LIMIT and embeddings of the wrong size", async () => {
    const p = await project(t.db);
    for (const limit of [0, MAX_SEARCH_LIMIT + 1, 1.5]) {
      await expect(
        searchChunks(t.db, query(p.id, "painless implant", { limit })),
      ).rejects.toThrow(RangeError);
    }
    await expect(
      searchChunks(
        t.db,
        query(p.id, "painless implant", { queryEmbedding: [1, 0, 0] }),
      ),
    ).rejects.toThrow(RangeError);
  });
});
