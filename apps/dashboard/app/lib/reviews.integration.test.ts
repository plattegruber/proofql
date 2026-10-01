// Review browser against the real schema: keyset pagination and filters,
// and hide/unhide — single and bulk — setting/clearing hidden_at and
// bumping the project's cache generation exactly once per action.
import { MemoryKv, generationKey } from "@proofql/core";
import { chunk, project, review, setupTestDb } from "@proofql/db/test";
import { describe, expect, it } from "vitest";

import { PAGE_SIZE } from "./reviews";
import {
  getReviewDetail,
  listReviews,
  listReviewSources,
  setReviewsHidden,
} from "./reviews.server";

const t = setupTestDb();

function at(day: number): Date {
  return new Date(Date.UTC(2026, 0, 1 + day, 12, 0, 0, 123));
}

describe("listReviews", () => {
  it("pages 25 at a time by (occurred_at desc, id desc) with a cursor that continues exactly", async () => {
    const p = await project(t.db);
    for (let i = 0; i < 30; i++) {
      await review(t.db, { projectId: p.id, occurredAt: at(i) });
    }
    // Two rows share a timestamp: the id tie-break must not skip or repeat.
    await review(t.db, { projectId: p.id, occurredAt: at(29) });
    // Undated rows sort last, in the trailing null block.
    await review(t.db, { projectId: p.id, occurredAt: null });
    await review(t.db, { projectId: p.id, occurredAt: null });
    // Another environment and another project never show.
    await review(t.db, { projectId: p.id, environment: "test" });
    await review(t.db);

    const first = await listReviews(t.db, {
      projectId: p.id,
      environment: "live",
    });
    expect(first.rows).toHaveLength(PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    expect(first.rows[0]?.occurredAt?.toISOString()).toBe(at(29).toISOString());

    const second = await listReviews(t.db, {
      projectId: p.id,
      environment: "live",
      cursor: first.nextCursor,
    });
    expect(second.rows).toHaveLength(33 - PAGE_SIZE);
    expect(second.nextCursor).toBeNull();
    expect(second.rows.slice(-2).every((r) => r.occurredAt === null)).toBe(true);

    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(33);

    // A malformed cursor starts over instead of erroring.
    const reset = await listReviews(t.db, {
      projectId: p.id,
      environment: "live",
      cursor: "garbage!",
    });
    expect(reset.rows[0]?.id).toBe(first.rows[0]?.id);
  });

  it("filters by source, min rating, hidden, and indexed, and counts chunks", async () => {
    const p = await project(t.db);
    const base = { projectId: p.id, indexedAt: new Date() };
    const yelp5 = await review(t.db, { ...base, source: "yelp", rating: 5 });
    await chunk(t.db, { reviewId: yelp5.id });
    await chunk(t.db, {
      reviewId: yelp5.id,
      kind: "window",
      text: "Dr. Patel did my implant",
      startOffset: 0,
    });
    const google3 = await review(t.db, { ...base, source: "google", rating: 3 });
    const hidden = await review(t.db, {
      ...base,
      source: "google",
      rating: 5,
      hiddenAt: new Date(),
    });
    const pending = await review(t.db, {
      projectId: p.id,
      source: "google",
      rating: 4,
      indexedAt: null,
    });
    const unrated = await review(t.db, { ...base, source: "custom", rating: null });

    const ids = async (filters: Parameters<typeof listReviews>[1]["filters"]) =>
      (
        await listReviews(t.db, { projectId: p.id, environment: "live", filters })
      ).rows
        .map((r) => r.id)
        .sort();

    expect(await ids({ source: "yelp" })).toEqual([yelp5.id]);
    expect(await ids({ minRating: 4 })).toEqual(
      [yelp5.id, hidden.id, pending.id].sort(),
    );
    expect(await ids({ hidden: "hidden" })).toEqual([hidden.id]);
    expect(await ids({ hidden: "visible" })).toEqual(
      [yelp5.id, google3.id, pending.id, unrated.id].sort(),
    );
    expect(await ids({ indexed: "pending" })).toEqual([pending.id]);
    expect(await ids({ indexed: "indexed", source: "google" })).toEqual(
      [google3.id, hidden.id].sort(),
    );

    const all = await listReviews(t.db, { projectId: p.id, environment: "live" });
    const counts = new Map(all.rows.map((r) => [r.id, r.chunkCount]));
    expect(counts.get(yelp5.id)).toBe(2);
    expect(counts.get(google3.id)).toBe(0);

    expect(
      await listReviewSources(t.db, { projectId: p.id, environment: "live" }),
    ).toEqual(["custom", "google", "yelp"]);
  });
});

describe("getReviewDetail", () => {
  it("returns the review with its chunks in text order, full first, and whether each is embedded", async () => {
    const p = await project(t.db);
    const r = await review(t.db, { projectId: p.id });
    const vector = new Array<number>(1024).fill(0);
    vector[3] = 1;
    await chunk(t.db, {
      reviewId: r.id,
      kind: "window",
      text: "The front desk explained every charge before I paid.",
      startOffset: r.text.indexOf("The front desk"),
      embedding: vector,
    });
    await chunk(t.db, { reviewId: r.id, kind: "full" });

    const detail = await getReviewDetail(t.db, { projectId: p.id, id: r.id });
    expect(detail?.review.id).toBe(r.id);
    expect(detail?.chunks.map((c) => [c.kind, c.embedded])).toEqual([
      ["full", false],
      ["window", true],
    ]);

    const other = await project(t.db);
    expect(await getReviewDetail(t.db, { projectId: other.id, id: r.id })).toBeNull();
  });
});

describe("setReviewsHidden", () => {
  it("hides and unhides one review, bumping the generation once each time", async () => {
    const p = await project(t.db);
    const r = await review(t.db, { projectId: p.id });
    const kv = new MemoryKv();
    const scope = { projectId: p.id, environment: "live" as const };

    const hid = await setReviewsHidden(t.db, kv, { ...scope, ids: [r.id], hidden: true });
    expect(hid).toEqual({ changed: 1, generation: 1 });
    const afterHide = await getReviewDetail(t.db, { projectId: p.id, id: r.id });
    expect(afterHide?.review.hiddenAt).toBeInstanceOf(Date);
    expect(kv.store.get(generationKey(p.id))).toBe("1");

    // Already hidden: no write, no purge.
    const again = await setReviewsHidden(t.db, kv, { ...scope, ids: [r.id], hidden: true });
    expect(again).toEqual({ changed: 0, generation: null });
    expect(kv.puts).toHaveLength(1);

    const unhid = await setReviewsHidden(t.db, kv, { ...scope, ids: [r.id], hidden: false });
    expect(unhid).toEqual({ changed: 1, generation: 2 });
    const afterUnhide = await getReviewDetail(t.db, { projectId: p.id, id: r.id });
    expect(afterUnhide?.review.hiddenAt).toBeNull();
    expect(kv.puts).toHaveLength(2);
  });

  it("bulk-hides many rows in one statement and one bump, ignoring rows outside the scope", async () => {
    const p = await project(t.db);
    const rows = [];
    for (let i = 0; i < 4; i++) rows.push(await review(t.db, { projectId: p.id }));
    const alreadyHidden = await review(t.db, { projectId: p.id, hiddenAt: new Date() });
    const testEnv = await review(t.db, { projectId: p.id, environment: "test" });
    const foreign = await review(t.db);
    const kv = new MemoryKv({ [generationKey(p.id)]: "41" });

    const result = await setReviewsHidden(t.db, kv, {
      projectId: p.id,
      environment: "live",
      ids: [...rows.map((r) => r.id), alreadyHidden.id, testEnv.id, foreign.id],
      hidden: true,
    });
    expect(result).toEqual({ changed: 4, generation: 42 });
    expect(kv.puts).toEqual([{ key: generationKey(p.id), value: "42" }]);

    const hiddenNow = await listReviews(t.db, {
      projectId: p.id,
      environment: "live",
      filters: { hidden: "hidden" },
    });
    expect(hiddenNow.rows.map((r) => r.id).sort()).toEqual(
      [...rows.map((r) => r.id), alreadyHidden.id].sort(),
    );
    expect(
      (await getReviewDetail(t.db, { projectId: p.id, id: testEnv.id }))?.review
        .hiddenAt,
    ).toBeNull();
    expect(
      (await getReviewDetail(t.db, { projectId: foreign.projectId, id: foreign.id }))
        ?.review.hiddenAt,
    ).toBeNull();

    // Empty selection: nothing happens, including no bump.
    expect(
      await setReviewsHidden(t.db, kv, { projectId: p.id, environment: "live", ids: [], hidden: true }),
    ).toEqual({ changed: 0, generation: null });
    expect(kv.puts).toHaveLength(1);
  });
});
