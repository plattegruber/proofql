/**
 * `upsertReviews` against the real schema. The `reject` policy is covered
 * end to end by the api worker's `POST /v1/reviews` tests; this file pins
 * the `truncate` policy the CSV import relies on, and the invariants both
 * callers share (dedupe, queue messages only after a write that needs one).
 */

import type { ReviewInput } from "@proofql/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { project, review, setupTestDb } from "../../test/index.js";
import { projects, reviews } from "../schema/index.js";
import {
  ProjectNotFoundError,
  ReviewLimitError,
  upsertReviews,
} from "./upsertReviews.js";

const t = setupTestDb();

function input(n: number, overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    external_id: `ext-${n}`,
    source: "google",
    rating: 5,
    text: `Review ${n}: thorough and gentle.`,
    author_name: `Author ${n}`,
    author_avatar_url: null,
    occurred_at: "2026-03-14T18:20:00Z",
    url: null,
    ...overrides,
  };
}

async function reviewCount(projectId: string) {
  const [row] = await t.db
    .select({ reviewCount: projects.reviewCount })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row?.reviewCount;
}

describe("upsertReviews", () => {
  it("truncate: inserts what fits in input order and hands back the rest", async () => {
    const p = await project(t.db, { reviewCount: 4_997 });
    await review(t.db, { projectId: p.id, externalId: "ext-9" });

    const result = await upsertReviews(t.db, {
      projectId: p.id,
      environment: "live",
      onLimit: "truncate",
      reviews: [
        input(1),
        input(9, { text: "updated text" }), // an update: never counts against the cap
        input(2),
        input(3),
        input(4),
        input(4), // in-batch duplicate
      ],
    });

    expect(result).toMatchObject({
      created: 3,
      updated: 1,
      skipped: 1,
      limit: 5_000,
      reviewCount: 5_000,
    });
    expect(result.rejected.map((r) => r.external_id)).toEqual(["ext-4"]);
    expect(result.reviews.map((r) => r.external_id)).toEqual([
      "ext-1",
      "ext-9",
      "ext-2",
      "ext-3",
    ]);
    // Three inserts plus the changed-text update need indexing.
    expect(result.toEnqueue).toHaveLength(4);
    expect(result.toEnqueue[0]).toMatchObject({
      type: "review.index",
      projectId: p.id,
      environment: "live",
    });
    expect(await reviewCount(p.id)).toBe(5_000);
    const stored = await t.db
      .select()
      .from(reviews)
      .where(eq(reviews.projectId, p.id));
    expect(stored).toHaveLength(4);
  });

  it("truncate at the cap rejects every insert, still applies updates, writes nothing new", async () => {
    const p = await project(t.db, { reviewCount: 5_000 });
    const existing = await review(t.db, {
      projectId: p.id,
      externalId: "ext-1",
      rating: 5,
      text: input(1).text,
    });

    const result = await upsertReviews(t.db, {
      projectId: p.id,
      environment: "live",
      onLimit: "truncate",
      reviews: [input(1, { rating: 4 }), input(2)],
    });

    expect(result).toMatchObject({ created: 0, updated: 1, skipped: 0 });
    expect(result.rejected).toHaveLength(1);
    expect(result.toEnqueue).toEqual([]); // unchanged text, rating present
    const [row] = await t.db
      .select()
      .from(reviews)
      .where(eq(reviews.id, existing.id));
    expect(row?.rating).toBe(4);
    expect(await reviewCount(p.id)).toBe(5_000);
  });

  it("reject: throws ReviewLimitError with the plan numbers and writes nothing", async () => {
    const p = await project(t.db, { reviewCount: 4_999 });
    await expect(
      upsertReviews(t.db, {
        projectId: p.id,
        environment: "live",
        reviews: [input(1), input(2)],
      }),
    ).rejects.toMatchObject({
      name: "ReviewLimitError",
      limit: 5_000,
      reviewCount: 4_999,
      wouldAdd: 2,
      remaining: 1,
    });
    expect(await reviewCount(p.id)).toBe(4_999);
    expect(new ReviewLimitError(5_000, 4_999, 2).message).toMatch(/5000/);
  });

  it("throws ProjectNotFoundError for a missing project", async () => {
    await expect(
      upsertReviews(t.db, {
        projectId: "00000000-0000-4000-8000-000000000000",
        environment: "live",
        reviews: [input(1)],
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("an empty batch is a no-op", async () => {
    const p = await project(t.db);
    const result = await upsertReviews(t.db, {
      projectId: p.id,
      environment: "test",
      reviews: [],
    });
    expect(result).toMatchObject({
      reviews: [],
      created: 0,
      updated: 0,
      skipped: 0,
      rejected: [],
      toEnqueue: [],
    });
  });
});
