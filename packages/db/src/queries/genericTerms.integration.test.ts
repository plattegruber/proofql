/**
 * Per-project generic terms (#149) against Postgres's own `ts_stat` and
 * English stemming: what the refresh derives, when the debounced variant
 * runs, and what the derived terms do to the floor's partial word match.
 */

import { chunkReview, GENERIC_TERMS_MAX } from "@proofql/core";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { chunk, project, review } from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import type { Db } from "../client.js";
import { projects } from "../schema/tenancy.js";
import { DEMO_PROJECT_ID } from "../seed/constants.js";
import { runSeed } from "../seed/run.js";
import {
  computeGenericTerms,
  refreshGenericTerms,
  refreshGenericTermsIfDue,
} from "./genericTerms.js";
import { searchChunks } from "./searchChunks.js";

const t = setupTestDb();

type Env = "live" | "test";

/**
 * A review indexed the way the pipeline indexes it: every chunk
 * `chunkReview` emits, `indexed_at` set. `embedding` goes on the `full`
 * chunk only (the search tests want exact similarities); the others stay
 * null, which `ts_stat` does not care about.
 */
async function indexed(
  db: Db,
  projectId: string,
  text: string,
  opts: {
    environment?: Env;
    indexedAt?: Date | null;
    hiddenAt?: Date | null;
    embedding?: number[];
  } = {},
) {
  const r = await review(db, {
    projectId,
    text,
    environment: opts.environment ?? "live",
    indexedAt: opts.indexedAt === undefined ? new Date() : opts.indexedAt,
    hiddenAt: opts.hiddenAt ?? null,
  });
  for (const c of chunkReview(text)) {
    await chunk(db, {
      reviewId: r.id,
      kind: c.kind,
      text: c.text,
      startOffset: c.startOffset,
      embedding: c.kind === "full" ? (opts.embedding ?? null) : null,
    });
  }
  return r;
}

const ADJ = [
  "Strong",
  "Smooth",
  "Bitter",
  "Rich",
  "Mellow",
  "Bold",
  "Fresh",
  "Nutty",
  "Silky",
  "Bright",
];
const ADJ2 = [
  "warm",
  "flaky",
  "huge",
  "tiny",
  "sweet",
  "salty",
  "crisp",
  "soft",
  "dense",
  "light",
];
const ITEMS = [
  "muffin",
  "scone",
  "bagel",
  "croissant",
  "waffle",
  "sandwich",
  "salad",
  "soup",
  "quiche",
  "cake",
];

/**
 * A cafe: 40 one-sentence reviews, "coffee" in the first 34 (85%), each
 * other word in at most 10% (every list cycles through 10 values) — "cake"
 * in 4 of them.
 */
function cafeTexts(): string[] {
  return Array.from({ length: 40 }, (_, i) => {
    const adj = ADJ[i % 10];
    const adj2 = ADJ2[Math.floor(i / 4) % 10];
    const item = ITEMS[i % 10];
    return i < 34
      ? `${adj} coffee and a ${adj2} ${item}.`
      : `${adj} ${item} and ${adj2} music.`;
  });
}

async function cafe(db: Db) {
  const p = await project(db, { name: "Corner Cafe" });
  for (const text of cafeTexts()) await indexed(db, p.id, text);
  return p;
}

async function stored(projectId: string) {
  const [row] = await t.db
    .select({
      terms: projects.genericTerms,
      refreshedAt: projects.genericTermsRefreshedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row;
}

describe("refreshGenericTerms", () => {
  it("a cafe: coffee is generic, the menu is not", async () => {
    const p = await cafe(t.db);
    const result = await refreshGenericTerms(t.db, p.id);
    expect(result).toEqual({
      terms: ["coffe"],
      previous: [],
      reviews: 40,
      changed: true,
    });
    const row = await stored(p.id);
    expect(row?.terms).toEqual(["coffe"]);
    expect(row?.refreshedAt).toBeInstanceOf(Date);
  });

  it("is a no-op on an unchanged corpus, and says so", async () => {
    const p = await cafe(t.db);
    await refreshGenericTerms(t.db, p.id);
    expect(await refreshGenericTerms(t.db, p.id)).toMatchObject({
      terms: ["coffe"],
      previous: ["coffe"],
      changed: false,
    });
  });

  it("the dental seed: only what most reviews say, which is not the old list", async () => {
    // The seed's 80 reviews are written to cover many topics, so its
    // category words are rare: "dental" is in 4 of them, "dentist" and
    // "teeth" 9, "office" 15 — under the 20-review cut. Only "Dr." (38)
    // is filler by document frequency. `runSeed` stores the refresh.
    const summary = await runSeed(t.db);
    expect(summary.genericTerms).toEqual(["dr"]);
    expect((await stored(DEMO_PROJECT_ID))?.terms).toEqual(["dr"]);
    expect(await computeGenericTerms(t.db, DEMO_PROJECT_ID)).toEqual({
      terms: ["dr"],
      reviews: 80,
    });
  });

  it("needs 30 indexed reviews: none below, however common the word", async () => {
    const p = await project(t.db);
    for (let i = 0; i < 29; i++) {
      await indexed(t.db, p.id, `Coffee number ${i} was fine.`);
    }
    expect(await refreshGenericTerms(t.db, p.id)).toMatchObject({
      terms: [],
      reviews: 29,
    });
    await indexed(t.db, p.id, "Coffee number 29 was fine.");
    expect((await refreshGenericTerms(t.db, p.id))?.terms).toContain("coffe");
  });

  it("counts reviews, not chunks: windows and sentences do not inflate a word", async () => {
    const p = await project(t.db);
    // 30 reviews; "latte" in 7 of them (23%, under the cut of 7.5) but in
    // every sentence of those, so it is in many more than 7.5 chunks.
    for (let i = 0; i < 30; i++) {
      const text =
        i < 7
          ? "Latte was hot. The latte art was neat. A latte to go. One more latte. Latte again."
          : `Visit ${i} went well.`;
      await indexed(t.db, p.id, text);
    }
    const terms = (await refreshGenericTerms(t.db, p.id))?.terms ?? [];
    expect(terms).not.toContain("latt");
    expect(terms).toContain("visit");
  });

  it("only live, indexed, visible reviews count", async () => {
    const p = await project(t.db);
    for (let i = 0; i < 30; i++) {
      await indexed(t.db, p.id, `Plain visit ${i}.`);
    }
    // 30 reviews saying "espresso" that the search cannot see.
    for (let i = 0; i < 10; i++) {
      await indexed(t.db, p.id, `Espresso ${i}.`, { environment: "test" });
      await indexed(t.db, p.id, `Espresso ${i}!`, { indexedAt: null });
      await indexed(t.db, p.id, `Espresso ${i}?`, { hiddenAt: new Date() });
    }
    const result = await refreshGenericTerms(t.db, p.id);
    expect(result?.reviews).toBe(30);
    expect(result?.terms).not.toContain("espresso");
  });

  it("keeps at most 30 terms, most frequent first, sorted", async () => {
    const p = await project(t.db);
    const shared = Array.from(
      { length: GENERIC_TERMS_MAX + 5 },
      (_, i) => `zq${String(i).padStart(2, "0")}x`,
    ).join(" ");
    for (let i = 0; i < 30; i++) {
      await indexed(t.db, p.id, `${shared} unique${i}word.`);
    }
    const terms = (await refreshGenericTerms(t.db, p.id))?.terms ?? [];
    expect(terms).toHaveLength(GENERIC_TERMS_MAX);
    expect(terms).toEqual([...terms].sort());
  });

  it("resolves to null for a project that does not exist", async () => {
    expect(
      await refreshGenericTerms(t.db, "00000000-0000-4000-8000-000000000000"),
    ).toBeNull();
  });
});

describe("refreshGenericTermsIfDue", () => {
  async function age(projectId: string, interval: string) {
    await t.db.execute(sql`
      UPDATE projects
      SET generic_terms_refreshed_at = now() - ${interval}::interval
      WHERE id = ${projectId}`);
  }

  it("runs when never computed, then not again within the hour", async () => {
    const p = await cafe(t.db);
    expect((await refreshGenericTermsIfDue(t.db, p.id))?.terms).toEqual([
      "coffe",
    ]);
    expect(await refreshGenericTermsIfDue(t.db, p.id)).toBeNull();
  });

  it("runs again once the last refresh is over an hour old", async () => {
    const p = await cafe(t.db);
    // Every review was indexed before the refresh (else the 30-review
    // crossing rule would fire for the backdated stamp).
    await t.db.execute(sql`
      UPDATE reviews SET indexed_at = now() - interval '2 hours'
      WHERE project_id = ${p.id}`);
    await refreshGenericTerms(t.db, p.id);
    await age(p.id, "59 minutes");
    expect(await refreshGenericTermsIfDue(t.db, p.id)).toBeNull();
    await age(p.id, "61 minutes");
    expect(await refreshGenericTermsIfDue(t.db, p.id)).toMatchObject({
      changed: false,
    });
  });

  it("runs at once when the project crosses 30 indexed reviews", async () => {
    const p = await project(t.db);
    const past = new Date(Date.now() - 60_000);
    for (let i = 0; i < 29; i++) {
      await indexed(t.db, p.id, `Coffee number ${i} was fine.`, {
        indexedAt: past,
      });
    }
    expect((await refreshGenericTermsIfDue(t.db, p.id))?.terms).toEqual([]);
    // Fresh, still 29: not due.
    expect(await refreshGenericTermsIfDue(t.db, p.id)).toBeNull();
    // The 30th review, indexed after the refresh (half an hour ago, so
    // the hourly rule alone would not run it): due at once.
    await age(p.id, "30 minutes");
    await indexed(t.db, p.id, "Coffee number 29 was fine.");
    const crossed = await refreshGenericTermsIfDue(t.db, p.id);
    expect(crossed).toMatchObject({ reviews: 30, changed: true });
    expect(crossed?.terms).toContain("coffe");
    // Past the minimum and fresh: the next review does not trigger it.
    await indexed(t.db, p.id, "Coffee number 30 was fine.", {
      indexedAt: past,
    });
    expect(await refreshGenericTermsIfDue(t.db, p.id)).toBeNull();
  });
});

describe("derived terms in the floor's partial word match", () => {
  // Exact cosines as in searchChunks' two-tier tests: the query is e0, a
  // chunk "at" s is s·e0 + sqrt(1 - s²)·e1.
  const QUERY = (() => {
    const v = new Array<number>(1024).fill(0);
    v[0] = 1;
    return v;
  })();
  function at(similarity: number): number[] {
    const v = new Array<number>(1024).fill(0);
    v[0] = similarity;
    v[1] = Math.sqrt(1 - similarity * similarity);
    return v;
  }
  async function search(projectId: string, q: string) {
    return searchChunks(t.db, {
      projectId,
      environment: "live",
      queryEmbedding: QUERY,
      queryText: q,
      limit: 10,
      policy: { minRating: 4, similarityFloor: 0.66 },
      mode: "excerpts",
    });
  }

  it('"coffee cake" in a cafe: the cake review passes on the partial tier, coffee alone does not count', async () => {
    const p = await cafe(t.db);
    // Both between the tiers (0.53 ≤ 0.6 < 0.66): only a word match passes.
    const cake = await indexed(t.db, p.id, "Lemon cake was moist.", {
      embedding: at(0.6),
    });
    const coffee = await indexed(t.db, p.id, "Coffee arrived quickly.", {
      embedding: at(0.6),
    });

    // Before the refresh no project terms exist: "coffee" is half of the
    // query's words, so the coffee-only review passes too.
    const before = await search(p.id, "coffee cake");
    expect(new Set(before.map((r) => r.reviewId))).toEqual(
      new Set([cake.id, coffee.id]),
    );

    expect((await refreshGenericTerms(t.db, p.id))?.terms).toEqual(["coffe"]);

    const after = await search(p.id, "coffee cake");
    expect(after.map((r) => r.reviewId)).toEqual([cake.id]);
    expect(after[0]).toMatchObject({ lexical: true, belowFloor: false });
    expect(after[0]?.similarity).toBeCloseTo(0.6, 2);
  });

  it("the terms are per project: coffee is still a topic for a dentist", async () => {
    const shop = await cafe(t.db);
    await refreshGenericTerms(t.db, shop.id);
    const dentist = await project(t.db);
    const r = await indexed(
      t.db,
      dentist.id,
      "Coffee in the waiting room was a nice touch.",
      { embedding: at(0.6) },
    );
    const results = await search(dentist.id, "coffee machine");
    expect(results.map((x) => x.reviewId)).toEqual([r.id]);
  });
});
