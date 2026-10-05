/**
 * `searchChunks` against the real schema (#16). Embeddings come from
 * `fakeEmbed` in `@proofql/ai`: a hashed bag of content words, so texts that
 * share vocabulary are near each other and unrelated texts are near
 * orthogonal. That is exactly the fidelity these tests need — they assert
 * the policy, the floor, the isolation, the fusion, and the collapse, not
 * the semantics of bge-m3.
 */

import { fakeEmbed } from "@proofql/ai";
import {
  chunkReview,
  DEFAULT_SIMILARITY_FLOOR,
  lexicalFloorFor,
} from "@proofql/core";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { chunk, project, type Review, review } from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import type { Db } from "../client.js";
import { reviewChunks } from "../schema/reviewChunks.js";
import { reviews } from "../schema/reviews.js";
import { normalizeRrf, rrfScore } from "./fusion.js";
import {
  MAX_SEARCH_LIMIT,
  type SearchChunksParams,
  type SearchPolicy,
  searchChunks,
  searchChunksSql,
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

/**
 * A review indexed exactly as the pipeline indexes it: every chunk
 * `chunkReview` emits (`full`, the `window`s, the `sentence`s; #127),
 * embedded.
 */
async function indexedByChunker(
  db: Db,
  overrides: Partial<ReviewInsert> & { text: string },
): Promise<Review> {
  const r = await review(db, overrides);
  const chunks = chunkReview(r.text, { locale: r.language });
  const vectors = fakeEmbed(chunks.map((c) => c.text));
  for (const [i, c] of chunks.entries()) {
    await chunk(db, {
      reviewId: r.id,
      kind: c.kind,
      text: c.text,
      startOffset: c.startOffset,
      embedding: vectors[i] ?? null,
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

describe("relevance: the two-tier floor (#138)", () => {
  const t = setupTestDb();

  // Exact cosines, independent of the text: the query is the first basis
  // vector and a chunk "at" s is s·e0 + sqrt(1 - s²)·e1 (both unit). The
  // text then decides only whether the full-text branch matches.
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
  async function withSimilarity(
    projectId: string,
    text: string,
    similarity: number,
  ): Promise<Review> {
    const r = await review(t.db, { projectId, text });
    await chunk(t.db, {
      reviewId: r.id,
      kind: "full",
      text,
      startOffset: 0,
      embedding: at(similarity),
    });
    return r;
  }
  const policy: SearchPolicy = {
    minRating: 4,
    similarityFloor: DEFAULT_SIMILARITY_FLOOR,
  };
  const lexicalFloor = lexicalFloorFor(DEFAULT_SIMILARITY_FLOOR); // 0.53
  function twoTierQuery(projectId: string, text: string) {
    return query(projectId, text, { queryEmbedding: QUERY, policy });
  }
  /**
   * A dental project whose derived generic terms (#149) are what a real
   * dental corpus yields; the search reads them from the row.
   */
  function dentalProject() {
    return project(t.db, {
      genericTerms: ["dental", "dentist", "offic", "teeth"],
    });
  }

  it("lets a keyword query through on the lexical tier, and only a lexical one", async () => {
    const p = await project(t.db);
    // Between the tiers: the veneer review matches "veneers" by its words.
    const veneers = await withSimilarity(
      p.id,
      "Veneers on my front teeth look natural.",
      0.6,
    );
    // Equally close, no shared words: held to the full floor, dropped.
    await withSimilarity(p.id, "Whitening left no sensitivity at all.", 0.6);
    // Lexical but under the lexical tier: a shared word is not enough.
    await withSimilarity(p.id, "The veneers consult was booked online.", 0.5);
    // Over the floor without a lexical match: the ordinary tier.
    const close = await withSimilarity(
      p.id,
      "Porcelain shells made my smile even.",
      0.7,
    );

    const results = await searchChunks(t.db, twoTierQuery(p.id, "veneers"));
    expect(new Set(results.map((r) => r.reviewId))).toEqual(
      new Set([veneers.id, close.id]),
    );
    const byId = new Map(results.map((r) => [r.reviewId, r]));
    expect(byId.get(veneers.id)?.lexical).toBe(true);
    expect(byId.get(veneers.id)?.similarity).toBeCloseTo(0.6, 2);
    expect(byId.get(close.id)?.lexical).toBe(false);
    expect(results.every((r) => r.belowFloor === false)).toBe(true);
    expect(byId.get(veneers.id)?.similarity).toBeGreaterThanOrEqual(
      lexicalFloor,
    );
  });

  it("keeps a non-lexical in-domain negative empty between the tiers", async () => {
    const p = await project(t.db);
    // The shape of the bge-m3 failure #137 found: same domain, nothing in
    // common lexically, similarities right under the floor.
    await withSimilarity(
      p.id,
      "Knocked out half a front tooth playing ball.",
      0.65,
    );
    await withSimilarity(p.id, "Free parking right by the entrance.", 0.62);

    const q = twoTierQuery(p.id, "orthodontic headgear");
    expect(await searchChunks(t.db, q)).toEqual([]);

    // The playground's view: both are below the floor, neither lexical.
    const debug = await searchChunks(t.db, { ...q, includeBelowFloor: true });
    expect(debug).toHaveLength(2);
    expect(debug.every((r) => r.belowFloor && !r.lexical)).toBe(true);
  });

  it("passes a partial keyword match: one specific word of two (#147)", async () => {
    const p = await dentalProject();
    // p01 on bge-m3: no implant review says "dental", so the every-term
    // match never fired; "implants" alone is half of the content words
    // and "dental" is generic anyway.
    const implant = await withSimilarity(
      p.id,
      "My implant feels like a real tooth.",
      0.6,
    );
    // Equally close, shares only the generic word: held to the floor.
    await withSimilarity(p.id, "The dental team ran on time.", 0.6);

    const results = await searchChunks(
      t.db,
      twoTierQuery(p.id, "dental implants"),
    );
    expect(results.map((r) => r.reviewId)).toEqual([implant.id]);
    expect(results[0]?.lexical).toBe(true);
  });

  it("keeps a must-be-empty query empty when it shares only a generic word (#147)", async () => {
    const p = await dentalProject();
    // n02 "dental tourism abroad": every review says "dental" somewhere.
    await withSimilarity(p.id, "Best dental office in town, truly.", 0.62);
    await withSimilarity(p.id, "Dental cleaning was quick and thorough.", 0.6);

    const q = twoTierQuery(p.id, "dental tourism abroad");
    expect(await searchChunks(t.db, q)).toEqual([]);
    const debug = await searchChunks(t.db, { ...q, includeBelowFloor: true });
    expect(debug).toHaveLength(2);
    expect(debug.every((r) => r.belowFloor && !r.lexical)).toBe(true);
  });

  it("needs at least half of the specific words, not one of five (#147)", async () => {
    const p = await project(t.db);
    // "charging", "station", "electric", "car", "lot": one of five is not
    // a word match (n14 shape).
    await withSimilarity(p.id, "Plenty of room in the parking lot.", 0.62);
    const q = twoTierQuery(
      p.id,
      "charging station for electric cars in the lot",
    );
    expect(await searchChunks(t.db, q)).toEqual([]);
  });

  it("debug: a low-tier pass is above the floor, and the page equals the default", async () => {
    const p = await project(t.db);
    await withSimilarity(p.id, "Veneers on my front teeth look natural.", 0.6);
    await withSimilarity(p.id, "Whitening left no sensitivity at all.", 0.6);

    const q = twoTierQuery(p.id, "veneers");
    const plain = await searchChunks(t.db, q);
    const debug = await searchChunks(t.db, { ...q, includeBelowFloor: true });
    const above = debug.filter((r) => !r.belowFloor);
    expect(above).toEqual(plain);
    expect(above.map((r) => r.lexical)).toEqual([true]);
    expect(debug.filter((r) => r.belowFloor).map((r) => r.lexical)).toEqual([
      false,
    ]);
  });

  it("has no lexical tier without query text", async () => {
    const p = await project(t.db);
    await withSimilarity(p.id, "Veneers on my front teeth look natural.", 0.6);
    const results = await searchChunks(t.db, {
      ...twoTierQuery(p.id, "veneers"),
      queryText: undefined,
    });
    expect(results).toEqual([]);
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

describe("tenant isolation: every reviews access is planned per tenant (#111, #117)", () => {
  const t = setupTestDb();

  /** The one btree every per-tenant read of `reviews` starts from. */
  const TENANT_INDEX = "reviews_project_id_environment_occurred_at_idx";

  /** One `EXPLAIN (FORMAT JSON)` plan node, recursively. */
  type PlanNode = {
    "Node Type": string;
    "Relation Name"?: string;
    "Index Name"?: string;
    "Sort Key"?: string[];
    Plans?: PlanNode[];
  };

  function walk(node: PlanNode, visit: (n: PlanNode) => void): void {
    visit(node);
    for (const child of node.Plans ?? []) walk(child, visit);
  }

  async function explain(
    db: Db,
    params: SearchChunksParams,
  ): Promise<PlanNode> {
    const rows = await db.execute<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
      sql`EXPLAIN (FORMAT JSON) ${searchChunksSql(params)}`,
    );
    const plan = rows[0]?.["QUERY PLAN"][0]?.Plan;
    if (!plan) throw new Error("EXPLAIN returned no plan");
    return plan;
  }

  /**
   * `count` publishable reviews for `projectId`, each with an embedded
   * `full` chunk, inserted in bulk — a tenant the size the factories would
   * take seconds to build one row at a time.
   */
  async function bulkTenant(
    db: Db,
    projectId: string,
    count: number,
  ): Promise<void> {
    const BATCH = 250;
    for (let start = 0; start < count; start += BATCH) {
      const n = Math.min(BATCH, count - start);
      const inserted = await db
        .insert(reviews)
        .values(
          Array.from({ length: n }, (_, j) => ({
            projectId,
            environment: "live" as const,
            source: "google",
            externalId: `bulk_${start + j}`,
            rating: 5,
            text: `${IMPLANT} Visit ${start + j}.`,
            occurredAt: new Date(Date.UTC(2026, 0, 1) + (start + j) * 60_000),
          })),
        )
        .returning({ id: reviews.id, text: reviews.text });
      await db.insert(reviewChunks).values(
        inserted.map((r) => ({
          reviewId: r.id,
          projectId,
          environment: "live" as const,
          kind: "full" as const,
          text: r.text,
          startOffset: 0,
          embedding: embed(r.text),
        })),
      );
    }
  }

  /**
   * `count` reviews for `projectId` with no chunks, in one statement: the
   * other tenants of a multi-tenant table. Only `reviews` has to be big
   * for these plans; nothing reads their chunks.
   */
  async function padTenant(
    db: Db,
    projectId: string,
    count: number,
  ): Promise<void> {
    await db.execute(sql`
      INSERT INTO reviews (project_id, environment, source, external_id, rating, text, occurred_at)
      SELECT ${projectId}::uuid, 'live', 'google', 'pad_' || g, 5, ${IMPLANT},
             timestamptz '2026-01-01' + g * interval '1 minute'
      FROM generate_series(1, ${count}) AS g`);
  }

  it("reads reviews through the tenant index, never a Seq Scan, with other tenants in the table", async () => {
    // One tenant of 500 reviews among twenty of 1,000: the tenant is ~2.5 %
    // of a 20,500-row table, the shape of `load-01` on the load database
    // (1,000 of 45k). The size matters for what this test can claim. With
    // four equal tenants in a 47-page table the planner rightly reads the
    // whole table for any of them — a bitmap scan touches every page too
    // once a tenant has more rows than the table has pages — and the
    // seq-scan/index-scan call comes down to a handful of index pages.
    // Here the table is big enough and the tenant small enough that an
    // index is decisively cheaper, so a Seq Scan on `reviews` in any plan
    // means the statement lost its tenant predicate (#111) or its index
    // (#117), not that the planner made a close call.
    const mine = await project(t.db);
    await bulkTenant(t.db, mine.id, 500);
    for (let i = 0; i < 20; i++) {
      await padTenant(t.db, (await project(t.db)).id, 1000);
    }
    await t.db.execute(sql`ANALYZE reviews`);
    await t.db.execute(sql`ANALYZE review_chunks`);

    // The three hybrid shapes share the `candidates` CTE and the result
    // join: their `reviews` access is an equality lookup on the tenant,
    // which any btree led by `(project_id, environment)` serves — the
    // tenant index or the upsert key's unique index, whichever the planner
    // costs lower (they tie at this size). The recency statement drives
    // from `reviews` itself and is asserted separately below: before #117
    // the planner answered "newest five" with a Parallel Seq Scan over
    // every tenant plus a top-N sort.
    const tenantPrefixed = [
      TENANT_INDEX,
      "reviews_project_env_source_external_id_unique",
    ];
    const params = query(mine.id, "painless implant", { limit: 5 });
    const variants: Array<[string, SearchChunksParams]> = [
      ["hybrid", params],
      ["vector only", { ...params, queryText: undefined }],
      ["includeBelowFloor", { ...params, includeBelowFloor: true }],
    ];

    for (const [name, p] of variants) {
      const plan = await explain(t.db, p);
      const reviewScans: PlanNode[] = [];
      const indexes = new Set<string>();
      walk(plan, (n) => {
        if (n["Relation Name"] === "reviews") reviewScans.push(n);
        if (n["Index Name"]?.startsWith("reviews_"))
          indexes.add(n["Index Name"]);
      });

      expect(
        reviewScans.length,
        `${name}: reviews is read at all`,
      ).toBeGreaterThan(0);
      expect(
        reviewScans.map((n) => n["Node Type"]),
        `${name}: no Seq Scan on reviews`,
      ).not.toContain("Seq Scan");
      expect(
        [...indexes].some((i) => tenantPrefixed.includes(i)),
        `${name}: a tenant-prefixed index drives the reviews access (saw ${[...indexes].join(", ")})`,
      ).toBe(true);
    }

    // Recency (#117): the index's trailing `occurred_at DESC NULLS LAST, id`
    // matches the ORDER BY, so it is a plain Index Scan under the LIMIT —
    // no bitmap, no sort on occurred_at, no parallel workers.
    const recency = await explain(t.db, {
      ...params,
      queryEmbedding: undefined,
      queryText: undefined,
    });
    const nodeTypes: string[] = [];
    const sortKeys: string[] = [];
    walk(recency, (n) => {
      nodeTypes.push(n["Node Type"]);
      if (n["Relation Name"] === "reviews") {
        expect(n["Node Type"]).toBe("Index Scan");
        expect(n["Index Name"]).toBe(TENANT_INDEX);
      }
      sortKeys.push(...(n["Sort Key"] ?? []));
    });
    expect(sortKeys.join(" "), "recency: no sort on occurred_at").not.toMatch(
      /occurred_at/,
    );
    expect(nodeTypes, "recency: no parallel plan").not.toContain(
      "Gather Merge",
    );

    // And the fix changed the plan, not the answer: the tenant's rows only.
    const results = await searchChunks(t.db, params);
    expect(results).toHaveLength(5);
    const [row] = await t.db
      .select({ projectId: reviews.projectId })
      .from(reviews)
      .where(sql`${reviews.id} IN ${results.map((r) => r.reviewId)}`)
      .groupBy(reviews.projectId);
    expect(row?.projectId).toBe(mine.id);
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

  // Sentence chunks (#127): a four-sentence review indexed by the real
  // chunker has seven chunks — full, two windows, four sentences. When only
  // the second sentence is about the query, that sentence is a tighter
  // match than the window around it (the fake embedder's cosine is
  // shared/sqrt(|q|·|chunk|) over content words, so the extra words of the
  // window and the full chunk only dilute it), and the collapse still
  // yields one row per review — quoting the sentence.
  const FOUR =
    "Parking behind the building was easy. The implant procedure was painless and quick. Front desk explained every charge. Our kids love the hygienist.";
  const SENTENCE_TWO = "The implant procedure was painless and quick.";
  // A second, single-sentence review on the same topic but a weaker match
  // ({painless, implant, honestly}: 2/sqrt(3·3) ≈ 0.67 against the
  // sentence's 3/sqrt(3·4) ≈ 0.87), so the order between the two reviews
  // is never a tie.
  const WEAKER = "Painless implant, honestly.";

  it.each([
    "excerpts",
    "reviews",
  ] as const)("%s: a sentence chunk wins over its window when it is the better match, one row per review", async (mode) => {
    const p = await project(t.db);
    const four = await indexedByChunker(t.db, { projectId: p.id, text: FOUR });
    const single = await indexedByChunker(t.db, {
      projectId: p.id,
      text: WEAKER,
    });
    const stored = await t.db
      .select({ kind: reviewChunks.kind })
      .from(reviewChunks)
      .where(eq(reviewChunks.reviewId, four.id));
    expect(stored.map((c) => c.kind).sort()).toEqual(
      [
        "full",
        "window",
        "window",
        "sentence",
        "sentence",
        "sentence",
        "sentence",
      ].sort(),
    );

    const results = await searchChunks(
      t.db,
      query(p.id, "painless implant procedure", { mode, policy: OPEN_FLOOR }),
    );
    // One row per review, the multi-sentence one first.
    expect(results.map((r) => r.reviewId)).toEqual([four.id, single.id]);

    const [top] = results;
    expect(top?.excerpt).toBe(SENTENCE_TWO);
    expect(top?.startOffset).toBe(FOUR.indexOf(SENTENCE_TWO));
    expect(
      FOUR.slice(
        top?.startOffset ?? 0,
        (top?.startOffset ?? 0) + SENTENCE_TWO.length,
      ),
    ).toBe(SENTENCE_TWO);
    // ...and that chunk is the `sentence` row, not the window containing it.
    const [winner] = await t.db
      .select({ kind: reviewChunks.kind, text: reviewChunks.text })
      .from(reviewChunks)
      .where(eq(reviewChunks.id, top?.chunkId ?? ""));
    expect(winner).toEqual({ kind: "sentence", text: SENTENCE_TWO });
    // Under the default floor the answer is the same.
    const strict = await searchChunks(
      t.db,
      query(p.id, "painless implant procedure", { mode }),
    );
    expect(strict.map((r) => [r.reviewId, r.excerpt])).toEqual([
      [four.id, SENTENCE_TWO],
      [single.id, WEAKER],
    ]);
    expect(top?.similarity).toBeCloseTo(3 / Math.sqrt(12), 2);
    expect(results[1]?.similarity).toBeCloseTo(2 / 3, 2);
  });
});

describe("ties prefer the narrower chunk, never a random uuid", () => {
  const t = setupTestDb();

  // A four-sentence review where only the third sentence is about the
  // query. `ts_rank_cd` scores covers, not length, so the sentence, both
  // windows containing it and the full chunk tie *exactly* in the text
  // branch; before the `breadth` tie-break that tie fell to the chunk ids,
  // which are random uuids in production. The ids below are chosen
  // adversarially — every wider chunk sorts before the sentence — so the
  // old ordering fails here every run instead of ~2 runs in 5.
  const FOUR =
    "Parking behind the building was easy. 🙏 The front desk was warm. Whitening made a visible difference for my wedding photos. Our kids love the hygienist.";
  const SENTENCE = "Whitening made a visible difference for my wedding photos.";
  const WINDOW_BEFORE = FOUR.slice(0, FOUR.indexOf(" Our kids"));
  const WINDOW_AFTER = FOUR.slice(FOUR.indexOf(SENTENCE));
  const Q = "whitening wedding photos";

  const id = (n: number) =>
    `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

  async function chunkAt(
    reviewId: string,
    chunkId: string,
    kind: "full" | "window" | "sentence",
    text: string,
    embedding: number[],
  ): Promise<void> {
    await chunk(t.db, {
      id: chunkId,
      reviewId,
      kind,
      text,
      startOffset: FOUR.indexOf(text),
      embedding,
    });
  }

  async function winner(chunkId: string | undefined) {
    const [row] = await t.db
      .select({ kind: reviewChunks.kind, text: reviewChunks.text })
      .from(reviewChunks)
      .where(eq(reviewChunks.id, chunkId ?? ""));
    return row;
  }

  it.each([
    "excerpts",
    "reviews",
  ] as const)("%s: a text-rank tie cannot hand a wider chunk the win over the sentence that answered", async (mode) => {
    const p = await project(t.db);
    const r = await review(t.db, { projectId: p.id, text: FOUR });
    const base = mode === "excerpts" ? 0x100 : 0x200;
    // Wider chunks first by id; the sentence last.
    await chunkAt(
      r.id,
      id(base + 1),
      "window",
      WINDOW_AFTER,
      embed(WINDOW_AFTER),
    );
    await chunkAt(r.id, id(base + 2), "full", FOUR, embed(FOUR));
    await chunkAt(
      r.id,
      id(base + 3),
      "window",
      WINDOW_BEFORE,
      embed(WINDOW_BEFORE),
    );
    await chunkAt(r.id, id(base + 4), "sentence", SENTENCE, embed(SENTENCE));

    // The premise: an exact tie in the text branch.
    const ranks = await t.db.execute<{ rank: number }>(sql`
      SELECT DISTINCT ts_rank_cd(tsv, websearch_to_tsquery('english', ${Q}))::float8 AS rank
      FROM review_chunks WHERE review_id = ${r.id} AND tsv @@ websearch_to_tsquery('english', ${Q})`);
    expect(ranks).toHaveLength(1);

    const results = await searchChunks(t.db, query(p.id, Q, { mode }));
    expect(results.map((x) => x.reviewId)).toEqual([r.id]);
    expect(results[0]?.excerpt).toBe(SENTENCE);
    expect(results[0]?.startOffset).toBe(FOUR.indexOf(SENTENCE));
    expect(await winner(results[0]?.chunkId)).toEqual({
      kind: "sentence",
      text: SENTENCE,
    });
  });

  it("at an equal fused score and equal similarity: sentence over window over full", async () => {
    const p = await project(t.db);
    const r = await review(t.db, { projectId: p.id, text: FOUR });
    // Identical embeddings and an identical text rank: every ranking ties,
    // and only the tie-break decides. Ids favour the widest chunk.
    const same = embed(SENTENCE);
    await chunkAt(r.id, id(0x301), "full", FOUR, same);
    await chunkAt(r.id, id(0x302), "window", WINDOW_AFTER, same);
    await chunkAt(r.id, id(0x303), "sentence", SENTENCE, same);

    const all = await searchChunks(t.db, query(p.id, Q));
    expect(all.map((x) => x.excerpt)).toEqual([SENTENCE]);

    // Without the sentence, the window beats the full chunk.
    await t.db.delete(reviewChunks).where(eq(reviewChunks.id, id(0x303)));
    const noSentence = await searchChunks(t.db, query(p.id, Q));
    expect(noSentence.map((x) => x.excerpt)).toEqual([WINDOW_AFTER]);

    // The debug variant collapses with the same tie-break.
    const debug = await searchChunks(
      t.db,
      query(p.id, Q, { includeBelowFloor: true }),
    );
    expect(debug.map((x) => [x.excerpt, x.belowFloor])).toEqual([
      [WINDOW_AFTER, false],
    ]);
  });
});

describe("offsets are UTF-16 code units (#85 highlight)", () => {
  const t = setupTestDb();

  // A surrogate-pair emoji, a one-unit symbol, and CJK ahead of the window:
  // the UTF-16 offset is neither the code-point count nor the byte count,
  // and `startOffset` must be the one `String.prototype.slice` wants.
  const TEXT =
    "🦷✨ 歯医者さん, five stars. The front desk was warm. The implant procedure was painless and quick. Parking was fine.";
  const WINDOW = "The implant procedure was painless and quick.";

  it("returns a window's startOffset such that review.text.slice(...) is the excerpt", async () => {
    const start = TEXT.indexOf(WINDOW);
    expect([...TEXT.slice(0, start)].length).not.toBe(start);
    expect(new TextEncoder().encode(TEXT.slice(0, start)).length).not.toBe(
      start,
    );

    const p = await project(t.db);
    const r = await indexed(t.db, { projectId: p.id, text: TEXT }, [WINDOW]);

    for (const mode of ["excerpts", "reviews"] as const) {
      const [top] = await searchChunks(
        t.db,
        query(p.id, "painless implant procedure", { mode }),
      );
      expect(top?.reviewId).toBe(r.id);
      expect(top?.excerpt).toBe(WINDOW);
      expect(top?.startOffset).toBe(start);
      expect(
        top?.review.text.slice(
          top.startOffset,
          top.startOffset + top.excerpt.length,
        ),
      ).toBe(WINDOW);
    }
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

describe("debug: includeBelowFloor", () => {
  const t = setupTestDb();

  // Shares one content word with "painless implant" (similarity ~0.41):
  // below the default floor, above zero — a candidate the floor drops.
  const NEAR = "The implant process was simple and fast.";

  it("appends the floored candidates, flagged, after an identical above-floor page", async () => {
    const p = await project(t.db);
    const hit = await indexed(t.db, { projectId: p.id, text: IMPLANT });
    const near = await indexed(t.db, { projectId: p.id, text: NEAR });
    await indexed(t.db, { projectId: p.id, text: PARKING });
    // Policy still applies before the floor: a 2-star review is not a
    // "candidate the floor dropped", it never took part.
    await indexed(t.db, { projectId: p.id, text: IMPLANT, rating: 2 });

    const plain = await searchChunks(t.db, query(p.id, "painless implant"));
    const debug = await searchChunks(
      t.db,
      query(p.id, "painless implant", { includeBelowFloor: true }),
    );

    expect(plain.map((r) => r.reviewId)).toEqual([hit.id]);
    expect(plain.every((r) => r.belowFloor === false)).toBe(true);

    const above = debug.filter((r) => !r.belowFloor);
    const below = debug.filter((r) => r.belowFloor);
    // The above-floor rows are the default result, byte for byte.
    expect(above).toEqual(plain);
    // Above-floor rows come first; below-floor rows follow in rank order.
    expect(debug.slice(0, above.length)).toEqual(above);
    expect(below.map((r) => r.reviewId)).toEqual([near.id, expect.any(String)]);
    expect(below[0]?.similarity).toBeLessThan(DEFAULT_POLICY.similarityFloor);
    expect(below[0]?.similarity).toBeGreaterThan(0);
    expect(below[1]?.excerpt).toBe(PARKING);
    expect(below[1]?.similarity).toBeCloseTo(0, 2);
  });

  it("never lists a review on both sides of the floor, and honours limit per side", async () => {
    const p = await project(t.db);
    // One review whose window clears the floor (~0.82) and whose full
    // chunk does not (~0.45): one row, above the floor, never a second one.
    const TEXT =
      "Painless implant, honestly. The front desk explained every charge.";
    const both = await indexed(t.db, { projectId: p.id, text: TEXT }, [
      "Painless implant, honestly.",
    ]);
    const nears: string[] = [];
    for (let i = 0; i < 3; i++) {
      nears.push(
        (
          await indexed(t.db, {
            projectId: p.id,
            text: NEAR,
            occurredAt: new Date(`2026-0${i + 1}-01T00:00:00Z`),
          })
        ).id,
      );
    }

    const debug = await searchChunks(
      t.db,
      query(p.id, "painless implant", { includeBelowFloor: true, limit: 2 }),
    );
    const above = debug.filter((r) => !r.belowFloor);
    const below = debug.filter((r) => r.belowFloor);
    expect(above.map((r) => r.reviewId)).toEqual([both.id]);
    expect(above[0]?.excerpt).toBe("Painless implant, honestly.");
    expect(below).toHaveLength(2);
    expect(below.map((r) => r.reviewId)).not.toContain(both.id);
    // Ties on similarity break newest-first, as everywhere else.
    expect(below.map((r) => r.reviewId)).toEqual([nears[2], nears[1]]);
  });

  it("is a no-op in no-query mode", async () => {
    const p = await project(t.db);
    await indexed(t.db, { projectId: p.id, text: IMPLANT });
    const results = await searchChunks(t.db, {
      projectId: p.id,
      environment: "live",
      limit: 5,
      policy: DEFAULT_POLICY,
      mode: "excerpts",
      includeBelowFloor: true,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.belowFloor).toBe(false);
    expect(results[0]?.similarity).toBeNull();
  });
});
