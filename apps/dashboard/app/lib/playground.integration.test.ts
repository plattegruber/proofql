// The playground's debug search against the real schema: the same policy as
// the api, the floored candidates flagged after an above-floor page that is
// identical to `searchChunks`'s default, and the api's 503 when embedding
// fails.
import { FakeEmbeddingProvider, fakeEmbed } from "@proofql/ai";
import { searchChunks } from "@proofql/db";
import { chunk, project, review, setupTestDb } from "@proofql/db/test";
import { describe, expect, it } from "vitest";

import { parsePlaygroundParams } from "./playground";
import { runPlayground, toPlaygroundResult } from "./playground.server";

const t = setupTestDb();

const IMPLANT = "The implant procedure was painless and quick.";
const NEAR = "The implant process was simple and fast.";
const PARKING = "Parking behind the building was easy.";

async function indexed(projectId: string, text: string, rating = 5) {
  const r = await review(t.db, {
    projectId,
    text,
    rating,
    indexedAt: new Date(),
  });
  await chunk(t.db, { reviewId: r.id, embedding: fakeEmbed([text])[0] });
  return r;
}

describe("runPlayground", () => {
  it("returns the api's result above the floor and the dropped candidates, flagged, below it", async () => {
    const p = await project(t.db);
    const hit = await indexed(p.id, IMPLANT);
    const near = await indexed(p.id, NEAR);
    await indexed(p.id, PARKING);
    await indexed(p.id, IMPLANT, 2); // policy: never a candidate

    const { request } = parsePlaygroundParams(
      new URLSearchParams("q=painless+implant"),
    );
    const outcome = await runPlayground(t.db, new FakeEmbeddingProvider(), {
      projectId: p.id,
      project: { minRating: 4, similarityFloor: 0.55, category: "dental" },
      request,
    });
    if (!outcome.ok) throw new Error(outcome.error);

    const above = outcome.results.filter((r) => !r.belowFloor);
    const below = outcome.results.filter((r) => r.belowFloor);
    expect(above.map((r) => r.reviewId)).toEqual([hit.id]);
    expect(below.map((r) => r.reviewId)).toEqual([near.id, expect.any(String)]);
    expect(below[0]?.similarity).toBeLessThan(0.55);
    expect(outcome.policy).toEqual({
      minRating: 4,
      similarityFloor: 0.55,
      category: "dental",
    });
    expect(outcome.tookMs).toBeGreaterThanOrEqual(0);
    expect(outcome.searchMs).toBeGreaterThanOrEqual(0);

    // Above the floor: exactly what the api would return.
    const plain = await searchChunks(t.db, {
      projectId: p.id,
      environment: "live",
      queryEmbedding: fakeEmbed(["painless implant"])[0],
      queryText: "painless implant",
      limit: 5,
      policy: { minRating: 4, similarityFloor: 0.55, category: "dental" },
      mode: "excerpts",
    });
    expect(above).toEqual(plain.map(toPlaygroundResult));
  });

  it("fallback: recent answers an empty page with the newest reviews, labelled, and never tops up a partial one (#86)", async () => {
    const p = await project(t.db);
    const hit = await indexed(p.id, IMPLANT);
    const parking = await indexed(p.id, PARKING);

    const run = (search: string) =>
      runPlayground(t.db, new FakeEmbeddingProvider(), {
        projectId: p.id,
        project: { minRating: 4, similarityFloor: 0.55 },
        request: parsePlaygroundParams(new URLSearchParams(search)).request,
      });

    const none = await run("q=mortgage+refinancing");
    if (!none.ok) throw new Error(none.error);
    expect(none.match).toBe("none");
    expect(none.fallback).toBeNull();

    const fallback = await run("q=mortgage+refinancing&fallback=recent");
    if (!fallback.ok) throw new Error(fallback.error);
    expect(fallback.match).toBe("fallback");
    expect(fallback.fallback?.map((r) => r.reviewId).sort()).toEqual(
      [hit.id, parking.id].sort(),
    );
    expect(fallback.fallback?.every((r) => r.similarity === null)).toBe(true);
    // The debug candidates are still reported alongside.
    expect(fallback.results.every((r) => r.belowFloor)).toBe(true);

    const query = await run("q=painless+implant&fallback=recent");
    if (!query.ok) throw new Error(query.error);
    expect(query.match).toBe("query");
    expect(query.fallback).toBeNull();

    const recent = await run("fallback=recent");
    if (!recent.ok) throw new Error(recent.error);
    expect(recent.match).toBe("recent");
    expect(recent.fallback).toBeNull();
  });

  it("tightens min_rating with the override, never loosens it", async () => {
    const p = await project(t.db);
    await indexed(p.id, IMPLANT, 4);
    const five = await indexed(p.id, IMPLANT, 5);

    const run = async (search: string) => {
      const { request } = parsePlaygroundParams(new URLSearchParams(search));
      const outcome = await runPlayground(t.db, new FakeEmbeddingProvider(), {
        projectId: p.id,
        project: { minRating: 4, similarityFloor: 0.55 },
        request,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome;
    };

    expect((await run("q=painless+implant")).results).toHaveLength(2);
    const tightened = await run("q=painless+implant&min_rating=5");
    expect(tightened.results.map((r) => r.reviewId)).toEqual([five.id]);
    expect(tightened.policy.minRating).toBe(5);
    const loosened = await run("q=painless+implant&min_rating=1");
    expect(loosened.results).toHaveLength(2);
    expect(loosened.policy.minRating).toBe(4);
  });

  it("lists the newest publishable reviews without a query, none flagged", async () => {
    const p = await project(t.db);
    await indexed(p.id, IMPLANT);
    await indexed(p.id, PARKING);
    const { request } = parsePlaygroundParams(new URLSearchParams("limit=1"));
    const outcome = await runPlayground(t.db, new FakeEmbeddingProvider(), {
      projectId: p.id,
      project: { minRating: 4, similarityFloor: 0.55 },
      request,
    });
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.similarity).toBeNull();
    expect(outcome.results[0]?.belowFloor).toBe(false);
    expect(outcome.embeddingMs).toBe(0);
  });

  it("reports embedding_unavailable instead of falling back to full text", async () => {
    const p = await project(t.db);
    await indexed(p.id, PARKING);
    const { request } = parsePlaygroundParams(new URLSearchParams("q=parking"));
    const outcome = await runPlayground(
      t.db,
      new FakeEmbeddingProvider({
        shouldFail: () => new Error("Workers AI is down"),
      }),
      {
        projectId: p.id,
        project: { minRating: 4, similarityFloor: 0.55 },
        request,
      },
    );
    expect(outcome).toEqual({
      ok: false,
      error: "embedding_unavailable",
      policy: { minRating: 4, similarityFloor: 0.55, category: null },
    });
  });
});
