/**
 * Google Takeout's "Google Business Profile" export → reviews.
 *
 * A business owner or manager can export their own profile's reviews at
 * takeout.google.com (Deselect all → Google Business Profile → Next step →
 * Create export). Google publishes no schema for the archive; the layout
 * and fields below are what real exports and the public parsers agree on
 * (docs/site/src/content/docs/imports.md "Google Takeout"):
 *
 *   Takeout/Google Business Profile/
 *     businessPersonalization.json
 *     account-<n>/data.json
 *     account-<n>/location-<n>/additionalData.json   LISTING_NAME attribute
 *     account-<n>/location-<n>/reviews.json          { "reviews": [...] }
 *     account-<n>/location-<n>/reviews-<token>.json  more pages, ~20 each
 *
 * Each review is a cut-down copy of the Business Profile API v4 Review:
 * `name` (`accounts/<a>/locations/<l>/reviews/<r>`), `reviewer.displayName`,
 * `starRating` (`ONE`..`FIVE`), `comment` (absent for a star-only review),
 * `createTime`, `updateTime`, `reviewReply.{comment,updateTime}`. There is
 * no reviewer photo and no link. Everything is read defensively: unknown
 * keys are ignored, optional ones may be missing.
 *
 * The dashboard extracts the archive in the browser and sends only the
 * reviews (`TakeoutPayload`), so photos never leave the user's machine;
 * the server validates the payload again with the same schemas. Pure, no
 * I/O: the same functions run in both places and in the tests.
 *
 * Identity. A review's `external_id` is its full resource name, the same id
 * the Business Profile connector stores, so the two paths land on one row.
 * The account part of a name is not stable (one location can appear under
 * several `account-*` folders, and under another account in the API), so
 * deduplication matches on the `locations/<l>/reviews/<r>` suffix
 * ({@link reviewSuffix}).
 */

import { z } from "zod";

import { type ReviewInput, reviewInputSchema } from "../review.js";

/**
 * The R2 artifact suffix that marks an `ingest_runs` row (kind `csv`, an
 * uploaded export) as a Google Takeout import. The dashboard writes it;
 * the Places refresh reads it to leave a superseded bootstrap alone.
 */
export const TAKEOUT_ARTIFACT_SUFFIX = ".takeout.json";

/** A `reviews.json` / `reviews-<token>.json` page inside the export. */
export const TAKEOUT_REVIEWS_FILE =
  /(?:^|\/)Google Business Profile\/account-([^/]+)\/location-([^/]+)\/reviews(?:-[^/]+)?\.json$/;

/** A location's `additionalData.json` (its listing name). */
export const TAKEOUT_LOCATION_DATA_FILE =
  /(?:^|\/)Google Business Profile\/account-([^/]+)\/location-([^/]+)\/additionalData\.json$/;

/**
 * Maps' `Reviews.json`: the reviews the signed-in person *wrote* about
 * other places, not the reviews of their business. A common mix-up.
 */
export const MAPS_REVIEWS_FILE =
  /(?:^|\/)Maps \(your places\)\/Reviews\.json$/i;

/** Whether an archive entry is worth reading (and decompressing) at all. */
export function isTakeoutEntryOfInterest(path: string): boolean {
  return (
    TAKEOUT_REVIEWS_FILE.test(path) ||
    TAKEOUT_LOCATION_DATA_FILE.test(path) ||
    MAPS_REVIEWS_FILE.test(path)
  );
}

/** `accounts/1/locations/2/reviews/abc` → `locations/2/reviews/abc`. */
const SUFFIX = /(?:^|\/)(locations\/[^/]+\/reviews\/[^/]+)$/;

/** The account-independent part of a review's resource name, or null. */
export function reviewSuffix(name: string): string | null {
  return SUFFIX.exec(name)?.[1] ?? null;
}

/** The location id inside a review's resource name, or null. */
export function locationIdOf(name: string): string | null {
  return /(?:^|\/)locations\/([^/]+)\/reviews\/[^/]+$/.exec(name)?.[1] ?? null;
}

const STAR_RATINGS: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

/** `FOUR` → 4; anything else (including `STAR_RATING_UNSPECIFIED`) → null. */
export function ratingFromStars(
  value: string | null | undefined,
): number | null {
  return value ? (STAR_RATINGS[value] ?? null) : null;
}

/**
 * A review as the export holds it. Loose on purpose: Google may add keys,
 * and the parsers are told to ignore what they do not know.
 */
export const takeoutRawReviewSchema = z.looseObject({
  name: z.string().trim().min(1).max(512),
  reviewer: z
    .looseObject({ displayName: z.string().optional() })
    .optional()
    .catch(undefined),
  starRating: z.string().optional().catch(undefined),
  comment: z.string().optional().catch(undefined),
  createTime: z.string(),
  updateTime: z.string().optional().catch(undefined),
  reviewReply: z
    .looseObject({
      comment: z.string().optional(),
      updateTime: z.string().optional(),
    })
    .optional()
    .catch(undefined),
});

/**
 * The subset of a review the payload carries — exactly the keys ProofQL
 * reads, so nothing else in the export is sent to the server.
 */
export const takeoutReviewSchema = z.strictObject({
  name: z.string().trim().min(1).max(512),
  reviewer: z
    .strictObject({ displayName: z.string().max(1024).optional() })
    .optional(),
  starRating: z.string().max(32).optional(),
  comment: z.string().max(100_000).optional(),
  createTime: z.string().max(64),
  updateTime: z.string().max(64).optional(),
  reviewReply: z
    .strictObject({
      comment: z.string().max(100_000).optional(),
      updateTime: z.string().max(64).optional(),
    })
    .optional(),
});

export type TakeoutReview = z.output<typeof takeoutReviewSchema>;

/** Keep only the keys {@link takeoutReviewSchema} allows. */
export function compactReview(
  raw: z.output<typeof takeoutRawReviewSchema>,
): TakeoutReview {
  const review: TakeoutReview = { name: raw.name, createTime: raw.createTime };
  if (raw.reviewer?.displayName !== undefined) {
    review.reviewer = { displayName: raw.reviewer.displayName };
  }
  if (raw.starRating !== undefined) review.starRating = raw.starRating;
  if (raw.comment !== undefined) review.comment = raw.comment;
  if (raw.updateTime !== undefined) review.updateTime = raw.updateTime;
  if (raw.reviewReply !== undefined) {
    const reply: NonNullable<TakeoutReview["reviewReply"]> = {};
    if (raw.reviewReply.comment !== undefined)
      reply.comment = raw.reviewReply.comment;
    if (raw.reviewReply.updateTime !== undefined)
      reply.updateTime = raw.reviewReply.updateTime;
    review.reviewReply = reply;
  }
  return review;
}

/** Most locations a single import may carry. */
export const TAKEOUT_LOCATIONS_MAX = 500;

/** What the dashboard's browser code sends: the chosen locations' reviews. */
export const takeoutPayloadSchema = z.strictObject({
  format: z.literal("proofql.takeout.v1"),
  /**
   * The reviews came from whole archives (every page of every location),
   * so a stored review missing from them was deleted on Google. False for
   * loose JSON files, which may be a subset.
   */
  complete: z.boolean(),
  locations: z
    .array(
      z.strictObject({
        location_id: z.string().trim().min(1).max(128),
        title: z.string().trim().max(512).nullable(),
        reviews: z.array(takeoutReviewSchema),
      }),
    )
    .min(1)
    .max(TAKEOUT_LOCATIONS_MAX),
});

export type TakeoutPayload = z.output<typeof takeoutPayloadSchema>;

/** Thrown for a file that is not what the importer expects; the message is for the user. */
export class TakeoutShapeError extends Error {
  override readonly name = "TakeoutShapeError";
}

export const MAPS_REVIEWS_MESSAGE =
  "This is Google Maps' Reviews.json: the reviews you wrote about other places, not your business's reviews. Export Google Business Profile instead (takeout.google.com → Deselect all → Google Business Profile).";

export type TakeoutFileKind =
  | { kind: "reviews"; reviews: TakeoutReview[]; invalid: number }
  | { kind: "location-data"; title: string | null }
  | { kind: "maps-reviews" }
  | { kind: "other" };

/**
 * Read one JSON file from the export (or one the user picked on its own).
 * Recognised by content, not just by name, so a renamed `reviews.json`
 * still works and Maps' `Reviews.json` is caught however it is named.
 */
export function readTakeoutJson(text: string): TakeoutFileKind {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new TakeoutShapeError("The file is not valid JSON.");
  }
  if (!isRecord(value)) return { kind: "other" };
  if (value.type === "FeatureCollection" && Array.isArray(value.features)) {
    return { kind: "maps-reviews" };
  }
  if (Array.isArray(value.attributes)) {
    return { kind: "location-data", title: listingName(value.attributes) };
  }
  if (Array.isArray(value.reviews)) {
    const reviews: TakeoutReview[] = [];
    let invalid = 0;
    for (const item of value.reviews) {
      const parsed = takeoutRawReviewSchema.safeParse(item);
      if (parsed.success && reviewSuffix(parsed.data.name) !== null) {
        reviews.push(compactReview(parsed.data));
      } else {
        invalid += 1;
      }
    }
    if (reviews.length === 0 && invalid > 0) {
      throw new TakeoutShapeError(
        "The file has a reviews list, but none of its entries look like Google Business Profile reviews (each needs a name like accounts/…/locations/…/reviews/… and a createTime).",
      );
    }
    return { kind: "reviews", reviews, invalid };
  }
  return { kind: "other" };
}

/** The `LISTING_NAME` attribute of an `additionalData.json`, or null. */
function listingName(attributes: unknown[]): string | null {
  for (const attribute of attributes) {
    if (!isRecord(attribute)) continue;
    const id = attribute.id;
    if (!isRecord(id) || id.attributeType !== "LISTING_NAME") continue;
    const values = attribute.values;
    if (!Array.isArray(values)) continue;
    for (const v of values) {
      const text = isRecord(v)
        ? pick(v, ["datum", "listingName", "text"])
        : undefined;
      if (typeof text === "string" && text.trim() !== "") return text.trim();
    }
  }
  return null;
}

function pick(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One location found in an export, ready to show in the picker. */
export interface TakeoutLocation {
  locationId: string;
  /** The listing name from `additionalData.json`, when the export had one. */
  title: string | null;
  reviews: TakeoutReview[];
  /** Reviews with a rating and no text; imported as nothing, counted. */
  starOnly: number;
}

export interface TakeoutExport {
  locations: TakeoutLocation[];
  /** The same review seen more than once (another account folder, a repeated page). */
  duplicates: number;
  /** Entries in a reviews list that were not reviews. */
  invalid: number;
  /** A Maps `Reviews.json` was among the files (and ignored). */
  mapsReviews: boolean;
}

export interface TakeoutFile {
  /** The path inside the archive, or the file name for a loose file. */
  path: string;
  text: string;
}

/**
 * Group the export's files into locations. A review belongs to the
 * location named in its resource name (the folder is the fallback for the
 * title only). Repeats of one review — the same location under two
 * `account-*` folders — collapse to the copy with the newest `updateTime`.
 */
export function groupTakeoutFiles(
  files: readonly TakeoutFile[],
): TakeoutExport {
  const titles = new Map<string, string>();
  const byLocation = new Map<string, Map<string, TakeoutReview>>();
  let seen = 0;
  let invalid = 0;
  let mapsReviews = false;

  for (const file of files) {
    if (MAPS_REVIEWS_FILE.test(file.path)) {
      mapsReviews = true;
      continue;
    }
    const content = readTakeoutJson(file.text);
    if (content.kind === "maps-reviews") {
      mapsReviews = true;
    } else if (content.kind === "location-data") {
      const folder = TAKEOUT_LOCATION_DATA_FILE.exec(file.path)?.[2];
      if (folder && content.title) titles.set(folder, content.title);
    } else if (content.kind === "reviews") {
      invalid += content.invalid;
      for (const review of content.reviews) {
        const location = locationIdOf(review.name) as string;
        const suffix = reviewSuffix(review.name) as string;
        let reviews = byLocation.get(location);
        if (!reviews) {
          reviews = new Map();
          byLocation.set(location, reviews);
        }
        seen += 1;
        const existing = reviews.get(suffix);
        if (!existing || newer(review, existing)) reviews.set(suffix, review);
      }
    }
  }

  let kept = 0;
  const locations: TakeoutLocation[] = [];
  for (const [locationId, reviews] of byLocation) {
    const list = [...reviews.values()].sort(byCreateTime);
    kept += list.length;
    locations.push({
      locationId,
      title: titles.get(locationId) ?? null,
      reviews: list,
      starOnly: list.filter((r) => reviewText(r.comment) === "").length,
    });
  }
  locations.sort(
    (a, b) =>
      (a.title ?? "￿").localeCompare(b.title ?? "￿") ||
      a.locationId.localeCompare(b.locationId),
  );
  return { locations, duplicates: seen - kept, invalid, mapsReviews };
}

/** `updateTime` (else `createTime`) as epoch ms; NaN when unreadable. */
export function editedAt(
  review: Pick<TakeoutReview, "createTime" | "updateTime">,
): number {
  return Date.parse(review.updateTime ?? review.createTime);
}

/**
 * Whether `a` should replace `b`: edited later, or — a tie, the usual case
 * for one review under two account folders — its name sorts first, so the
 * pick never depends on the order the archive lists its files in.
 */
function newer(a: TakeoutReview, b: TakeoutReview): boolean {
  const ta = editedAt(a);
  const tb = editedAt(b);
  if (Number.isNaN(ta)) return false;
  if (Number.isNaN(tb) || ta > tb) return true;
  return ta === tb && a.name < b.name;
}

function byCreateTime(a: TakeoutReview, b: TakeoutReview): number {
  return (
    a.createTime.localeCompare(b.createTime) || a.name.localeCompare(b.name)
  );
}

/** The payload for the chosen locations (the browser side). */
export function buildTakeoutPayload(
  locations: readonly TakeoutLocation[],
  complete: boolean,
): TakeoutPayload {
  return {
    format: "proofql.takeout.v1",
    complete,
    locations: locations.map((l) => ({
      location_id: l.locationId,
      title: l.title,
      reviews: l.reviews,
    })),
  };
}

/** Google's machine translation wrapper, when the export carries one. */
const TRANSLATED = /\(Translated by Google\)/;
const ORIGINAL = /\(Original\)\s*\n([\s\S]*)$/;

/**
 * The review's own words. A translated comment arrives as
 * `"(Translated by Google) …\n\n(Original)\n…"`; ProofQL keeps the
 * original, since excerpts must be verbatim and the translation is
 * Google's, not the reviewer's.
 */
export function reviewText(comment: string | undefined): string {
  const text = (comment ?? "").trim();
  if (TRANSLATED.test(text)) {
    const original = ORIGINAL.exec(text)?.[1]?.trim();
    if (original) return original;
  }
  return text;
}

/** Metadata keys a Takeout review carries (all strings, all optional). */
export const TAKEOUT_METADATA = {
  /** The Business Profile location id; the connector uses the same key. */
  location: "location",
  /** The listing name, when the export had one; the connector's key too. */
  locationTitle: "location_title",
  /** Google's `updateTime`: decides whether a later import may overwrite. */
  updateTime: "google_update_time",
  /** The owner's public reply. Stored, never indexed or displayed. */
  ownerReply: "owner_reply",
  ownerReplyUpdatedAt: "owner_reply_updated_at",
  /** Which path wrote the row last: `takeout`. */
  importSource: "import_source",
} as const;

/**
 * Metadata keys that are stored but never displayed as review content: the
 * owner's reply belongs to the business, not the reviewer, and is not part
 * of what a site shows. (Only `text` is ever indexed, so they are never
 * searchable either.)
 */
export const UNDISPLAYED_METADATA_KEYS: readonly string[] = [
  TAKEOUT_METADATA.ownerReply,
  TAKEOUT_METADATA.ownerReplyUpdatedAt,
];

/** Metadata values are capped at 512 characters (review.ts). */
const METADATA_VALUE_MAX = 512;

/** Author shown when the export has no reviewer name. */
export const TAKEOUT_ANONYMOUS_AUTHOR = "A Google user";

export type TakeoutMapResult =
  | { ok: true; review: ReviewInput; editedAt: number }
  | { ok: false; reason: "star_only" }
  | { ok: false; reason: "invalid"; message: string };

/**
 * One export review → the normalized review shape. A review with no text
 * (star-only) is `star_only`: the schema requires text and an excerpt
 * search has nothing to show for it. The owner's reply goes into metadata
 * (truncated to the 512-character metadata limit), never into `text`.
 */
export function mapTakeoutReview(
  review: TakeoutReview,
  location: { locationId: string; title: string | null },
): TakeoutMapResult {
  const text = reviewText(review.comment);
  if (text === "") return { ok: false, reason: "star_only" };

  const createdAt = Date.parse(review.createTime);
  if (Number.isNaN(createdAt)) {
    return {
      ok: false,
      reason: "invalid",
      message: `createTime "${review.createTime.slice(0, 40)}" is not a date.`,
    };
  }
  const edited = editedAt(review);
  const metadata: Record<string, string> = {
    [TAKEOUT_METADATA.location]: location.locationId,
    [TAKEOUT_METADATA.importSource]: "takeout",
    [TAKEOUT_METADATA.updateTime]: new Date(
      Number.isNaN(edited) ? createdAt : edited,
    ).toISOString(),
  };
  if (location.title) {
    metadata[TAKEOUT_METADATA.locationTitle] = clip(location.title);
  }
  const reply = review.reviewReply?.comment?.trim();
  if (reply) {
    metadata[TAKEOUT_METADATA.ownerReply] = clip(reply);
    const replied = Date.parse(review.reviewReply?.updateTime ?? "");
    if (!Number.isNaN(replied)) {
      metadata[TAKEOUT_METADATA.ownerReplyUpdatedAt] = new Date(
        replied,
      ).toISOString();
    }
  }

  const parsed = reviewInputSchema.safeParse({
    external_id: review.name,
    source: "google",
    rating: ratingFromStars(review.starRating),
    text,
    author_name:
      review.reviewer?.displayName?.trim() || TAKEOUT_ANONYMOUS_AUTHOR,
    author_avatar_url: null,
    occurred_at: new Date(createdAt).toISOString(),
    url: null,
    metadata,
  });
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      message: parsed.error.issues
        .map((i) => `${i.path.join(".") || "review"}: ${i.message}`)
        .join("; "),
    };
  }
  return {
    ok: true,
    review: parsed.data,
    editedAt: Number.isNaN(edited) ? createdAt : edited,
  };
}

function clip(value: string): string {
  return value.length <= METADATA_VALUE_MAX
    ? value
    : `${value.slice(0, METADATA_VALUE_MAX - 1)}…`;
}

/**
 * The point in time a location's export reflects: the newest create or
 * update time among its reviews. A stored review absent from a complete
 * export is only deleted when it is older than this, so a review the
 * connector imported after the export was made is never touched.
 */
export function exportAsOf(reviews: readonly TakeoutReview[]): number | null {
  let latest: number | null = null;
  for (const review of reviews) {
    for (const t of [Date.parse(review.createTime), editedAt(review)]) {
      if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
    }
  }
  return latest;
}

export interface NormalizedTakeout {
  locations: TakeoutLocation[];
  complete: boolean;
  /** Reviews dropped as repeats of another (by suffix). */
  duplicates: number;
  /** Reviews whose name names a different location than the one they were filed under. */
  misfiled: number;
}

/**
 * The server's view of a payload: every review under the location its
 * name says, each suffix once (newest `updateTime` wins), ordered by
 * creation. Re-derives what the browser computed instead of trusting it.
 */
export function normalizeTakeoutPayload(
  payload: TakeoutPayload,
): NormalizedTakeout {
  const titles = new Map<string, string | null>();
  const byLocation = new Map<string, Map<string, TakeoutReview>>();
  let seen = 0;
  let misfiled = 0;
  for (const location of payload.locations) {
    if (
      !titles.has(location.location_id) ||
      titles.get(location.location_id) === null
    ) {
      titles.set(location.location_id, location.title);
    }
    for (const review of location.reviews) {
      const id = locationIdOf(review.name);
      const suffix = reviewSuffix(review.name);
      if (id === null || suffix === null || id !== location.location_id) {
        misfiled += 1;
        continue;
      }
      seen += 1;
      let reviews = byLocation.get(id);
      if (!reviews) {
        reviews = new Map();
        byLocation.set(id, reviews);
      }
      const existing = reviews.get(suffix);
      if (!existing || newer(review, existing)) reviews.set(suffix, review);
    }
  }
  let kept = 0;
  const locations: TakeoutLocation[] = [];
  for (const [locationId, reviews] of byLocation) {
    const list = [...reviews.values()].sort(byCreateTime);
    kept += list.length;
    locations.push({
      locationId,
      title: titles.get(locationId) ?? null,
      reviews: list,
      starOnly: list.filter((r) => reviewText(r.comment) === "").length,
    });
  }
  locations.sort((a, b) => a.locationId.localeCompare(b.locationId));
  return {
    locations,
    complete: payload.complete,
    duplicates: seen - kept,
    misfiled,
  };
}
