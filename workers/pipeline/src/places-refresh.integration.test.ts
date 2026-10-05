/**
 * The Places refresh end to end against the real schema (#116): the fake
 * Places API stands in for Google (in-process, no sockets), `MemoryKv` for
 * the `CACHE` namespace, a recording queue for the ingest queue. Projects
 * are seeded the way the dashboard's bootstrap leaves them — five `google`
 * rows under `places/...` with `metadata.place_id`, and a `places` run with
 * `artifact_key = places:<id>` — then aged by rewriting the run's dates.
 */

import {
  exhaustedKv,
  generationKey,
  type IngestMessage,
  MemoryKv,
} from "@proofql/core";
import { schema, upsertReviews } from "@proofql/db";
import { project, setupTestDb } from "@proofql/db/test";
import {
  mapPlaceReviews,
  placeCacheKey,
  placeDetailsSchema,
} from "@proofql/google";
import {
  CEDAR_RIDGE,
  CEDAR_RIDGE_ID,
  type FakePlace,
  fakePlacesApi,
  HARBOR_LIGHT,
  HARBOR_LIGHT_ID,
} from "@proofql/google/fake";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { testLogger } from "../test/log.js";
import {
  PLACES_REFRESH_LIMIT,
  type PlacesRefreshContext,
  refreshPlacesBootstraps,
  refreshWindow,
  selectRefreshCandidates,
} from "./places-refresh.js";
import type { IngestQueue } from "./sweep.js";

const { connections, ingestRuns, reviews, projects } = schema;

const t = setupTestDb();

const NOW = new Date("2026-10-03T03:30:00.000Z");
const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

class FakeQueue implements IngestQueue {
  readonly sent: IngestMessage[] = [];
  async sendBatch(messages: Iterable<{ body: IngestMessage }>): Promise<void> {
    for (const m of messages) this.sent.push(m.body);
  }
}

afterEach(async () => {
  await t.db.delete(projects);
});

/**
 * Cedar Ridge as Google shows it 26 days later: one review's text changed
 * (r-kids-2), one dropped out of the five (r-crown-5), one new (r-garden-6).
 */
const CEDAR_RIDGE_LATER: FakePlace = {
  ...CEDAR_RIDGE,
  reviews: [
    ...(CEDAR_RIDGE.reviews ?? [])
      .filter((r) => !r.name.endsWith("r-crown-5"))
      .map((r) =>
        r.name.endsWith("r-kids-2")
          ? {
              ...r,
              text: {
                text: "Gentle with my four-year-old, who now asks when we can go back. Saturday hours still make it work.",
                languageCode: "en",
              },
            }
          : r,
      ),
    {
      name: `places/${CEDAR_RIDGE_ID}/reviews/r-garden-6`,
      rating: 5,
      text: {
        text: "The waiting room garden is a nice touch and the hygienist remembered my name.",
        languageCode: "en",
      },
      authorAttribution: {
        displayName: "Omar H.",
        uri: "https://www.google.com/maps/contrib/100000000000000000006/reviews",
      },
      publishTime: "2026-09-28T16:00:00Z",
    },
  ],
};

/** Seed a project as the dashboard's import leaves it, with the run aged. */
async function bootstrapped(input: {
  place?: FakePlace;
  environment?: "live" | "test";
  ranDaysAgo: number;
  status?: "succeeded" | "failed";
  projectId?: string;
}) {
  const place = input.place ?? CEDAR_RIDGE;
  const environment = input.environment ?? "live";
  const projectId = input.projectId ?? (await project(t.db)).id;
  const mapped = mapPlaceReviews(placeDetailsSchema.parse(place));
  const result = await upsertReviews(t.db, {
    projectId,
    environment,
    reviews: mapped.reviews,
    onLimit: "truncate",
  });
  const [run] = await t.db
    .insert(ingestRuns)
    .values({
      projectId,
      environment,
      kind: "places",
      status: input.status ?? "succeeded",
      received: place.reviews?.length ?? 0,
      created: result.created,
      artifactKey: `places:${place.id}`,
      startedAt: daysAgo(input.ranDaysAgo),
      finishedAt: new Date(daysAgo(input.ranDaysAgo).getTime() + 2_000),
    })
    .returning();
  if (!run) throw new Error("no run");
  return { projectId, environment, run, placeId: place.id };
}

function harness(
  input: {
    places?: readonly FakePlace[];
    apiKey?: string | undefined;
    limit?: number;
  } = {},
) {
  const api = fakePlacesApi(input.places);
  const kv = new MemoryKv();
  const queue = new FakeQueue();
  const { log, out } = testLogger();
  const ctx: PlacesRefreshContext = {
    db: t.db,
    queue,
    log,
    kv,
    env: {
      ENVIRONMENT: "test",
      ...("apiKey" in input
        ? { GOOGLE_PLACES_API_KEY: input.apiKey }
        : { GOOGLE_PLACES_API_KEY: "fake" }),
    },
    fetch: api.fetch,
    now: () => NOW,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };
  return { api, kv, queue, out, ctx };
}

async function runsFor(projectId: string) {
  return t.db.query.ingestRuns.findMany({
    where: eq(ingestRuns.projectId, projectId),
    orderBy: (r, { asc }) => [asc(r.startedAt)],
  });
}

async function externalIds(projectId: string) {
  const rows = await t.db
    .select({ externalId: reviews.externalId })
    .from(reviews)
    .where(eq(reviews.projectId, projectId));
  return rows.map((r) => r.externalId.split("/").at(-1)).sort();
}

describe("refreshPlacesBootstraps", () => {
  it("refreshes a 26-day-old bootstrap with no connection: updates, deletes, creates, enqueues, bumps", async () => {
    const seed = await bootstrapped({ ranDaysAgo: 26 });
    const { api, kv, queue, out, ctx } = harness({
      places: [CEDAR_RIDGE_LATER, HARBOR_LIGHT],
    });
    const before = await t.db.query.reviews.findMany({
      where: eq(reviews.projectId, seed.projectId),
    });
    expect(before).toHaveLength(5);
    const kidsBefore = before.find((r) => r.externalId.endsWith("r-kids-2"));

    const result = await refreshPlacesBootstraps(ctx);

    expect(result).toEqual({
      candidates: 1,
      refreshed: 1,
      failed: 0,
      deferred: 0,
      rateLimited: false,
      received: 5,
      created: 1,
      updated: 4,
      skipped: 0,
      rejected: 0,
      deleted: 1,
      enqueued: 2,
      requests: 1,
    });

    // Exactly one fresh fetch, with the place field mask, past the cache.
    expect(api.calls).toEqual([
      {
        method: "GET",
        path: `/v1/places/${CEDAR_RIDGE_ID}`,
        fieldMask:
          "id,displayName,formattedAddress,rating,userRatingCount,reviews",
      },
    ]);
    // ...and the fresh copy written through for the dashboard.
    const cached = JSON.parse(
      kv.store.get(placeCacheKey(CEDAR_RIDGE_ID)) ?? "{}",
    );
    expect(cached.reviews.map((r: { name: string }) => r.name)).toContain(
      `places/${CEDAR_RIDGE_ID}/reviews/r-garden-6`,
    );

    // Rows: crown gone, garden new, kids re-written and awaiting re-index.
    expect(await externalIds(seed.projectId)).toEqual([
      "r-garden-6",
      "r-implant-1",
      "r-kids-2",
      "r-limpieza-3",
      "r-whitening-4",
    ]);
    const after = await t.db.query.reviews.findMany({
      where: eq(reviews.projectId, seed.projectId),
    });
    const kids = after.find((r) => r.externalId.endsWith("r-kids-2"));
    expect(kids?.id).toBe(kidsBefore?.id);
    expect(kids?.text).toContain("now asks when we can go back");
    expect(kids?.indexedAt).toBeNull();
    const garden = after.find((r) => r.externalId.endsWith("r-garden-6"));
    expect(garden).toMatchObject({
      source: "google",
      environment: "live",
      authorName: "Omar H.",
      metadata: { place_id: CEDAR_RIDGE_ID, place_name: "Cedar Ridge Dental" },
    });

    // Two index messages: the changed text and the new review.
    expect(queue.sent).toHaveLength(2);
    expect(new Set(queue.sent.map((m) => m.type))).toEqual(
      new Set(["review.index"]),
    );
    expect(
      new Set(
        queue.sent.map((m) => (m.type === "review.index" ? m.reviewId : "")),
      ),
    ).toEqual(new Set([kids?.id, garden?.id]));

    // The counter follows the delete and the insert: 5 - 1 + 1.
    const [row] = await t.db
      .select({ n: projects.reviewCount })
      .from(projects)
      .where(eq(projects.id, seed.projectId));
    expect(row?.n).toBe(5);

    // The cache generation moved once.
    expect(kv.store.get(generationKey(seed.projectId))).toBe("1");
    expect(kv.puts.filter((p) => p.key.startsWith("gen:"))).toHaveLength(1);

    // A new `places` run row with the counts and the deletion in its note.
    const runs = await runsFor(seed.projectId);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({
      kind: "places",
      status: "succeeded",
      environment: "live",
      received: 5,
      created: 1,
      updated: 4,
      skipped: 0,
      failed: 0,
      error: "1 review Google no longer returns was removed.",
      artifactKey: `places:${CEDAR_RIDGE_ID}`,
      finishedAt: NOW,
    });

    const refreshed = out.only("places.refresh.refreshed");
    expect(refreshed).toMatchObject({
      project_id: seed.projectId,
      place_id: CEDAR_RIDGE_ID,
      ingest_run_id: runs[1]?.id,
      received: 5,
      created: 1,
      updated: 4,
      deleted: 1,
      enqueued: 2,
      generation: 1,
    });
    expect(out.only("places.refresh.completed")).toMatchObject({
      candidates: 1,
      refreshed: 1,
      deleted: 1,
      requests: 1,
    });
    expect(out.find("places.refresh.skipped")).toEqual([]);
  });

  it("KV at its daily limits: the refresh fetches live and commits; the bump and the cache write are swallowed (#158)", async () => {
    const seed = await bootstrapped({ ranDaysAgo: 26 });
    const { queue, out, ctx } = harness({
      places: [CEDAR_RIDGE_LATER, HARBOR_LIGHT],
    });
    const kv = exhaustedKv();
    ctx.kv = kv;
    const result = await refreshPlacesBootstraps(ctx);
    expect(result).toMatchObject({ refreshed: 1, failed: 0, created: 1 });
    expect(queue.sent.length).toBeGreaterThan(0);
    expect(kv.calls.put).toBeGreaterThan(0);
    const runs = await runsFor(seed.projectId);
    expect(runs[1]).toMatchObject({ status: "succeeded" });
    expect(out.find("places.refresh.refreshed")[0]).toMatchObject({
      generation: null,
    });
    const limit = out.find("kv.limit_exceeded");
    expect(limit.length).toBeGreaterThan(0);
    expect(limit.every((l) => l.level === "warn")).toBe(true);
  });

  it("is idempotent: a second refresh of an unchanged place enqueues nothing and bumps nothing", async () => {
    const seed = await bootstrapped({ ranDaysAgo: 26 });
    const { kv, queue, ctx } = harness();
    const result = await refreshPlacesBootstraps(ctx);
    expect(result).toMatchObject({
      refreshed: 1,
      created: 0,
      updated: 5,
      deleted: 0,
      enqueued: 0,
    });
    expect(queue.sent).toEqual([]);
    expect(kv.store.get(generationKey(seed.projectId))).toBeUndefined();
    const runs = await runsFor(seed.projectId);
    expect(runs[1]).toMatchObject({ status: "succeeded", error: null });
    // And now it is fresh: nothing is due.
    expect(await refreshPlacesBootstraps(ctx)).toMatchObject({ candidates: 0 });
  });

  it("skips a project with an active google connection, and one refreshed 10 days ago", async () => {
    const connected = await bootstrapped({ ranDaysAgo: 26 });
    await t.db.insert(connections).values({
      projectId: connected.projectId,
      kind: "google",
      status: "active",
      metadata: {},
    });
    const recent = await bootstrapped({ ranDaysAgo: 10 });
    // A connection that needs re-auth is not active: the bootstrap is all
    // the project has, so it is still refreshed.
    const reauth = await bootstrapped({ ranDaysAgo: 30 });
    await t.db.insert(connections).values({
      projectId: reauth.projectId,
      kind: "google",
      status: "needs_reauth",
      metadata: {},
    });

    const { api, ctx } = harness();
    const result = await refreshPlacesBootstraps(ctx);
    expect(result).toMatchObject({ candidates: 1, refreshed: 1, requests: 1 });
    expect(api.calls).toHaveLength(1);
    expect(await runsFor(connected.projectId)).toHaveLength(1);
    expect(await runsFor(recent.projectId)).toHaveLength(1);
    expect(await runsFor(reauth.projectId)).toHaveLength(2);
  });

  it("does nothing without GOOGLE_PLACES_API_KEY and says so once", async () => {
    await bootstrapped({ ranDaysAgo: 26 });
    for (const apiKey of [undefined, "", "   ", "TBD-provision-in-m3"]) {
      const { api, out, ctx } = harness({ apiKey });
      const result = await refreshPlacesBootstraps(ctx);
      expect(result).toMatchObject({
        candidates: 0,
        refreshed: 0,
        skippedReason: "not_configured",
      });
      expect(api.calls).toEqual([]);
      expect(out.only("places.refresh.skipped")).toMatchObject({
        level: "warn",
        reason: "not_configured",
        missing: ["GOOGLE_PLACES_API_KEY"],
      });
      expect(out.records).toHaveLength(1);
    }
    // No run row was written anywhere.
    const runs = await t.db.select().from(ingestRuns);
    expect(runs).toHaveLength(1);
  });

  it("a 429 fails that project's run and stops the tick; the rest wait for tomorrow", async () => {
    const first = await bootstrapped({ ranDaysAgo: 40 });
    const second = await bootstrapped({ ranDaysAgo: 30 });
    const third = await bootstrapped({ ranDaysAgo: 26 });
    const { api, out, ctx, queue } = harness();
    api.failWith = Response.json(
      {
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Quota exceeded for quota metric 'Place Details'.",
        },
      },
      { status: 429 },
    );

    const result = await refreshPlacesBootstraps(ctx);
    expect(result).toMatchObject({
      candidates: 3,
      refreshed: 0,
      failed: 1,
      deferred: 2,
      rateLimited: true,
      requests: 1,
    });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.path).toBe(`/v1/places/${CEDAR_RIDGE_ID}`);
    expect(queue.sent).toEqual([]);

    // Oldest first: the 40-day-old project took the hit...
    const runs = await runsFor(first.projectId);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({
      kind: "places",
      status: "failed",
      error:
        "Google is rate-limiting Places lookups right now; try again in a minute.",
      finishedAt: NOW,
    });
    // ...its rows are untouched...
    expect(await externalIds(first.projectId)).toHaveLength(5);
    // ...and the others were not reached.
    expect(await runsFor(second.projectId)).toHaveLength(1);
    expect(await runsFor(third.projectId)).toHaveLength(1);

    expect(out.only("places.refresh.failed")).toMatchObject({
      level: "warn",
      project_id: first.projectId,
      status: 429,
      code: "RESOURCE_EXHAUSTED",
    });
    expect(out.only("places.refresh.rate_limited")).toMatchObject({
      deferred: 2,
    });
    expect(out.only("places.refresh.completed")).toMatchObject({
      rate_limited: true,
      deferred: 2,
    });
  });

  it("a Google error fails only that project's run; the tick carries on", async () => {
    const gone = await bootstrapped({
      ranDaysAgo: 30,
      place: { ...CEDAR_RIDGE, id: "ChIJgone0000000000000" },
    });
    const fine = await bootstrapped({ ranDaysAgo: 26, place: HARBOR_LIGHT });
    const { ctx, out } = harness();
    const result = await refreshPlacesBootstraps(ctx);
    expect(result).toMatchObject({
      candidates: 2,
      refreshed: 1,
      failed: 1,
      deferred: 0,
      rateLimited: false,
      // Harbor Light: two returned, one rating-only (skipped), one updated.
      received: 2,
      updated: 1,
      skipped: 1,
    });
    const goneRuns = await runsFor(gone.projectId);
    expect(goneRuns[1]).toMatchObject({
      status: "failed",
      error: "Google no longer lists this place.",
    });
    expect(await externalIds(gone.projectId)).toHaveLength(5);
    expect((await runsFor(fine.projectId))[1]).toMatchObject({
      status: "succeeded",
      received: 2,
      updated: 1,
      skipped: 1,
    });
    expect(out.only("places.refresh.failed")).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });

    // A failed refresh is retried after a day, not in 25.
    const later = { ...ctx, now: () => new Date(NOW.getTime() + 2 * DAY_MS) };
    expect(
      (await selectRefreshCandidates(t.db, refreshWindow(later.now()))).map(
        (c) => c.projectId,
      ),
    ).toEqual([gone.projectId]);
    expect(
      await selectRefreshCandidates(
        t.db,
        refreshWindow(new Date(NOW.getTime() + 0.5 * DAY_MS)),
      ),
    ).toEqual([]);
  });

  it("removes every row for a place Google now returns no reviews for, and then leaves the project alone", async () => {
    const seed = await bootstrapped({ ranDaysAgo: 26 });
    const { reviews: _dropped, ...noReviews } = CEDAR_RIDGE;
    const { ctx, kv } = harness({ places: [noReviews] });
    const result = await refreshPlacesBootstraps(ctx);
    expect(result).toMatchObject({
      refreshed: 1,
      received: 0,
      deleted: 5,
      enqueued: 0,
    });
    expect(await externalIds(seed.projectId)).toEqual([]);
    const [row] = await t.db
      .select({ n: projects.reviewCount })
      .from(projects)
      .where(eq(projects.id, seed.projectId));
    expect(row?.n).toBe(0);
    expect(kv.store.get(generationKey(seed.projectId))).toBe("1");
    expect((await runsFor(seed.projectId))[1]).toMatchObject({
      status: "succeeded",
      received: 0,
      error: "5 reviews Google no longer returns were removed.",
    });

    // No bootstrap rows left ⇒ not a candidate any more, even when due.
    expect(
      await selectRefreshCandidates(
        t.db,
        refreshWindow(new Date(NOW.getTime() + 30 * DAY_MS)),
      ),
    ).toEqual([]);
  });

  it("keeps live and test apart, orders oldest first, and honours the per-tick limit", async () => {
    const p = await project(t.db);
    const live = await bootstrapped({
      projectId: p.id,
      environment: "live",
      ranDaysAgo: 27,
    });
    const test = await bootstrapped({
      projectId: p.id,
      environment: "test",
      ranDaysAgo: 35,
    });
    const other = await bootstrapped({ ranDaysAgo: 31, place: HARBOR_LIGHT });

    const window = refreshWindow(NOW);
    const all = await selectRefreshCandidates(t.db, window);
    expect(
      all.map((c) => [c.projectId, c.environment, c.placeId, c.lastStatus]),
    ).toEqual([
      [p.id, "test", CEDAR_RIDGE_ID, "succeeded"],
      [other.projectId, "live", HARBOR_LIGHT_ID, "succeeded"],
      [p.id, "live", CEDAR_RIDGE_ID, "succeeded"],
    ]);
    expect(all[0]?.lastRunAt).toEqual(test.run.finishedAt);
    expect(PLACES_REFRESH_LIMIT).toBe(200);

    const { ctx, api } = harness({ limit: 1 });
    const result = await refreshPlacesBootstraps(ctx);
    expect(result).toMatchObject({ candidates: 1, refreshed: 1 });
    expect(api.calls).toHaveLength(1);
    const testRuns = await t.db.query.ingestRuns.findMany({
      where: and(
        eq(ingestRuns.projectId, p.id),
        eq(ingestRuns.environment, "test"),
      ),
    });
    expect(testRuns).toHaveLength(2);
    const liveRuns = await t.db.query.ingestRuns.findMany({
      where: and(
        eq(ingestRuns.projectId, p.id),
        eq(ingestRuns.environment, "live"),
      ),
    });
    expect(liveRuns).toHaveLength(1);
    expect(live.environment).toBe("live");
  });
});
