/**
 * The normalized review shape every source produces (scope.md §3 "Ingest").
 *
 * `POST /v1/reviews` (#21) validates request bodies with these schemas, and
 * the dashboard CSV upload (#38) maps columns into the same shape, so a
 * review is a review regardless of where it came from. Field names are
 * snake_case because this is the wire format.
 *
 * Pure zod, no I/O: unit-testable without a database.
 */

import { z } from "zod";

/**
 * Known review sources. `custom` is the escape hatch for anything not
 * listed; add a value here (and a migration for the enum, if one exists)
 * when a source gets first-class support.
 */
export const REVIEW_SOURCES = [
  "google",
  "yelp",
  "facebook",
  "trustpilot",
  "custom",
] as const;

export type ReviewSource = (typeof REVIEW_SOURCES)[number];

/** `POST /v1/reviews` accepts at most this many reviews per request. */
export const REVIEW_BATCH_MAX = 100;

/**
 * Size caps. None is a product limit; they exist so a single malformed or
 * hostile request cannot push megabytes into Postgres and the embedding
 * queue. Real reviews are nowhere near them.
 */
const EXTERNAL_ID_MAX = 512;
const TEXT_MAX = 20_000;
const AUTHOR_NAME_MAX = 256;
const LANGUAGE_MAX = 35; // BCP 47 tags are at most 35 characters in practice.
const METADATA_KEY_MAX = 64;
const METADATA_VALUE_MAX = 512;
const METADATA_ENTRIES_MAX = 32;

/**
 * Flat string-to-string map the customer can filter on at query time
 * (`"metadata.location": "north"`). Flat by construction: nested objects,
 * arrays, numbers, and booleans are rejected rather than coerced.
 */
const metadataSchema = z
  .record(
    z.string().min(1).max(METADATA_KEY_MAX),
    z.string().max(METADATA_VALUE_MAX),
  )
  .refine((m) => Object.keys(m).length <= METADATA_ENTRIES_MAX, {
    message: `metadata may have at most ${METADATA_ENTRIES_MAX} entries`,
  });

/**
 * One review as the push API accepts it.
 *
 * - Unknown keys are rejected (strict object) so a typo surfaces as a 400
 *   with a field name instead of silently dropping data.
 * - `rating`, `author_avatar_url`, and `url` may be `null` or omitted; both
 *   normalize to `null` in the parsed output.
 * - `text` and `author_name` are trimmed and must be non-empty afterwards.
 * - `occurred_at` must be an ISO 8601 datetime with a `Z` or numeric offset;
 *   a bare date is not enough to order reviews reliably.
 */
export const reviewInputSchema = z.strictObject({
  external_id: z.string().trim().min(1).max(EXTERNAL_ID_MAX),
  source: z.enum(REVIEW_SOURCES),
  rating: z.int().min(1).max(5).nullable().default(null),
  text: z.string().trim().min(1).max(TEXT_MAX),
  author_name: z.string().trim().min(1).max(AUTHOR_NAME_MAX),
  author_avatar_url: z.url().nullable().default(null),
  occurred_at: z.iso.datetime({ offset: true }),
  url: z.url().nullable().default(null),
  language: z.string().trim().min(2).max(LANGUAGE_MAX).optional(),
  metadata: metadataSchema.optional(),
});

/** A validated review, after defaults and trimming have been applied. */
export type ReviewInput = z.output<typeof reviewInputSchema>;

/** An array body: 1 to `REVIEW_BATCH_MAX` reviews. */
export const reviewBatchSchema = z
  .array(reviewInputSchema)
  .min(1)
  .max(REVIEW_BATCH_MAX);

/**
 * The full `POST /v1/reviews` body: a single review or an array of them,
 * normalized to an array so the route has one code path.
 */
export const reviewIngestBodySchema = z.union([
  reviewBatchSchema,
  reviewInputSchema.transform((review): ReviewInput[] => [review]),
]);
