/**
 * Pure side of the Places bootstrap (#47): the Places API (New) response
 * shapes we read, the mapping of a Places review onto `reviewInputSchema`,
 * and the key conventions (`ingest_runs.artifact_key`, KV cache keys). No
 * I/O, so the mapper is unit-tested on fixtures (places.test.ts) and the
 * module is safe in the browser bundle.
 *
 * Google shares at most five "most relevant" public reviews per place
 * through Places; the full set needs the Business Profile connector (#45,
 * gated on #44). This path exists so a new project has something to query
 * in the first minute.
 *
 * This should move to packages/google once that package exists (#46 creates
 * it); it lives here for now so the two PRs do not collide.
 */
import { type ReviewInput, reviewInputSchema } from "@proofql/core";
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
 *   the Business Profile connector (#45), which uses the same resource
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

/** KV key of a cached place fetch; the search key needs a hash (places.server.ts). */
export function placeCacheKey(placeId: string): string {
  return `places:p:${placeId}`;
}

export const PLACES_SEARCH_CACHE_PREFIX = "places:q:";

/** Search terms shorter than this are refused rather than sent to Google. */
export const PLACES_QUERY_MIN_LENGTH = 3;
export const PLACES_QUERY_MAX_LENGTH = 200;

export const placesSearchQuerySchema = z
  .string()
  .trim()
  .min(
    PLACES_QUERY_MIN_LENGTH,
    "Type at least three characters of the business name.",
  )
  .max(
    PLACES_QUERY_MAX_LENGTH,
    "Keep the search under two hundred characters.",
  );

// --- Paths -------------------------------------------------------------------

/** The resource route both the onboarding card and the Import tab post to. */
export function placesActionPath(slug: string): string {
  return `/app/projects/${slug}/places`;
}
