// The Places bootstrap end to end against the real schema (#47): the fake
// Places API stands in for Google, a Map for KV, the recording queue for
// the ingest queue. The import writes five `google` reviews, a `places` run
// row, five index messages; a second import updates in place and enqueues
// nothing; a place with no usable reviews leaves no run behind. The client
// itself (search, the cache, refusals) is tested in packages/google.
import {
  createLogger,
  exhaustedKv,
  planFor,
  recordingSink,
} from "@proofql/core";
import { schema } from "@proofql/db";
import { project, setupTestDb } from "@proofql/db/test";
import {
  createPlacesClient,
  PLACES_PLACE_FIELD_MASK,
  type PlacesCache,
  placeCacheKey,
} from "@proofql/google";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  CEDAR_RIDGE_ID,
  fakePlacesApi,
  HARBOR_LIGHT_ID,
  QUIET_CORNER_ID,
} from "../../test/fake-places";
import {
  failingQueue,
  fakeQueue,
  QUEUE_LIMIT_MESSAGE,
} from "../../test/fake-r2";
import {
  importPlaceReviews,
  PlacesImportError,
  placesClientFor,
  placesConfigured,
} from "./places.server";

const t = setupTestDb();

function fakeCache(): PlacesCache & {
  entries: Map<string, { value: string; ttl: number }>;
} {
  const entries = new Map<string, { value: string; ttl: number }>();
  return {
    entries,
    async get(key) {
      return entries.get(key)?.value ?? null;
    },
    async put(key, value, ttl) {
      entries.set(key, { value, ttl });
    },
  };
}

function harness(apiKey = "fake") {
  const api = fakePlacesApi();
  const cache = fakeCache();
  const queue = fakeQueue();
  const places = createPlacesClient({ apiKey, fetch: api.fetch, cache });
  return { api, cache, queue, places };
}

describe("importPlaceReviews", () => {
  it("writes five google reviews, a places run row with counts, and five index messages", async () => {
    const p = await project(t.db);
    const { api, cache, queue, places } = harness();

    const result = await importPlaceReviews(
      { db: t.db, places, queue },
      { projectId: p.id, environment: "live", placeId: CEDAR_RIDGE_ID },
    );
    expect(result).toMatchObject({
      place: { id: CEDAR_RIDGE_ID, name: "Cedar Ridge Dental" },
      created: 5,
      updated: 0,
      skipped: 0,
      failed: 0,
      enqueued: 5,
      cached: false,
      categorySet: true,
    });
    expect(api.calls).toEqual([
      {
        method: "GET",
        path: `/v1/places/${CEDAR_RIDGE_ID}`,
        fieldMask: PLACES_PLACE_FIELD_MASK,
      },
    ]);

    const runs = await t.db.query.ingestRuns.findMany({
      where: eq(schema.ingestRuns.projectId, p.id),
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: result.run.id,
      kind: "places",
      status: "succeeded",
      environment: "live",
      received: 5,
      created: 5,
      updated: 0,
      skipped: 0,
      failed: 0,
      error: null,
      artifactKey: `places:${CEDAR_RIDGE_ID}`,
    });
    expect(runs[0]?.finishedAt).not.toBeNull();

    const reviews = await t.db.query.reviews.findMany({
      where: eq(schema.reviews.projectId, p.id),
      orderBy: (r, { asc }) => [asc(r.externalId)],
    });
    expect(reviews).toHaveLength(5);
    for (const r of reviews) {
      expect(r.source).toBe("google");
      expect(r.environment).toBe("live");
      expect(r.externalId.startsWith(`places/${CEDAR_RIDGE_ID}/reviews/`)).toBe(
        true,
      );
      expect(r.metadata).toEqual({
        place_id: CEDAR_RIDGE_ID,
        place_name: "Cedar Ridge Dental",
      });
      expect(r.indexedAt).toBeNull();
    }
    const spanish = reviews.find((r) => r.externalId.endsWith("r-limpieza-3"));
    expect(spanish?.text).toContain("La limpieza fue rápida");
    expect(spanish?.language).toBe("es");

    expect(queue.messages).toHaveLength(5);
    expect(new Set(queue.messages.map((m) => m.reviewId))).toEqual(
      new Set(reviews.map((r) => r.id)),
    );
    for (const m of queue.messages) {
      expect(m).toMatchObject({
        type: "review.index",
        projectId: p.id,
        environment: "live",
      });
    }

    // The place is cached for a day under its id.
    const entry = cache.entries.get(placeCacheKey(CEDAR_RIDGE_ID));
    expect(entry?.ttl).toBe(24 * 60 * 60);
    expect(JSON.parse(entry?.value ?? "{}").reviews).toHaveLength(5);

    // The project's counter follows, as for any ingest.
    const [row] = await t.db
      .select({
        n: schema.projects.reviewCount,
        category: schema.projects.category,
      })
      .from(schema.projects)
      .where(eq(schema.projects.id, p.id));
    expect(row?.n).toBe(5);
    // The place's `dentist` primaryType names the business (#151).
    expect(row?.category).toBe("dental");
  });

  it("sets the category only while it is unset, and only from a mapped type (#151)", async () => {
    const chosen = await project(t.db);
    await t.db
      .update(schema.projects)
      .set({ category: "medical" })
      .where(eq(schema.projects.id, chosen.id));
    const bakery = await project(t.db);
    const { queue, places } = harness();

    const kept = await importPlaceReviews(
      { db: t.db, places, queue },
      { projectId: chosen.id, environment: "live", placeId: CEDAR_RIDGE_ID },
    );
    // Harbor Light's type is `bakery`, which the table does not map.
    const unmapped = await importPlaceReviews(
      { db: t.db, places, queue },
      { projectId: bakery.id, environment: "live", placeId: HARBOR_LIGHT_ID },
    );
    expect(kept.categorySet).toBe(false);
    expect(unmapped.categorySet).toBe(false);
    const rows = await t.db
      .select({ id: schema.projects.id, category: schema.projects.category })
      .from(schema.projects);
    const byId = new Map(rows.map((r) => [r.id, r.category]));
    expect(byId.get(chosen.id)).toBe("medical");
    expect(byId.get(bakery.id)).toBeNull();
  });

  it("Queues daily limit: the import succeeds with indexing deferred and logs quota.exhausted (#159)", async () => {
    const p = await project(t.db);
    const { places } = harness();
    const queue = failingQueue();
    const out = recordingSink();
    const log = createLogger({
      service: "dashboard",
      environment: "test",
      sink: out.sink,
    });

    const result = await importPlaceReviews(
      { db: t.db, places, queue, log },
      { projectId: p.id, environment: "live", placeId: CEDAR_RIDGE_ID },
    );

    expect(result).toMatchObject({
      created: 5,
      enqueued: 0,
      indexingDeferred: true,
    });
    expect(result.run).toMatchObject({ status: "succeeded", error: null });
    expect(queue.attempts).toBe(1);
    const reviews = await t.db.query.reviews.findMany({
      where: eq(schema.reviews.projectId, p.id),
    });
    expect(reviews).toHaveLength(5);
    expect(reviews.every((r) => r.indexedAt === null)).toBe(true);
    expect(out.only("quota.exhausted")).toMatchObject({
      level: "error",
      resource: "queues",
      site: "dashboard.places_import",
      messages: 5,
      ingest_run_id: result.run.id,
      error: { message: QUEUE_LIMIT_MESSAGE },
    });
    expect(out.only("places.imported")).toMatchObject({
      enqueued: 0,
      indexing_deferred: true,
    });
    expect(out.find("places.failed")).toHaveLength(0);
  });

  it("is idempotent: a second import updates the same rows, enqueues nothing, and reads the place from KV", async () => {
    const p = await project(t.db);
    const { api, queue, places } = harness();
    const deps = { db: t.db, places, queue };
    const input = {
      projectId: p.id,
      environment: "live" as const,
      placeId: CEDAR_RIDGE_ID,
    };
    await importPlaceReviews(deps, input);
    const again = await importPlaceReviews(deps, input);

    expect(again).toMatchObject({
      created: 0,
      updated: 5,
      skipped: 0,
      enqueued: 0,
      cached: true,
      categorySet: false,
    });
    expect(api.calls).toHaveLength(1);
    expect(queue.messages).toHaveLength(5);

    const runs = await t.db.query.ingestRuns.findMany({
      where: eq(schema.ingestRuns.projectId, p.id),
    });
    expect(runs.map((r) => [r.kind, r.status, r.created, r.updated])).toEqual([
      ["places", "succeeded", 5, 0],
      ["places", "succeeded", 0, 5],
    ]);
    const reviews = await t.db.query.reviews.findMany({
      where: eq(schema.reviews.projectId, p.id),
    });
    expect(reviews).toHaveLength(5);
  });

  it("counts a rating-only review as skipped and keeps live and test apart", async () => {
    const p = await project(t.db);
    const { queue, places } = harness();
    const result = await importPlaceReviews(
      { db: t.db, places, queue },
      { projectId: p.id, environment: "test", placeId: HARBOR_LIGHT_ID },
    );
    expect(result).toMatchObject({
      created: 1,
      skipped: 1,
      failed: 0,
      enqueued: 1,
    });
    expect(result.run).toMatchObject({
      received: 2,
      created: 1,
      skipped: 1,
      environment: "test",
    });
    const reviews = await t.db.query.reviews.findMany({
      where: eq(schema.reviews.projectId, p.id),
    });
    expect(reviews.map((r) => r.environment)).toEqual(["test"]);
  });

  it("leaves no run for a place Google shares no reviews for", async () => {
    const p = await project(t.db);
    const { queue, places } = harness();
    const error = await importPlaceReviews(
      { db: t.db, places, queue },
      { projectId: p.id, environment: "live", placeId: QUIET_CORNER_ID },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(PlacesImportError);
    expect(error.message).toBe(
      "Google shares no public reviews for Quiet Corner Books yet.",
    );
    expect(
      await t.db.query.ingestRuns.findMany({
        where: eq(schema.ingestRuns.projectId, p.id),
      }),
    ).toEqual([]);
    expect(queue.messages).toEqual([]);

    await expect(
      importPlaceReviews(
        { db: t.db, places, queue },
        { projectId: p.id, environment: "live", placeId: "ChIJnope" },
      ),
    ).rejects.toMatchObject({ name: "PlacesError", status: 404 });
  });

  it("truncates at the plan cap and says so on the run", async () => {
    const p = await project(t.db);
    // The cap check reads the project's counter: put it two short of the
    // free limit so two of the five fit.
    const limit = planFor("free").reviewsPerProject;
    await t.db
      .update(schema.projects)
      .set({ reviewCount: limit - 2 })
      .where(eq(schema.projects.id, p.id));

    const { queue, places } = harness();
    const result = await importPlaceReviews(
      { db: t.db, places, queue },
      { projectId: p.id, environment: "live", placeId: CEDAR_RIDGE_ID },
    );
    expect(result).toMatchObject({ created: 2, failed: 3, enqueued: 2 });
    expect(result.run.status).toBe("succeeded");
    expect(result.run.error).toContain("3 reviews were not imported");
  });
});

describe("configuration", () => {
  it("is enabled only with a non-blank key, and the client takes the local base and KV", async () => {
    expect(placesConfigured({})).toBe(false);
    expect(placesConfigured({ GOOGLE_PLACES_API_KEY: "  " })).toBe(false);
    expect(placesConfigured({ GOOGLE_PLACES_API_KEY: "k" })).toBe(true);
    expect(placesClientFor({ GOOGLE_PLACES_API_KEY: "" })).toBeNull();

    const api = fakePlacesApi();
    const client = placesClientFor(
      {
        GOOGLE_PLACES_API_KEY: "fake",
        PLACES_API_BASE: "http://places.local/",
      },
      { fetch: api.fetch },
    );
    if (client === null) throw new Error("expected a client");
    const { matches } = await client.search("bakery");
    expect(matches.map((m) => m.id)).toEqual([HARBOR_LIGHT_ID]);
    expect(api.calls[0]?.path).toBe("/v1/places:searchText");
  });

  it("KV at its daily limits: the search fetches live from Google and never fails (#158)", async () => {
    const api = fakePlacesApi();
    const kv = exhaustedKv();
    const rec = recordingSink();
    const log = createLogger({
      service: "dashboard",
      environment: "test",
      sink: rec.sink,
    });
    const client = placesClientFor(
      {
        GOOGLE_PLACES_API_KEY: "fake",
        CACHE: kv as unknown as KVNamespace,
      },
      { fetch: api.fetch, log },
    );
    if (client === null) throw new Error("expected a client");
    for (let i = 0; i < 2; i++) {
      const { matches, cached } = await client.search("bakery");
      expect(cached).toBe(false);
      expect(matches.map((m) => m.id)).toEqual([HARBOR_LIGHT_ID]);
    }
    expect(api.calls).toHaveLength(2);
    expect(kv.calls.put).toBe(2);
    expect(rec.find("kv.limit_exceeded").length).toBeGreaterThan(0);
  });
});
