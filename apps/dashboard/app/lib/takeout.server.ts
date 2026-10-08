/**
 * The Google Takeout import: a Business Profile's own reviews, exported by
 * its owner or a manager at takeout.google.com, brought into a project.
 *
 * The browser opens the archive (fflate, `components/import/takeout-*`),
 * keeps only the `reviews*.json` pages and the listing names, lets the user
 * pick locations, and posts a `TakeoutPayload` (@proofql/core) — the
 * reviews alone, never the photos the archive also holds. Here:
 *
 *   1. `createTakeoutImport` validates the payload again, normalizes it
 *      (each review once, under the location its name says), stores it in
 *      R2 as `uploads/<projectId>/<runId>.takeout.json` (the same 7-day
 *      lifecycle as every upload, #169) and opens an `ingest_runs` row of
 *      kind `takeout` with `received` = the reviews in it. There is no
 *      mapping step: the format is known.
 *   2. `runTakeoutImport` walks the reviews in a fixed order, in batches of
 *      `IMPORT_BATCH_SIZE`, through `commitBatch` (csv.server.ts) — so the
 *      same `upsertReviews`, cap policy, deferred-indexing handling and
 *      resume cursor as the CSV import. Before the upsert each review is
 *      matched to a stored Google review with the same
 *      `locations/<l>/reviews/<r>` suffix (the account part of the name
 *      varies) and written under that row's `external_id`; one whose stored
 *      copy is newer than the export's `updateTime` is skipped as stale
 *      (an older export never overwrites a newer edit). Star-only reviews
 *      are skipped and counted.
 *   3. On the last batch, `finishTakeoutImport`:
 *      - a **complete** export (whole archives): deletes the project's
 *        Google reviews of each imported location that the export no
 *        longer has — deleted on Google — when they are older than the
 *        export itself (`exportAsOf`), so a review the connector brought in
 *        after the export was made survives;
 *      - when the user confirmed it: deletes the environment's Places
 *        bootstrap rows (`places/…`), which the export replaces. The Places
 *        refresh skips a project/environment with a succeeded Takeout run
 *        (workers/pipeline/src/places-refresh.ts), and the Places card
 *        refuses to import into one (places.server.ts);
 *      - bumps the project's cache generation once if anything was deleted
 *        (indexing bumps it for the rest, as for every import);
 *      - records the breakdown in `ingest_runs.details` (`TakeoutRunDetails`).
 */
import {
  createLogger,
  exportAsOf,
  type GenerationKv,
  type Logger,
  mapTakeoutReview,
  normalizeTakeoutPayload,
  type ReviewInput,
  reviewSuffix,
  safeBumpProjectGeneration,
  silentSink,
  TAKEOUT_METADATA,
  takeoutPayloadSchema,
} from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { PLACES_BOOTSTRAP_PREFIX } from "@proofql/google";
import { and, eq, inArray, like, lte, sql } from "drizzle-orm";
import { z } from "zod";

import {
  type BatchContext,
  commitBatch,
  DEFAULT_RUN_BUDGET_MS,
  type Environment,
  fail,
  findRun,
  IMPORT_BATCH_SIZE,
  ImportError,
  type IndexQueue,
  type IngestRun,
  loadFailures,
  processedRows,
  type RowFailure,
  type RunOutcome,
  type UploadStore,
} from "./csv.server";
import { formatBytes } from "./import-labels";

/** Largest payload accepted: the reviews alone, after the browser dropped the rest. */
export const MAX_TAKEOUT_PAYLOAD_BYTES = 10 * 1024 * 1024;

export function takeoutArtifactKey(projectId: string, runId: string): string {
  return `uploads/${projectId}/${runId}.takeout.json`;
}

/** The outcome beyond the counts, stored in `ingest_runs.details`. */
export const takeoutRunDetailsSchema = z.object({
  complete: z.boolean(),
  supersede_places: z.boolean(),
  locations: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      reviews: z.number().int(),
    }),
  ),
  /** Repeats dropped when the payload was normalized. */
  duplicates: z.number().int(),
  /** Reviews with a rating and no text (part of `skipped`). */
  star_only: z.number().int(),
  /** Reviews whose stored copy was newer (part of `skipped`; set at finish). */
  stale: z.number().int().optional(),
  /** Stored reviews deleted because the complete export no longer has them. */
  removed: z.number().int().optional(),
  /** Places bootstrap rows replaced. */
  places_removed: z.number().int().optional(),
});

export type TakeoutRunDetails = z.output<typeof takeoutRunDetailsSchema>;

export function takeoutDetails(run: IngestRun): TakeoutRunDetails | null {
  const parsed = takeoutRunDetailsSchema.safeParse(run.details);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Step 1 — accept the payload
// ---------------------------------------------------------------------------

export interface CreateTakeoutInput {
  projectId: string;
  environment: Environment;
  payload: string;
  /** The user confirmed the Places bootstrap rows may be replaced. */
  supersedePlaces: boolean;
}

/** The stored artifact: the normalized locations and the user's choices. */
const storedTakeoutSchema = z.object({
  complete: z.boolean(),
  supersede_places: z.boolean(),
  locations: z.array(
    z.object({
      locationId: z.string(),
      title: z.string().nullable(),
      starOnly: z.number().int(),
      reviews: takeoutPayloadSchema.shape.locations.element.shape.reviews,
    }),
  ),
});

type StoredTakeout = z.output<typeof storedTakeoutSchema>;

export async function createTakeoutImport(
  db: Db,
  store: UploadStore,
  input: CreateTakeoutInput,
): Promise<{ runId: string; artifactKey: string; reviews: number }> {
  const bytes = new TextEncoder().encode(input.payload).byteLength;
  if (bytes > MAX_TAKEOUT_PAYLOAD_BYTES) {
    throw new ImportError(
      `These reviews are ${formatBytes(bytes)} of text; one import takes up to ${formatBytes(MAX_TAKEOUT_PAYLOAD_BYTES)}. Import fewer locations at a time.`,
      413,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(input.payload);
  } catch {
    throw new ImportError(
      "The import data could not be read. Choose the export again.",
    );
  }
  const parsed = takeoutPayloadSchema.safeParse(json);
  if (!parsed.success) {
    throw new ImportError(
      "The import data is not in the expected shape. Reload the page and choose the export again.",
    );
  }
  const normalized = normalizeTakeoutPayload(parsed.data);
  const total = normalized.locations.reduce((n, l) => n + l.reviews.length, 0);
  if (total === 0) {
    throw new ImportError(
      "The export has no reviews for the chosen locations.",
    );
  }

  const runId = crypto.randomUUID();
  const artifactKey = takeoutArtifactKey(input.projectId, runId);
  const stored: StoredTakeout = {
    complete: normalized.complete,
    supersede_places: input.supersedePlaces,
    locations: normalized.locations,
  };
  await store.put(artifactKey, JSON.stringify(stored));
  const details: TakeoutRunDetails = {
    complete: normalized.complete,
    supersede_places: input.supersedePlaces,
    locations: normalized.locations.map((l) => ({
      id: l.locationId,
      title: l.title,
      reviews: l.reviews.length,
    })),
    duplicates: normalized.duplicates + normalized.misfiled,
    star_only: normalized.locations.reduce((n, l) => n + l.starOnly, 0),
  };
  await db.insert(schema.ingestRuns).values({
    id: runId,
    projectId: input.projectId,
    environment: input.environment,
    kind: "takeout",
    status: "running",
    received: total,
    artifactKey,
    details,
  });
  return { runId, artifactKey, reviews: total };
}

// ---------------------------------------------------------------------------
// Step 2 — run
// ---------------------------------------------------------------------------

export interface RunTakeoutDeps {
  db: Db;
  store: UploadStore;
  queue: IndexQueue;
  /** For the one generation bump after deletions; absent in some tests. */
  kv?: GenerationKv;
  log?: Logger;
  budgetMs?: number;
  now?: () => number;
}

/** A stored Google review that a Takeout review may update. */
interface StoredMatch {
  externalId: string;
  /** Google's `updateTime` of the stored copy, else when we last wrote it. */
  asOf: number;
}

/**
 * Process the stored payload from where the counts say we left off. Safe
 * to call again on a running run (the progress page's "Resume"); a no-op
 * for a finished one.
 */
export async function runTakeoutImport(
  deps: RunTakeoutDeps,
  runId: string,
): Promise<RunOutcome> {
  const { db, store, queue } = deps;
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? DEFAULT_RUN_BUDGET_MS;
  const startedAt = now();
  const log = deps.log?.child({ ingest_run_id: runId });

  const run = await findRun(db, runId);
  if (run.status !== "running") return { state: "finished", run };
  if (run.kind !== "takeout" || run.artifactKey === null) {
    return fail(db, run, "This run has no Takeout export.", log);
  }
  const object = await store.get(run.artifactKey);
  if (object === null) {
    return fail(db, run, "The uploaded export is no longer available.", log);
  }
  const takeout = storedTakeoutSchema.parse(JSON.parse(await object.text()));
  const alreadyProcessed = processedRows(run);
  log?.log("takeout.started", {
    project_id: run.projectId,
    environment: run.environment,
    locations: takeout.locations.length,
    total_reviews: run.received,
    resume_from: alreadyProcessed,
  });

  const existing = await storedMatches(
    db,
    run,
    takeout.locations.map((l) => l.locationId),
  );
  const ctx: BatchContext = {
    db,
    queue,
    store,
    run,
    failures: await loadFailures(store, run.artifactKey),
    log,
    queueExhausted: false,
    deferred: 0,
  };

  let batch: { rowNumber: number; review: ReviewInput }[] = [];
  let failures: RowFailure[] = [];
  let skipped = 0;
  let pending = 0;
  let processed = alreadyProcessed;
  let paused = false;
  const flush = async () => {
    if (pending === 0) return;
    await commitBatch(ctx, batch, failures, skipped);
    processed += pending;
    batch = [];
    failures = [];
    skipped = 0;
    pending = 0;
  };

  try {
    let rowNumber = 0;
    outer: for (const location of takeout.locations) {
      for (const raw of location.reviews) {
        rowNumber += 1;
        if (rowNumber <= alreadyProcessed) continue;
        pending += 1;
        const mapped = mapTakeoutReview(raw, location);
        if (!mapped.ok) {
          if (mapped.reason === "star_only") skipped += 1;
          else
            failures.push({
              rowNumber,
              reason: `${raw.name}: ${mapped.message}`,
            });
        } else {
          const suffix = reviewSuffix(mapped.review.external_id) as string;
          const match = existing.get(suffix);
          if (match && match.asOf > mapped.editedAt) {
            skipped += 1; // the stored copy is newer than this export
          } else {
            batch.push({
              rowNumber,
              review: match
                ? { ...mapped.review, external_id: match.externalId }
                : mapped.review,
            });
          }
        }
        if (pending >= IMPORT_BATCH_SIZE) {
          await flush();
          if (now() - startedAt > budgetMs) {
            paused = true;
            break outer;
          }
        }
      }
    }
    if (!paused) await flush();
  } catch (error) {
    await flush().catch(() => {});
    const message = error instanceof Error ? error.message : "unhandled error";
    return fail(
      db,
      run,
      `Import stopped at review ${processed + 1}: ${message}`,
      log,
    );
  }

  if (paused) {
    const current = await findRun(db, runId);
    log?.log("takeout.paused", {
      processed,
      total_reviews: run.received,
      indexing_deferred: ctx.deferred,
    });
    return { state: "paused", run: current, processed };
  }

  const finished = await finishTakeoutImport(deps, runId, takeout, log);
  log?.log("takeout.finished", {
    created: finished.created,
    updated: finished.updated,
    skipped: finished.skipped,
    failed: finished.failed,
    removed: takeoutDetails(finished)?.removed ?? 0,
    places_removed: takeoutDetails(finished)?.places_removed ?? 0,
    indexing_deferred: ctx.deferred,
    duration_ms: now() - startedAt,
  });
  return { state: "finished", run: finished };
}

/**
 * The project's stored Google reviews of these locations, by suffix. One
 * query per call (a resume reloads it): the reviews of a location are a
 * `LIKE '%/locations/<id>/reviews/%'` over the project's Google rows.
 */
async function storedMatches(
  db: Db,
  run: IngestRun,
  locationIds: string[],
): Promise<Map<string, StoredMatch>> {
  const matches = new Map<string, StoredMatch>();
  if (locationIds.length === 0) return matches;
  const rows = await db
    .select({
      externalId: schema.reviews.externalId,
      updatedAt: schema.reviews.updatedAt,
      googleUpdateTime: sql<
        string | null
      >`${schema.reviews.metadata}->>${TAKEOUT_METADATA.updateTime}`,
    })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.projectId, run.projectId),
        eq(schema.reviews.environment, run.environment),
        eq(schema.reviews.source, "google"),
        sql`(${sql.join(
          locationIds.map(
            (id) =>
              sql`${schema.reviews.externalId} LIKE ${`%locations/${escapeLike(id)}/reviews/%`}`,
          ),
          sql` OR `,
        )})`,
      ),
    );
  for (const row of rows) {
    const suffix = reviewSuffix(row.externalId);
    if (suffix === null) continue;
    const google = row.googleUpdateTime
      ? Date.parse(row.googleUpdateTime)
      : NaN;
    matches.set(suffix, {
      externalId: row.externalId,
      asOf: Number.isNaN(google) ? row.updatedAt.getTime() : google,
    });
  }
  return matches;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------------------
// Step 3 — finish: deletions, Places supersession, the record
// ---------------------------------------------------------------------------

async function finishTakeoutImport(
  deps: RunTakeoutDeps,
  runId: string,
  takeout: StoredTakeout,
  log: Logger | undefined,
): Promise<IngestRun> {
  const { db } = deps;
  const run = await findRun(db, runId);
  const details = takeoutDetails(run);

  const { removed, placesRemoved } = await db.transaction(async (tx) => {
    let removed = 0;
    if (takeout.complete) {
      for (const location of takeout.locations) {
        removed += await deleteMissing(tx, run, location);
      }
    }
    let placesRemoved = 0;
    if (takeout.supersede_places) {
      placesRemoved = await deletePlacesBootstrap(tx, run);
    }
    if (removed + placesRemoved > 0) {
      await tx
        .update(schema.projects)
        .set({
          reviewCount: sql`GREATEST(${schema.projects.reviewCount} - ${removed + placesRemoved}, 0)`,
        })
        .where(eq(schema.projects.id, run.projectId));
    }
    return { removed, placesRemoved };
  });

  if (removed + placesRemoved > 0 && deps.kv) {
    await safeBumpProjectGeneration(deps.kv, run.projectId, {
      log:
        log ??
        createLogger({
          service: "dashboard",
          environment: "unknown",
          sink: silentSink,
        }),
      site: "dashboard.takeout_import",
    });
  }

  // `skipped` is star-only + stale (the payload has no repeats left).
  const stale = Math.max(0, run.skipped - (details?.star_only ?? 0));
  const [finished] = await db
    .update(schema.ingestRuns)
    .set({
      status: "succeeded",
      finishedAt: new Date(),
      details: {
        ...(details ?? {}),
        stale,
        removed,
        places_removed: placesRemoved,
      },
    })
    .where(eq(schema.ingestRuns.id, runId))
    .returning();
  if (finished === undefined) throw new Error(`ingest run ${runId} vanished`);
  return finished;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Delete the location's stored Google reviews that the complete export
 * does not have and that are older than the export. Chunks cascade.
 */
async function deleteMissing(
  tx: Tx,
  run: IngestRun,
  location: StoredTakeout["locations"][number],
): Promise<number> {
  const asOf = exportAsOf(location.reviews);
  if (asOf === null) return 0;
  const keep = location.reviews
    .map((r) => reviewSuffix(r.name))
    .filter((s): s is string => s !== null);
  const rows = await tx
    .select({ id: schema.reviews.id, externalId: schema.reviews.externalId })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.projectId, run.projectId),
        eq(schema.reviews.environment, run.environment),
        eq(schema.reviews.source, "google"),
        like(
          schema.reviews.externalId,
          `%locations/${escapeLike(location.locationId)}/reviews/%`,
        ),
        lte(schema.reviews.occurredAt, new Date(asOf)),
      ),
    );
  const keepSet = new Set(keep);
  const gone = rows
    .filter((row) => {
      const suffix = reviewSuffix(row.externalId);
      return suffix !== null && !keepSet.has(suffix);
    })
    .map((row) => row.id);
  if (gone.length === 0) return 0;
  let deleted = 0;
  for (let i = 0; i < gone.length; i += 500) {
    const slice = gone.slice(i, i + 500);
    const result = await tx
      .delete(schema.reviews)
      .where(inArray(schema.reviews.id, slice))
      .returning({ id: schema.reviews.id });
    deleted += result.length;
  }
  return deleted;
}

/** The environment's Places bootstrap rows (`places/…`), which the export replaces. */
async function deletePlacesBootstrap(tx: Tx, run: IngestRun): Promise<number> {
  const deleted = await tx
    .delete(schema.reviews)
    .where(
      and(
        eq(schema.reviews.projectId, run.projectId),
        eq(schema.reviews.environment, run.environment),
        eq(schema.reviews.source, "google"),
        like(schema.reviews.externalId, `${PLACES_BOOTSTRAP_PREFIX}%`),
      ),
    )
    .returning({ id: schema.reviews.id });
  return deleted.length;
}

// ---------------------------------------------------------------------------
// What the import page shows before anything is written
// ---------------------------------------------------------------------------

export interface PlacesBootstrapSummary {
  environment: Environment;
  reviews: number;
  /** The places they came from (`metadata.place_name`), for the confirm copy. */
  places: string[];
}

/** The project's Places bootstrap rows per environment, for the confirm copy. */
export async function placesBootstrapSummary(
  db: Db,
  projectId: string,
): Promise<PlacesBootstrapSummary[]> {
  const rows = await db
    .select({
      environment: schema.reviews.environment,
      place: sql<string | null>`${schema.reviews.metadata}->>'place_name'`,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.projectId, projectId),
        eq(schema.reviews.source, "google"),
        like(schema.reviews.externalId, `${PLACES_BOOTSTRAP_PREFIX}%`),
      ),
    )
    .groupBy(
      schema.reviews.environment,
      sql`${schema.reviews.metadata}->>'place_name'`,
    );
  const byEnvironment = new Map<Environment, PlacesBootstrapSummary>();
  for (const row of rows) {
    const summary = byEnvironment.get(row.environment) ?? {
      environment: row.environment,
      reviews: 0,
      places: [],
    };
    summary.reviews += row.count;
    if (row.place) summary.places.push(row.place);
    byEnvironment.set(row.environment, summary);
  }
  return [...byEnvironment.values()];
}

/** Whether a Takeout import already succeeded in this project and environment. */
export async function hasTakeoutImport(
  db: Db,
  projectId: string,
  environment: Environment,
): Promise<boolean> {
  const row = await db.query.ingestRuns.findFirst({
    columns: { id: true },
    where: and(
      eq(schema.ingestRuns.projectId, projectId),
      eq(schema.ingestRuns.environment, environment),
      eq(schema.ingestRuns.kind, "takeout"),
      eq(schema.ingestRuns.status, "succeeded"),
    ),
  });
  return row !== undefined;
}
