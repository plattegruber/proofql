/**
 * Schema-level constraints from scope.md §4, exercised against the real
 * migration: the reviews upsert key, cascades, the verbatim-slice invariant
 * at the write path, environment and project isolation, the halfvec
 * roundtrip with cosine distance, the generated tsvector, and the usage
 * primary key.
 */

import { and, sql as dsql, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { VerbatimSliceError } from "../src/chunks.js";
import { reviewChunks } from "../src/schema/reviewChunks.js";
import { reviews } from "../src/schema/reviews.js";
import { projects } from "../src/schema/tenancy.js";
import { usage } from "../src/schema/usage.js";
import {
  apiKey,
  chunk,
  DEFAULT_REVIEW_TEXT,
  project,
  review,
  unitVector,
} from "./factories.js";
import {
  CHECK_VIOLATION,
  pgError,
  setupTestDb,
  UNIQUE_VIOLATION,
} from "./harness.js";

describe("reviews: unique (project_id, environment, source, external_id)", () => {
  const t = setupTestDb();

  it("rejects a duplicate in the same project, environment and source", async () => {
    const r = await review(t.db, { externalId: "abc" });
    const { code } = await pgError(
      review(t.db, {
        projectId: r.projectId,
        environment: r.environment,
        source: r.source,
        externalId: "abc",
      }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it("allows the same external_id in the other environment, another source, or another project", async () => {
    const r = await review(t.db, { externalId: "shared" });
    await review(t.db, {
      projectId: r.projectId,
      environment: "test",
      externalId: "shared",
    });
    await review(t.db, {
      projectId: r.projectId,
      source: "yelp",
      externalId: "shared",
    });
    await review(t.db, { externalId: "shared" }); // fresh project
    const all = await t.db
      .select()
      .from(reviews)
      .where(eq(reviews.externalId, "shared"));
    expect(all).toHaveLength(4);
  });

  it("rejects ratings outside 1..5 but accepts null", async () => {
    const { code } = await pgError(review(t.db, { rating: 6 }));
    expect(code).toBe(CHECK_VIOLATION);
    const unrated = await review(t.db, { rating: null, source: "facebook" });
    expect(unrated.rating).toBeNull();
    expect(unrated.sentiment).toBeNull();
    expect(unrated.sentimentSource).toBeNull();
  });
});

describe("cascades", () => {
  const t = setupTestDb();

  it("deleting a review deletes its chunks", async () => {
    const r = await review(t.db);
    await chunk(t.db, { reviewId: r.id });
    await chunk(t.db, {
      reviewId: r.id,
      kind: "window",
      text: "Parking behind the building was easy.",
      startOffset: DEFAULT_REVIEW_TEXT.indexOf("Parking"),
    });
    expect(
      await t.db
        .select()
        .from(reviewChunks)
        .where(eq(reviewChunks.reviewId, r.id)),
    ).toHaveLength(2);

    await t.db.delete(reviews).where(eq(reviews.id, r.id));
    expect(
      await t.db
        .select()
        .from(reviewChunks)
        .where(eq(reviewChunks.reviewId, r.id)),
    ).toHaveLength(0);
  });

  it("deleting a project deletes its reviews, chunks and keys", async () => {
    const p = await project(t.db);
    const r = await review(t.db, { projectId: p.id });
    await chunk(t.db, { reviewId: r.id });
    await apiKey(t.db, { projectId: p.id });

    await t.db.delete(projects).where(eq(projects.id, p.id));
    expect(
      await t.db.select().from(reviews).where(eq(reviews.projectId, p.id)),
    ).toHaveLength(0);
    expect(
      await t.db
        .select()
        .from(reviewChunks)
        .where(eq(reviewChunks.projectId, p.id)),
    ).toHaveLength(0);
  });
});

describe("verbatim-slice invariant at the write path", () => {
  const t = setupTestDb();

  it("stores a window chunk that is a true slice of its review", async () => {
    const r = await review(t.db);
    const text = "The front desk explained every charge before I paid.";
    const startOffset = r.text.indexOf(text);
    const c = await chunk(t.db, {
      reviewId: r.id,
      kind: "window",
      text,
      startOffset,
    });
    expect(r.text.slice(c.startOffset, c.startOffset + c.text.length)).toBe(
      c.text,
    );
  });

  it("refuses a chunk whose text is not a slice of its review", async () => {
    const r = await review(t.db);
    await expect(
      chunk(t.db, {
        reviewId: r.id,
        kind: "window",
        text: "The front desk was rude about every charge.",
        startOffset: r.text.indexOf("The front desk"),
      }),
    ).rejects.toBeInstanceOf(VerbatimSliceError);
    expect(
      await t.db
        .select()
        .from(reviewChunks)
        .where(eq(reviewChunks.reviewId, r.id)),
    ).toHaveLength(0);
  });

  it("the database still rejects a negative start_offset on its own", async () => {
    const r = await review(t.db);
    const { code } = await pgError(
      chunk(
        t.db,
        { reviewId: r.id, text: r.text, startOffset: -1 },
        { skipVerbatimCheck: true },
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe("environment and project isolation smoke", () => {
  const t = setupTestDb();

  it("filtering chunks by (project_id, environment) returns only that tenant's rows", async () => {
    const p1 = await project(t.db);
    const p2 = await project(t.db);
    const live1 = await review(t.db, { projectId: p1.id, environment: "live" });
    const test1 = await review(t.db, { projectId: p1.id, environment: "test" });
    const live2 = await review(t.db, { projectId: p2.id, environment: "live" });
    await chunk(t.db, { reviewId: live1.id });
    await chunk(t.db, { reviewId: test1.id });
    await chunk(t.db, { reviewId: live2.id });

    const rows = await t.db
      .select({ reviewId: reviewChunks.reviewId })
      .from(reviewChunks)
      .where(
        and(
          eq(reviewChunks.projectId, p1.id),
          eq(reviewChunks.environment, "live"),
        ),
      );
    expect(rows.map((r) => r.reviewId)).toEqual([live1.id]);
  });

  it("wiping a project's test environment leaves live rows untouched", async () => {
    const p = await project(t.db);
    await review(t.db, { projectId: p.id, environment: "live" });
    await review(t.db, { projectId: p.id, environment: "test" });
    await review(t.db, { projectId: p.id, environment: "test" });

    await t.db
      .delete(reviews)
      .where(and(eq(reviews.projectId, p.id), eq(reviews.environment, "test")));
    const left = await t.db
      .select()
      .from(reviews)
      .where(eq(reviews.projectId, p.id));
    expect(left).toHaveLength(1);
    expect(left[0]?.environment).toBe("live");
  });

  it("rejects an environment outside the enum", async () => {
    const { code } = await pgError(
      review(t.db, { environment: "staging" as "live" }),
    );
    expect(code).toBe("22P02");
  });
});

describe("halfvec(1024) embeddings", () => {
  const t = setupTestDb();

  it("round-trips a 1024-dim vector", async () => {
    const embedding = unitVector(7);
    const c = await chunk(t.db, { embedding });
    expect(c.embedding).toHaveLength(1024);
    expect(c.embedding).toEqual(embedding);

    const [read] = await t.db
      .select({ embedding: reviewChunks.embedding })
      .from(reviewChunks)
      .where(eq(reviewChunks.id, c.id));
    expect(read?.embedding).toEqual(embedding);
  });

  it("rejects a vector of the wrong dimensionality", async () => {
    const { message } = await pgError(chunk(t.db, { embedding: [1, 0, 0] }));
    expect(message).toMatch(/expected 1024 dimensions/);
  });

  it("supports cosine distance (<=>) over a tenant's rows, nearest first", async () => {
    const p = await project(t.db);
    const same = await chunk(t.db, {
      projectId: p.id,
      embedding: unitVector(0),
    });
    const orthogonal = await chunk(t.db, {
      projectId: p.id,
      embedding: unitVector(1),
    });
    const halfway = await chunk(t.db, {
      projectId: p.id,
      embedding: unitVector(0).map((v, i) => (i === 0 || i === 1 ? 0.5 : v)),
    });
    await chunk(t.db, { projectId: p.id }); // embedding NULL — must not match

    const query = JSON.stringify(unitVector(0));
    const rows = await t.sql<{ id: string; distance: number }[]>`
      SELECT id, embedding <=> ${query}::halfvec(1024) AS distance
      FROM review_chunks
      WHERE project_id = ${p.id} AND environment = 'live'
        AND embedding IS NOT NULL
      ORDER BY distance ASC
    `;
    expect(rows.map((r) => r.id)).toEqual([same.id, halfway.id, orthogonal.id]);
    expect(rows[0]?.distance).toBeCloseTo(0, 5);
    expect(rows[1]?.distance).toBeCloseTo(1 - Math.SQRT1_2, 3);
    expect(rows[2]?.distance).toBeCloseTo(1, 5);
  });
});

describe("generated tsvector", () => {
  const t = setupTestDb();

  it("is populated from text on insert and matches a full-text query", async () => {
    const c = await chunk(t.db);
    const [row] = await t.db.execute<{ tsv: string }>(
      dsql`SELECT tsv::text AS tsv FROM review_chunks WHERE id = ${c.id}`,
    );
    expect(row?.tsv).toContain("implant");

    const hits = await t.sql<{ id: string }[]>`
      SELECT id FROM review_chunks
      WHERE tsv @@ plainto_tsquery('english', 'parking')
    `;
    expect(hits.map((h) => h.id)).toEqual([c.id]);
  });
});

describe("usage: primary key (project_id, month)", () => {
  const t = setupTestDb();

  it("upserts counters with ON CONFLICT on the composite key", async () => {
    const p = await project(t.db);
    const month = "2026-10-01";
    for (const cached of [false, true, true]) {
      await t.db
        .insert(usage)
        .values({
          projectId: p.id,
          month,
          queries: 1,
          cacheHits: cached ? 1 : 0,
        })
        .onConflictDoUpdate({
          target: [usage.projectId, usage.month],
          set: {
            queries: dsql`${usage.queries} + 1`,
            cacheHits: dsql`${usage.cacheHits} + ${cached ? 1 : 0}`,
          },
        });
    }
    const rows = await t.db
      .select()
      .from(usage)
      .where(eq(usage.projectId, p.id));
    expect(rows).toEqual([
      { projectId: p.id, month, queries: 3, cacheHits: 2 },
    ]);
  });

  it("rejects a second row for the same project and month", async () => {
    const p = await project(t.db);
    await t.db.insert(usage).values({ projectId: p.id, month: "2026-10-01" });
    const { code } = await pgError(
      t.db.insert(usage).values({ projectId: p.id, month: "2026-10-01" }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });
});
