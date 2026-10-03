/**
 * Server side of the Places bootstrap (#47).
 *
 * - **The client** (`createPlacesClient`) speaks Places API (New) over
 *   `fetch` with an ordinary API key: `places:searchText` and
 *   `GET /v1/places/{id}`, each with the narrowest `X-Goog-FieldMask` that
 *   carries what we read, because the mask is what Google bills on
 *   (docs/places.md). Both calls are cached for PLACES_CACHE_TTL_S in the
 *   `CACHE` KV namespace — searches under `places:q:<sha256 of the
 *   normalized query>`, places under `places:p:<id>` — so a user retyping
 *   the same name, or two users of one business, cost one call.
 * - **The import** (`importPlaceReviews`) fetches the place with its
 *   reviews, maps them (app/lib/places.ts), writes them through
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
 * API (test/fake-places.ts) and no network.
 */
import type { Logger } from "@proofql/core";
import { type Db, schema, upsertReviews } from "@proofql/db";
import { eq } from "drizzle-orm";

import type { Environment, IndexQueue, IngestRun } from "./csv.server";
import {
  type MappedPlace,
  mapPlaceReviews,
  normalizeSearchQuery,
  PLACES_API_BASE_DEFAULT,
  PLACES_CACHE_TTL_S,
  PLACES_MAX_RESULTS,
  PLACES_PLACE_FIELD_MASK,
  PLACES_SEARCH_CACHE_PREFIX,
  PLACES_SEARCH_FIELD_MASK,
  type PlaceDetails,
  type PlaceMatch,
  placeCacheKey,
  placeDetailsSchema,
  placesArtifactKey,
  placesSearchResponseSchema,
  toPlaceMatch,
} from "./places";

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
  options: { fetch?: typeof fetch } = {},
): PlacesClient | null {
  const apiKey = env.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) return null;
  return createPlacesClient({
    apiKey,
    baseUrl: env.PLACES_API_BASE?.trim() || undefined,
    cache: env.CACHE ? kvPlacesCache(env.CACHE) : undefined,
    fetch: options.fetch,
  });
}

// --- Cache -------------------------------------------------------------------

/** The slice of KV the client uses; tests pass a Map-backed one. */
export interface PlacesCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export function kvPlacesCache(kv: KVNamespace): PlacesCache {
  return {
    get: (key) => kv.get(key, "text"),
    put: (key, value, ttlSeconds) =>
      kv.put(key, value, { expirationTtl: ttlSeconds }),
  };
}

/** `places:q:<sha256 hex>` of the normalized query. */
export async function searchCacheKey(query: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeSearchQuery(query));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${PLACES_SEARCH_CACHE_PREFIX}${hex}`;
}

// --- The client --------------------------------------------------------------

export class PlacesError extends Error {
  override readonly name = "PlacesError";
  constructor(
    message: string,
    /** HTTP status Google answered with; 502 when the response was unreadable. */
    readonly status: number,
    /** Google's `error.status` (`PERMISSION_DENIED`, `NOT_FOUND`, ...). */
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export interface PlacesClient {
  /** Up to PLACES_MAX_RESULTS places matching a free-text query. */
  search(query: string): Promise<{ matches: PlaceMatch[]; cached: boolean }>;
  /** The place with its (at most five) reviews. */
  place(placeId: string): Promise<{ place: PlaceDetails; cached: boolean }>;
}

export interface PlacesClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  cache?: PlacesCache;
  ttlSeconds?: number;
}

export function createPlacesClient(options: PlacesClientOptions): PlacesClient {
  const base = (options.baseUrl ?? PLACES_API_BASE_DEFAULT).replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const ttl = options.ttlSeconds ?? PLACES_CACHE_TTL_S;
  const cache = options.cache;

  async function call(
    path: string,
    init: { method: "GET" | "POST"; fieldMask: string; body?: unknown },
  ): Promise<unknown> {
    const response = await doFetch(`${base}${path}`, {
      method: init.method,
      headers: {
        "X-Goog-Api-Key": options.apiKey,
        "X-Goog-FieldMask": init.fieldMask,
        ...(init.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!response.ok) throw await errorFrom(response);
    try {
      return await response.json();
    } catch {
      throw new PlacesError("Google answered with an unreadable body.", 502);
    }
  }

  return {
    async search(query) {
      const key = await searchCacheKey(query);
      const hit = await cache?.get(key);
      if (hit) {
        return { matches: JSON.parse(hit) as PlaceMatch[], cached: true };
      }
      const raw = await call("/v1/places:searchText", {
        method: "POST",
        fieldMask: PLACES_SEARCH_FIELD_MASK,
        body: { textQuery: query, pageSize: PLACES_MAX_RESULTS },
      });
      const parsed = placesSearchResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new PlacesError("Google answered in an unexpected shape.", 502);
      }
      const matches = (parsed.data.places ?? [])
        .slice(0, PLACES_MAX_RESULTS)
        .map(toPlaceMatch);
      await cache?.put(key, JSON.stringify(matches), ttl);
      return { matches, cached: false };
    },

    async place(placeId) {
      const key = placeCacheKey(placeId);
      const hit = await cache?.get(key);
      if (hit) {
        const parsed = placeDetailsSchema.safeParse(JSON.parse(hit));
        if (parsed.success) return { place: parsed.data, cached: true };
      }
      const raw = await call(`/v1/places/${encodeURIComponent(placeId)}`, {
        method: "GET",
        fieldMask: PLACES_PLACE_FIELD_MASK,
      });
      const parsed = placeDetailsSchema.safeParse(raw);
      if (!parsed.success) {
        throw new PlacesError("Google answered in an unexpected shape.", 502);
      }
      await cache?.put(key, JSON.stringify(parsed.data), ttl);
      return { place: parsed.data, cached: false };
    },
  };
}

async function errorFrom(response: Response): Promise<PlacesError> {
  let message = `Google answered ${response.status}.`;
  let code: string | null = null;
  try {
    const body = (await response.json()) as {
      error?: { message?: string; status?: string };
    };
    if (body.error?.message) message = body.error.message;
    code = body.error?.status ?? null;
  } catch {
    // keep the status line
  }
  return new PlacesError(message, response.status, code);
}

/** What the card shows for a client error; never Google's raw 5xx text. */
export function describePlacesError(error: PlacesError): string {
  if (error.status === 404) return "Google no longer lists this place.";
  if (error.status === 403 || error.status === 401) {
    return "Google refused the Places API key for this environment; the owner needs to check its restrictions.";
  }
  if (error.status === 429) {
    return "Google is rate-limiting Places lookups right now; try again in a minute.";
  }
  if (error.status >= 500) return "Google Places is unavailable right now.";
  return `Google refused the request: ${error.message}`;
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
