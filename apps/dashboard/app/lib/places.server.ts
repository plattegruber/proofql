/**
 * Server side of the Places bootstrap (#47).
 *
 * - **Configuration** (`placesConfigured`, `placesClientFor`): the card is
 *   enabled only where `GOOGLE_PLACES_API_KEY` is set; the client comes
 *   from `@proofql/google` (`createPlacesClient`, shared with the
 *   pipeline's 25-day refresh, #116) over the worker's `fetch` and the
 *   `CACHE` KV namespace, so a user retyping the same name, or two users
 *   of one business, cost one call (docs/places.md).
 * - **The import** (`importPlaceReviews`) fetches the place with its
 *   reviews, maps them (`mapPlaceReviews`), writes them through
 *   `upsertReviews` with the `truncate` cap policy exactly as the CSV
 *   import and `POST /v1/reviews` do, records an `ingest_runs` row of kind
 *   `places` with `artifact_key = places:<place_id>`, and enqueues one
 *   index message per inserted or re-indexed review. Re-running on the same
 *   place updates the same five rows (`source` + `external_id`), so it is
 *   idempotent and the Business Profile connector (#45) later takes them
 *   over rather than duplicating them.
 *
 * Plain functions over injected `fetch`, cache and queue, so the integration
 * tests drive the whole flow against the real schema with the fake Places
 * API (`@proofql/google/fake`) and no network.
 */
import type { Logger } from "@proofql/core";
import { type Db, schema, upsertReviews } from "@proofql/db";
import {
  createPlacesClient,
  kvPlacesCache,
  type MappedPlace,
  mapPlaceReviews,
  type PlaceMatch,
  type PlacesClient,
  placesArtifactKey,
} from "@proofql/google";
import { eq } from "drizzle-orm";

import type { Environment, IndexQueue, IngestRun } from "./csv.server";

// --- Configuration -----------------------------------------------------------

export type PlacesEnv = Partial<
  Pick<Env, "GOOGLE_PLACES_API_KEY" | "PLACES_API_BASE" | "CACHE">
>;

/** The card is enabled only where the owner has set the key (docs/secrets.md). */
export function placesConfigured(env: PlacesEnv): boolean {
  return (env.GOOGLE_PLACES_API_KEY?.trim() ?? "") !== "";
}

/** A client over the worker's env, or null when the key is not set. */
export function placesClientFor(
  env: PlacesEnv,
  options: { fetch?: typeof fetch; log?: Logger } = {},
): PlacesClient | null {
  const apiKey = env.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) return null;
  return createPlacesClient({
    apiKey,
    baseUrl: env.PLACES_API_BASE?.trim() || undefined,
    // A KV fault — the free plan's daily limit included — is a live fetch
    // from Google, never a failed search (#158).
    cache: env.CACHE
      ? kvPlacesCache(
          env.CACHE,
          options.log
            ? { log: options.log, site: "dashboard.places_cache" }
            : undefined,
        )
      : undefined,
    fetch: options.fetch,
  });
}

// --- The import --------------------------------------------------------------

export class PlacesImportError extends Error {
  override readonly name = "PlacesImportError";
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export interface ImportPlaceDeps {
  db: Db;
  places: PlacesClient;
  queue: IndexQueue;
  log?: Logger;
}

export interface ImportPlaceInput {
  projectId: string;
  environment: Environment;
  placeId: string;
}

export interface ImportPlaceResult {
  run: IngestRun;
  place: PlaceMatch;
  created: number;
  updated: number;
  /** Rating-only reviews, in-batch duplicates. */
  skipped: number;
  /** Refused by the plan's review cap. */
  failed: number;
  enqueued: number;
  /** Whether the place came from the KV cache rather than Google. */
  cached: boolean;
}

/**
 * Pull a place's public reviews into the project. Throws
 * `PlacesImportError` (no run row) when Google shares no usable review for
 * the place, and `PlacesError` when Google refuses; everything after the
 * run row exists is recorded on it.
 */
export async function importPlaceReviews(
  deps: ImportPlaceDeps,
  input: ImportPlaceInput,
): Promise<ImportPlaceResult> {
  const { db, queue } = deps;
  const { place: details, cached } = await deps.places.place(input.placeId);
  const mapped: MappedPlace = mapPlaceReviews(details);
  if ((details.reviews ?? []).length === 0) {
    throw new PlacesImportError(
      `Google shares no public reviews for ${mapped.place.name} yet.`,
      404,
    );
  }
  if (mapped.reviews.length === 0) {
    throw new PlacesImportError(
      `Google shares ${details.reviews?.length ?? 0} ${details.reviews?.length === 1 ? "review" : "reviews"} for ${mapped.place.name}, but none has text to index.`,
    );
  }

  const [opened] = await db
    .insert(schema.ingestRuns)
    .values({
      projectId: input.projectId,
      environment: input.environment,
      kind: "places",
      status: "running",
      received: details.reviews?.length ?? 0,
      artifactKey: placesArtifactKey(mapped.place.id),
    })
    .returning();
  if (opened === undefined)
    throw new Error("ingest run insert returned no row");
  const log = deps.log?.child({
    ingest_run_id: opened.id,
    project_id: input.projectId,
    environment: input.environment,
    place_id: mapped.place.id,
  });

  try {
    const result = await upsertReviews(db, {
      projectId: input.projectId,
      environment: input.environment,
      reviews: mapped.reviews,
      onLimit: "truncate",
    });
    if (result.toEnqueue.length > 0) {
      await queue.sendBatch(result.toEnqueue.map((body) => ({ body })));
    }
    const skipped = result.skipped + mapped.skipped.length;
    const failed = result.rejected.length;
    const [run] = await db
      .update(schema.ingestRuns)
      .set({
        status: "succeeded",
        created: result.created,
        updated: result.updated,
        skipped,
        failed,
        error:
          failed > 0
            ? `${failed} ${failed === 1 ? "review was" : "reviews were"} not imported: the project is at its review limit (${result.limit.toLocaleString("en-US")} on this plan).`
            : null,
        finishedAt: new Date(),
      })
      .where(eq(schema.ingestRuns.id, opened.id))
      .returning();
    if (run === undefined) throw new Error(`ingest run ${opened.id} vanished`);
    log?.log("places.imported", {
      received: run.received,
      created: run.created,
      updated: run.updated,
      skipped: run.skipped,
      failed: run.failed,
      enqueued: result.toEnqueue.length,
      cached,
    });
    return {
      run,
      place: mapped.place,
      created: result.created,
      updated: result.updated,
      skipped,
      failed,
      enqueued: result.toEnqueue.length,
      cached,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unhandled error";
    await db
      .update(schema.ingestRuns)
      .set({
        status: "failed",
        error: message.slice(0, 1000),
        finishedAt: new Date(),
      })
      .where(eq(schema.ingestRuns.id, opened.id));
    log?.log("places.failed", { level: "error", error });
    throw error;
  }
}
