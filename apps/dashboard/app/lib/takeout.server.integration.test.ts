// The Google Takeout import end to end against the real schema: payload →
// run → finish, with an in-memory bucket, a recording queue and an
// in-memory KV standing in for R2, the ingest queue and the cache counter.
// The export is the fabricated fixture in packages/core/test/fixtures/
// takeout (every name and review invented), read the way the browser
// reads it (`groupTakeoutFiles`).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  buildTakeoutPayload,
  generationKey,
  groupTakeoutFiles,
  isTakeoutEntryOfInterest,
  MemoryKv,
  type TakeoutLocation,
  type TakeoutPayload,
} from "@proofql/core";
import { schema } from "@proofql/db";
import { project, review, setupTestDb } from "@proofql/db/test";
import { and, eq, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { failingQueue, fakeBucket, fakeQueue } from "../../test/fake-r2";
import { errorReport, findProjectRun, ImportError } from "./csv.server";
import {
  createTakeoutImport,
  hasTakeoutImport,
  isTakeoutRun,
  loadTakeoutDetails,
  MAX_TAKEOUT_PAYLOAD_BYTES,
  placesBootstrapSummary,
  runTakeoutImport,
} from "./takeout.server";

const t = setupTestDb();

const ROOT = new URL(
  "../../../../packages/core/test/fixtures/takeout/",
  import.meta.url,
).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function fixtureLocations(): TakeoutLocation[] {
  return groupTakeoutFiles(
    walk(ROOT)
      .map((path) => ({
        path: relative(ROOT, path),
        text: readFileSync(path, "utf8"),
      }))
      .filter((f) => isTakeoutEntryOfInterest(f.path)),
  ).locations;
}

/** A deep copy, so a test can edit an export without touching the next one's. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function importPayload(
  projectId: string,
  payload: TakeoutPayload,
  options: {
    environment?: "live" | "test";
    supersedePlaces?: boolean;
    queue?: ReturnType<typeof fakeQueue> | ReturnType<typeof failingQueue>;
    kv?: MemoryKv;
    budgetMs?: number;
  } = {},
) {
  const store = fakeBucket(4096);
  // The recorder is returned for assertions; a test that passes its own
  // queue (a failing one) asserts on that instead.
  const recorder = fakeQueue();
  const queue = options.queue ?? recorder;
  const kv = options.kv ?? new MemoryKv();
  const { runId } = await createTakeoutImport(t.db, store, {
    projectId,
    environment: options.environment ?? "live",
    payload: JSON.stringify(payload),
    supersedePlaces: options.supersedePlaces ?? false,
  });
  let outcome = await runTakeoutImport(
    { db: t.db, store, queue, kv, budgetMs: options.budgetMs },
    runId,
  );
  let hops = 1;
  while (outcome.state === "paused" && hops < 50) {
    outcome = await runTakeoutImport(
      { db: t.db, store, queue, kv, budgetMs: options.budgetMs },
      runId,
    );
    hops += 1;
  }
  return {
    outcome,
    run: outcome.run,
    details: await loadTakeoutDetails(store, outcome.run),
    store,
    queue: recorder,
    kv,
    hops,
    runId,
  };
}

async function googleRows(projectId: string, environment = "live") {
  return t.db
    .select()
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.projectId, projectId),
        eq(schema.reviews.environment, environment as "live"),
      ),
    );
}

describe("a first Takeout import", () => {
  it("imports every review with text, skips star-only ones, keeps replies out of text", async () => {
    const p = await project(t.db);
    const { run, queue, details } = await importPayload(
      p.id,
      buildTakeoutPayload(fixtureLocations(), true),
    );
    expect(run).toMatchObject({
      kind: "csv",
      status: "succeeded",
      received: 27,
      created: 25,
      updated: 0,
      skipped: 2,
      failed: 0,
    });
    expect(details).toMatchObject({
      complete: true,
      star_only: 2,
      stale: 0,
      removed: 0,
      places_removed: 0,
      duplicates: 0,
      locations: [
        { id: "2001", title: "Harbor Light Bakery", reviews: 23 },
        { id: "2002", title: "Harbor Light Bakery — Pearl Street", reviews: 4 },
      ],
    });
    expect(queue.messages).toHaveLength(25);

    const rows = await googleRows(p.id);
    expect(rows).toHaveLength(25);
    const first = rows.find((r) =>
      r.externalId.endsWith("/reviews/AbFvOq000Tk"),
    );
    expect(first).toMatchObject({
      source: "google",
      externalId: "accounts/1009/locations/2001/reviews/AbFvOq000Tk",
      rating: 5,
      authorName: "Avery Lin",
      authorAvatarUrl: null,
      url: null,
      metadata: {
        location: "2001",
        location_title: "Harbor Light Bakery",
        import_source: "takeout",
        owner_reply: "Thank you, Avery! We hope to see you again soon.",
      },
    });
    expect(first?.text).not.toContain("Thank you");
    const [counted] = await t.db
      .select({ n: schema.projects.reviewCount })
      .from(schema.projects)
      .where(eq(schema.projects.id, p.id));
    expect(counted?.n).toBe(25);
    // An uploaded export (kind csv) marked as Takeout by its artifact.
    const listed = await findProjectRun(t.db, p.id, run.id);
    expect(listed.artifactKey).toMatch(/\.takeout\.json$/);
    expect(isTakeoutRun(listed)).toBe(true);
    expect(isTakeoutRun({ kind: "csv", artifactKey: "uploads/p/r.csv" })).toBe(
      false,
    );
  });

  it("pauses and resumes across budgets without importing anything twice", async () => {
    const p = await project(t.db);
    const big: TakeoutLocation = {
      locationId: "4004",
      title: "Big Branch",
      starOnly: 0,
      reviews: Array.from({ length: 250 }, (_, i) => ({
        name: `accounts/1009/locations/4004/reviews/big${i}`,
        reviewer: { displayName: `Reviewer ${i}` },
        starRating: "FIVE",
        comment: `Review number ${i} about the bread.`,
        createTime: new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString(),
      })),
    };
    // A budget that is always spent: every call commits one batch and pauses.
    const { run, hops } = await importPayload(
      p.id,
      buildTakeoutPayload([big], true),
      { budgetMs: -1 },
    );
    expect(hops).toBe(3);
    expect(run).toMatchObject({
      status: "succeeded",
      created: 250,
      skipped: 0,
    });
    expect(await googleRows(p.id)).toHaveLength(250);
  });

  it("finishes with indexing deferred when the queue refuses (free-plan limit)", async () => {
    const p = await project(t.db);
    const queue = failingQueue();
    const { run } = await importPayload(
      p.id,
      buildTakeoutPayload(fixtureLocations(), true),
      { queue },
    );
    expect(run).toMatchObject({ status: "succeeded", created: 25 });
    // One attempt, then the rest of the call stops trying (quota.exhausted).
    expect(queue.attempts).toBe(1);
    const rows = await googleRows(p.id);
    expect(rows.every((r) => r.indexedAt === null)).toBe(true);
  });
});

describe("re-importing", () => {
  it("is idempotent for the same export", async () => {
    const p = await project(t.db);
    const payload = buildTakeoutPayload(fixtureLocations(), true);
    await importPayload(p.id, payload);
    const again = await importPayload(p.id, payload);
    expect(again.run).toMatchObject({
      created: 0,
      updated: 25,
      skipped: 2,
      failed: 0,
    });
    expect(again.details).toMatchObject({ removed: 0, stale: 0 });
    // Nothing changed, so nothing is re-indexed.
    expect(again.queue.messages).toHaveLength(0);
    expect(await googleRows(p.id)).toHaveLength(25);
  });

  it("picks up new and edited reviews and removes ones deleted on Google", async () => {
    const p = await project(t.db);
    const locations = fixtureLocations();
    await importPayload(p.id, buildTakeoutPayload(locations, true));

    const newer = clone(locations);
    const main = newer[0] as TakeoutLocation;
    // Edited on Google after the first export.
    const edited = main.reviews.find((r) =>
      r.name.endsWith("/AbFvOq002Tk"),
    ) as TakeoutLocation["reviews"][number];
    edited.comment = "Friendly staff, and the coffee is hot now.";
    edited.updateTime = "2025-09-01T09:00:00.000000Z";
    // Deleted on Google: absent from the newer export.
    main.reviews = main.reviews.filter((r) => !r.name.endsWith("/AbFvOq005Tk"));
    // New since the first export.
    main.reviews.push({
      name: "accounts/1009/locations/2001/reviews/AbFvOqNEWTk",
      reviewer: { displayName: "New Person" },
      starRating: "FOUR",
      comment: "Came for bread, stayed for the soup.",
      createTime: "2025-09-02T09:00:00.000000Z",
      updateTime: "2025-09-02T09:00:00.000000Z",
    });

    const kv = new MemoryKv();
    const { run, queue, details } = await importPayload(
      p.id,
      buildTakeoutPayload(newer, true),
      { kv },
    );
    expect(run).toMatchObject({ created: 1, updated: 24, skipped: 2 });
    expect(details?.removed).toBe(1);
    // The new review and the edited one are (re-)indexed.
    expect(queue.messages).toHaveLength(2);
    // Deleting rows invalidates the query cache once.
    expect(kv.store.get(generationKey(p.id))).toBe("1");

    const rows = await googleRows(p.id);
    expect(rows).toHaveLength(25);
    expect(rows.some((r) => r.externalId.endsWith("/AbFvOq005Tk"))).toBe(false);
    expect(rows.find((r) => r.externalId.endsWith("/AbFvOq002Tk"))?.text).toBe(
      "Friendly staff, and the coffee is hot now.",
    );
  });

  it("never lets an older export overwrite a newer edit", async () => {
    const p = await project(t.db);
    const locations = fixtureLocations();
    const newer = clone(locations);
    const edited = (newer[0] as TakeoutLocation).reviews.find((r) =>
      r.name.endsWith("/AbFvOq002Tk"),
    ) as TakeoutLocation["reviews"][number];
    edited.comment = "Edited later: the coffee is hot now.";
    edited.updateTime = "2025-09-01T09:00:00.000000Z";
    await importPayload(p.id, buildTakeoutPayload(newer, true));

    const { run, details } = await importPayload(
      p.id,
      buildTakeoutPayload(locations, true),
    );
    expect(details?.stale).toBe(1);
    expect(run.skipped).toBe(3);
    const rows = await googleRows(p.id);
    expect(rows.find((r) => r.externalId.endsWith("/AbFvOq002Tk"))?.text).toBe(
      "Edited later: the coffee is hot now.",
    );
  });

  it("does not remove anything from loose files, which may be a subset", async () => {
    const p = await project(t.db);
    const locations = fixtureLocations();
    await importPayload(p.id, buildTakeoutPayload(locations, true));
    const subset = clone(locations).slice(0, 1);
    (subset[0] as TakeoutLocation).reviews = (
      subset[0] as TakeoutLocation
    ).reviews.slice(0, 3);
    const { details } = await importPayload(
      p.id,
      buildTakeoutPayload(subset, false),
    );
    expect(details).toMatchObject({ complete: false, removed: 0 });
    expect(await googleRows(p.id)).toHaveLength(25);
  });
});

describe("matching stored Google reviews", () => {
  it("updates a review stored under another account's name instead of duplicating it", async () => {
    const p = await project(t.db);
    await review(t.db, {
      projectId: p.id,
      externalId: "accounts/999/locations/2001/reviews/AbFvOq000Tk",
      text: "Older copy from the connector.",
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    });
    const { run } = await importPayload(
      p.id,
      buildTakeoutPayload(fixtureLocations(), true),
    );
    expect(run).toMatchObject({ created: 24, updated: 1 });
    const rows = await googleRows(p.id);
    expect(rows).toHaveLength(25);
    const matched = rows.find((r) =>
      r.externalId.endsWith("/reviews/AbFvOq000Tk"),
    );
    expect(matched?.externalId).toBe(
      "accounts/999/locations/2001/reviews/AbFvOq000Tk",
    );
    expect(matched?.text).toContain("sourdough");
  });

  it("keeps a review the connector stored after the export was made", async () => {
    const p = await project(t.db);
    // Newer than anything in the export (as-of 2025-08-05), so a complete
    // export that lacks it must not delete it.
    await review(t.db, {
      projectId: p.id,
      externalId: "accounts/1009/locations/2001/reviews/AfterExport",
      occurredAt: new Date("2025-10-01T00:00:00Z"),
    });
    // Older than the export and absent from it: deleted on Google.
    await review(t.db, {
      projectId: p.id,
      externalId: "accounts/1009/locations/2001/reviews/GoneFromGoogle",
      occurredAt: new Date("2025-03-01T00:00:00Z"),
    });
    // Another location, untouched by this export.
    await review(t.db, {
      projectId: p.id,
      externalId: "accounts/1009/locations/3003/reviews/OtherBranch",
      occurredAt: new Date("2025-03-01T00:00:00Z"),
    });
    const { details } = await importPayload(
      p.id,
      buildTakeoutPayload(fixtureLocations(), true),
    );
    expect(details?.removed).toBe(1);
    const ids = (await googleRows(p.id)).map((r) => r.externalId);
    expect(ids).toContain("accounts/1009/locations/2001/reviews/AfterExport");
    expect(ids).toContain("accounts/1009/locations/3003/reviews/OtherBranch");
    expect(ids).not.toContain(
      "accounts/1009/locations/2001/reviews/GoneFromGoogle",
    );
  });
});

describe("superseding the Places bootstrap", () => {
  it("replaces the environment's Places rows when confirmed, and records it", async () => {
    const p = await project(t.db, { reviewCount: 3 });
    for (const [i, environment] of (
      ["live", "live", "test"] as const
    ).entries()) {
      await review(t.db, {
        projectId: p.id,
        environment,
        externalId: `places/ChIJharbor/reviews/r${i}`,
        metadata: { place_id: "ChIJharbor", place_name: "Harbor Light Bakery" },
      });
    }
    expect(await placesBootstrapSummary(t.db, p.id)).toEqual(
      expect.arrayContaining([
        { environment: "live", reviews: 2, places: ["Harbor Light Bakery"] },
        { environment: "test", reviews: 1, places: ["Harbor Light Bakery"] },
      ]),
    );
    expect(await hasTakeoutImport(t.db, p.id, "live")).toBe(false);

    const { details } = await importPayload(
      p.id,
      buildTakeoutPayload(fixtureLocations(), true),
      { supersedePlaces: true },
    );
    expect(details?.places_removed).toBe(2);
    const places = await t.db
      .select({ environment: schema.reviews.environment })
      .from(schema.reviews)
      .where(
        and(
          eq(schema.reviews.projectId, p.id),
          like(schema.reviews.externalId, "places/%"),
        ),
      );
    expect(places).toEqual([{ environment: "test" }]);
    expect(await hasTakeoutImport(t.db, p.id, "live")).toBe(true);
    expect(await hasTakeoutImport(t.db, p.id, "test")).toBe(false);
    const [counted] = await t.db
      .select({ n: schema.projects.reviewCount })
      .from(schema.projects)
      .where(eq(schema.projects.id, p.id));
    expect(counted?.n).toBe(3 + 25 - 2);
  });

  it("leaves the Places rows alone without the confirmation", async () => {
    const p = await project(t.db);
    await review(t.db, {
      projectId: p.id,
      externalId: "places/ChIJharbor/reviews/r0",
    });
    const { details } = await importPayload(
      p.id,
      buildTakeoutPayload(fixtureLocations(), true),
    );
    expect(details?.places_removed).toBe(0);
    expect(
      (await googleRows(p.id)).some((r) => r.externalId.startsWith("places/")),
    ).toBe(true);
  });
});

describe("refusals and failures", () => {
  it("refuses a payload that is not valid, empty, or too large", async () => {
    const p = await project(t.db);
    const store = fakeBucket();
    const input = {
      projectId: p.id,
      environment: "live" as const,
      supersedePlaces: false,
    };
    await expect(
      createTakeoutImport(t.db, store, { ...input, payload: "{nope" }),
    ).rejects.toThrow(ImportError);
    await expect(
      createTakeoutImport(t.db, store, {
        ...input,
        payload: JSON.stringify({
          format: "proofql.takeout.v1",
          complete: true,
          locations: [],
        }),
      }),
    ).rejects.toThrow("not in the expected shape");
    await expect(
      createTakeoutImport(t.db, store, {
        ...input,
        payload: JSON.stringify(
          buildTakeoutPayload(
            [{ locationId: "1", title: null, reviews: [], starOnly: 0 }],
            true,
          ),
        ),
      }),
    ).rejects.toThrow("no reviews");
    await expect(
      createTakeoutImport(t.db, store, {
        ...input,
        payload: "x".repeat(MAX_TAKEOUT_PAYLOAD_BYTES + 1),
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(store.objects.size).toBe(0);
  });

  it("reports an unreadable review in the error report, by review id", async () => {
    const p = await project(t.db);
    const locations = clone(fixtureLocations()).slice(1);
    (locations[0] as TakeoutLocation).reviews[0] = {
      ...((locations[0] as TakeoutLocation)
        .reviews[0] as TakeoutLocation["reviews"][number]),
      createTime: "not a date",
    };
    const { run, store } = await importPayload(
      p.id,
      buildTakeoutPayload(locations, true),
    );
    expect(run).toMatchObject({ status: "succeeded", created: 3, failed: 1 });
    const report = await errorReport(store, run);
    expect(report.state).toBe("ready");
    expect(report.state === "ready" && report.csv).toContain(
      "accounts/1009/locations/2002/reviews/PlStRv000Qz",
    );
  });

  it("shows the counts alone once the details object has expired", async () => {
    const p = await project(t.db);
    const { run, store } = await importPayload(
      p.id,
      buildTakeoutPayload(fixtureLocations(), true),
    );
    expect(await loadTakeoutDetails(store, run)).not.toBeNull();
    await store.delete(
      (run.artifactKey as string).replace(
        ".takeout.json",
        ".takeout.details.json",
      ),
    );
    expect(await loadTakeoutDetails(store, run)).toBeNull();
  });

  it("fails cleanly when the stored export has gone", async () => {
    const p = await project(t.db);
    const store = fakeBucket();
    const { runId, artifactKey } = await createTakeoutImport(t.db, store, {
      projectId: p.id,
      environment: "live",
      payload: JSON.stringify(buildTakeoutPayload(fixtureLocations(), true)),
      supersedePlaces: false,
    });
    await store.delete(artifactKey);
    const outcome = await runTakeoutImport(
      { db: t.db, store, queue: fakeQueue() },
      runId,
    );
    expect(outcome).toMatchObject({
      state: "failed",
      error: "The uploaded export is no longer available.",
    });
  });
});
