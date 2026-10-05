/**
 * Google Places API (New) — the bootstrap's pure parts and its client
 * (#47, #116; docs/places.md). Shared by the dashboard (the "Find your
 * business on Google" card and import) and the pipeline (the 25-day
 * refresh of bootstrapped reviews), so it lives here rather than in either.
 *
 * - **Shapes**: the slices of `places:searchText` and `GET /v1/places/{id}`
 *   responses we read, as zod schemas.
 * - **The mapper** (`mapPlaceReviews`): a Places review onto
 *   `reviewInputSchema`, so nothing the push API would refuse gets in by
 *   the side door. `external_id` is the review's resource name
 *   (`places/<place>/reviews/<review>`) and `source` is `google`.
 * - **Keys**: `ingest_runs.artifact_key = places:<id>`, KV cache keys
 *   `places:q:<sha256 of the normalized query>` and `places:p:<id>`.
 * - **The client** (`createPlacesClient`): `fetch` with an ordinary API
 *   key and the narrowest `X-Goog-FieldMask` that carries what we read,
 *   because the mask is what Google bills on. Both calls are cached for
 *   PLACES_CACHE_TTL_S in whatever `PlacesCache` the caller hands over
 *   (the `CACHE` KV namespace in the workers; a Map in tests). A place
 *   fetch can bypass the cached copy (`fresh: true`) and still write the
 *   result through, which is what the refresh wants.
 *
 * Runtime-agnostic: WebCrypto, `fetch`, `TextEncoder` — nothing from
 * Workers or Node. Google shares at most five "most relevant" public
 * reviews per place; the full set needs the Business Profile connector.
 */
import {
  type KvGuardContext,
  kvFaults,
  type ReviewInput,
  reviewInputSchema,
} from "@proofql/core";
import { z } from "zod";

// --- Constants ---------------------------------------------------------------

export const PLACES_API_BASE_DEFAULT = "https://places.googleapis.com";
/** Matches shown after a search; Places caps `pageSize` at 20, we want few. */
export const PLACES_MAX_RESULTS = 5;
/** What Google returns per place, at most. Shown on the card, not tunable. */
export const PLACES_REVIEWS_PER_PLACE = 5;
/** Search and place fetches are cached in KV for a day (docs/places.md). */
export const PLACES_CACHE_TTL_S = 24 * 60 * 60;
/** `X-Goog-FieldMask` for `places:searchText` — fields nest under `places.`. */
export const PLACES_SEARCH_FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount";
/** `X-Goog-FieldMask` for `GET /v1/places/{id}`. */
export const PLACES_PLACE_FIELD_MASK =
  "id,displayName,formattedAddress,rating,userRatingCount,reviews";
/** `author_name` when Google sends a review with no attribution name. */
export const PLACES_ANONYMOUS_AUTHOR = "A Google user";
/**
 * Every Places review name — and so every bootstrap row's `external_id` —
 * starts with this; Business Profile ids do not, which is how the
 * connector's first sync tells the bootstrap rows apart (#115).
 */
export const PLACES_BOOTSTRAP_PREFIX = "places/";

// --- Response shapes ---------------------------------------------------------

const localizedText = z.looseObject({
  text: z.string().optional(),
  languageCode: z.string().optional(),
});

export const placeSummarySchema = z.looseObject({
  id: z.string().min(1),
  displayName: localizedText.optional(),
  formattedAddress: z.string().optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().int().nonnegative().optional(),
});

export const placeReviewSchema = z.looseObject({
  /** `places/<place>/reviews/<review>` — the upsert key. */
  name: z.string().min(1),
  rating: z.number().int().min(1).max(5).optional(),
  text: localizedText.optional(),
  originalText: localizedText.optional(),
  authorAttribution: z
    .looseObject({
      displayName: z.string().optional(),
      uri: z.string().optional(),
      photoUri: z.string().optional(),
    })
    .optional(),
  publishTime: z.string().optional(),
  googleMapsUri: z.string().optional(),
});

export const placeDetailsSchema = placeSummarySchema.extend({
  /** Absent when the place has no reviews. */
  reviews: z.array(placeReviewSchema).optional(),
});

/** `places:searchText` returns `{}` when nothing matches. */
export const placesSearchResponseSchema = z.looseObject({
  places: z.array(placeSummarySchema).optional(),
});

export type PlaceSummary = z.output<typeof placeSummarySchema>;
export type PlaceReview = z.output<typeof placeReviewSchema>;
export type PlaceDetails = z.output<typeof placeDetailsSchema>;

/** A search result as the card shows it. */
export interface PlaceMatch {
  id: string;
  name: string;
  address: string | null;
  rating: number | null;
  ratingCount: number | null;
}

export function toPlaceMatch(place: PlaceSummary): PlaceMatch {
  return {
    id: place.id,
    name: place.displayName?.text?.trim() || "Unnamed place",
    address: place.formattedAddress?.trim() || null,
    rating: place.rating ?? null,
    ratingCount: place.userRatingCount ?? null,
  };
}

// --- The mapper --------------------------------------------------------------

export type MappedPlaceReview =
  | { ok: true; review: ReviewInput }
  | { ok: false; name: string; reason: string };

function url(value: string | undefined): string | null {
  if (!value) return null;
  return z.url().safeParse(value).success ? value : null;
}

/**
 * One Places review → the push-API shape, through `reviewInputSchema` so
 * nothing the API would refuse gets in by the side door.
 *
 * - `external_id` is the review's resource `name`; `source` is `google`, so
 *   the Business Profile connector, which uses the same resource
 *   names, updates these rows instead of duplicating them.
 * - Text is `text.text`, falling back to `originalText.text` (Places
 *   translates `text` into the request language and keeps the original
 *   beside it). A rating-only review has neither and is skipped.
 * - `url` is the review on Maps when Google sends `googleMapsUri`, else the
 *   author's attribution link — Google's terms want the attribution shown
 *   and linked, and the snippet links the source badge to `url`.
 * - `metadata.place_id` / `place_name` tie the review to the place it came
 *   from, filterable at query time.
 */
export function mapPlaceReview(
  place: Pick<PlaceMatch, "id" | "name">,
  review: PlaceReview,
): MappedPlaceReview {
  const text = review.text?.text?.trim() || review.originalText?.text?.trim();
  if (!text) {
    return {
      ok: false,
      name: review.name,
      reason: "The review has a rating but no text.",
    };
  }
  const language =
    review.text?.text?.trim() && review.text.languageCode
      ? review.text.languageCode
      : review.originalText?.languageCode;
  const parsed = reviewInputSchema.safeParse({
    external_id: review.name,
    source: "google",
    rating: review.rating ?? null,
    text,
    author_name:
      review.authorAttribution?.displayName?.trim() || PLACES_ANONYMOUS_AUTHOR,
    author_avatar_url: url(review.authorAttribution?.photoUri),
    occurred_at: review.publishTime,
    url: url(review.googleMapsUri) ?? url(review.authorAttribution?.uri),
    ...(language ? { language } : {}),
    metadata: {
      place_id: place.id,
      place_name: place.name.slice(0, 512),
    },
  });
  if (!parsed.success) {
    return {
      ok: false,
      name: review.name,
      reason: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true, review: parsed.data };
}

export interface MappedPlace {
  place: PlaceMatch;
  reviews: ReviewInput[];
  skipped: { name: string; reason: string }[];
}

/** Every review of a place that maps, and why the others did not. */
export function mapPlaceReviews(details: PlaceDetails): MappedPlace {
  const place = toPlaceMatch(details);
  const reviews: ReviewInput[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const review of details.reviews ?? []) {
    const mapped = mapPlaceReview(place, review);
    if (mapped.ok) reviews.push(mapped.review);
    else skipped.push({ name: mapped.name, reason: mapped.reason });
  }
  return { place, reviews, skipped };
}

// --- Keys --------------------------------------------------------------------

/**
 * `ingest_runs.artifact_key` for a Places run. There is no schema change
 * for the bootstrap (#47): the place a project was seeded from is readable
 * from its runs, and from `metadata.place_id` on the reviews.
 */
export function placesArtifactKey(placeId: string): string {
  return `places:${placeId}`;
}

export function placeIdFromArtifactKey(artifactKey: string): string | null {
  return artifactKey.startsWith("places:")
    ? artifactKey.slice("places:".length) || null
    : null;
}

/** Whitespace-collapsed, lowercased: "Cedar  Ridge" and "cedar ridge" share a cache entry. */
export function normalizeSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/** KV key of a cached place fetch; the search key needs a hash (`searchCacheKey`). */
export function placeCacheKey(placeId: string): string {
  return `places:p:${placeId}`;
}

export const PLACES_SEARCH_CACHE_PREFIX = "places:q:";

/** `places:q:<sha256 hex>` of the normalized query. */
export async function searchCacheKey(query: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeSearchQuery(query));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${PLACES_SEARCH_CACHE_PREFIX}${hex}`;
}

// --- Cache -------------------------------------------------------------------

/** The slice of KV the client uses; tests pass a Map-backed one. */
export interface PlacesCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/**
 * The slice of a Workers `KVNamespace` `kvPlacesCache` reads, written
 * structurally so this package needs no Workers types; `env.CACHE` fits,
 * and so does `@proofql/core`'s `MemoryKv`.
 */
export interface PlacesKv {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

/**
 * The Places cache over a KV namespace. Never throws (#158): a failed read
 * — including KV's daily `KV get() limit exceeded` on the Workers Free plan
 * — is a miss, so the client fetches live from Google; a failed write is
 * swallowed. Both are reported through `guard` (the throttled
 * `kv.limit_exceeded` / `kv.read_failed` / `kv.write_failed` lines from
 * `@proofql/core`) when one is given.
 */
export function kvPlacesCache(
  kv: PlacesKv,
  guard?: KvGuardContext,
): PlacesCache {
  const report = (op: "get" | "put", error: unknown) => {
    if (guard)
      (guard.reporter ?? kvFaults).report(guard.log, op, guard.site, error);
  };
  return {
    get: async (key) => {
      try {
        return await kv.get(key);
      } catch (error) {
        report("get", error);
        return null;
      }
    },
    put: async (key, value, ttlSeconds) => {
      try {
        await kv.put(key, value, { expirationTtl: ttlSeconds });
      } catch (error) {
        report("put", error);
      }
    },
  };
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

export interface PlaceFetchOptions {
  /**
   * Skip the cached copy and ask Google, then write the answer through to
   * the cache. The refresh (#116) sets this: the point is freshness, and
   * a dashboard re-import within the day then reads the fresh copy.
   */
  fresh?: boolean;
}

export interface PlacesClient {
  /** Up to PLACES_MAX_RESULTS places matching a free-text query. */
  search(query: string): Promise<{ matches: PlaceMatch[]; cached: boolean }>;
  /** The place with its (at most five) reviews. */
  place(
    placeId: string,
    options?: PlaceFetchOptions,
  ): Promise<{ place: PlaceDetails; cached: boolean }>;
  /** Requests actually sent to Google (cache hits excluded). */
  readonly requests: number;
}

export interface PlacesClientOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  cache?: PlacesCache | undefined;
  ttlSeconds?: number | undefined;
}

export function createPlacesClient(options: PlacesClientOptions): PlacesClient {
  const base = (options.baseUrl ?? PLACES_API_BASE_DEFAULT).replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const ttl = options.ttlSeconds ?? PLACES_CACHE_TTL_S;
  const cache = options.cache;
  let requests = 0;

  async function call(
    path: string,
    init: { method: "GET" | "POST"; fieldMask: string; body?: unknown },
  ): Promise<unknown> {
    requests += 1;
    const response = await doFetch(`${base}${path}`, {
      method: init.method,
      headers: {
        "X-Goog-Api-Key": options.apiKey,
        "X-Goog-FieldMask": init.fieldMask,
        ...(init.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) throw await errorFrom(response);
    try {
      return await response.json();
    } catch {
      throw new PlacesError("Google answered with an unreadable body.", 502);
    }
  }

  return {
    get requests() {
      return requests;
    },

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

    async place(placeId, fetchOptions = {}) {
      const key = placeCacheKey(placeId);
      if (!fetchOptions.fresh) {
        const hit = await cache?.get(key);
        if (hit) {
          const parsed = placeDetailsSchema.safeParse(JSON.parse(hit));
          if (parsed.success) return { place: parsed.data, cached: true };
        }
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

/** What a human sees for a client error; never Google's raw 5xx text. */
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
