/**
 * v4 `Review` → `ReviewInput`, the shape `upsertReviews` stores (#46).
 *
 * Pure: no network, no database. One review in, one of three outcomes out:
 *
 * - `ok`       — a `ReviewInput` with `source: "google"`, `external_id` =
 *                the full resource name (stable across edits — exactly what
 *                the upsert keys on), `rating` from `starRating`,
 *                `occurred_at` = `createTime` (the experience happened then;
 *                an edit changes the text, not the date), `url` to the
 *                location's Google reviews when discovery gave us a place
 *                id, and `metadata.location` / `metadata.location_title` so
 *                a multi-location project can filter by branch at query
 *                time (`"metadata.location": "…"`).
 * - `star_only`— a rating with no comment. `reviewInputSchema` requires
 *                non-empty text, and an excerpt search has nothing to
 *                excerpt from an empty review, so these are skipped and
 *                counted, never stored as empty strings.
 * - `invalid`  — the payload failed the schema (unknown `starRating`,
 *                missing `name`, a non-ISO time). Counted as skipped by the
 *                poller and logged once per page with the field path.
 *
 * Anonymous reviewers (`isAnonymous`, or no display name) become
 * "Google user": the push API requires an author name, and Google's own
 * placeholder is "A Google user". `reviewReply` is parsed (tolerated) but
 * not mapped — reply publishing is out of scope for ProofQL.
 */

import { type ReviewInput, reviewInputSchema } from "@proofql/core";
import type { z } from "zod";

import {
  GBP_STAR_RATING_VALUES,
  type GbpReview,
  gbpReviewSchema,
} from "./schema.js";

export const ANONYMOUS_AUTHOR_NAME = "Google user";

/** Metadata values are capped at 512 chars by `reviewMetadataSchema`. */
const METADATA_VALUE_MAX = 512;

export interface AdapterLocation {
  /** The bare location id; becomes `metadata.location`. */
  id: string;
  title: string;
  placeId?: string | undefined;
}

export type AdaptOutcome =
  | { status: "ok"; review: ReviewInput; updateTime: string }
  | { status: "star_only"; updateTime: string }
  | { status: "invalid"; issues: { path: string; message: string }[] };

function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/** Where a reader can see the location's Google reviews, when derivable. */
export function googleReviewsUrl(placeId: string | undefined): string | null {
  if (!placeId) return null;
  return `https://search.google.com/local/reviews?placeid=${encodeURIComponent(placeId)}`;
}

function authorName(review: GbpReview): string {
  const reviewer = review.reviewer;
  if (!reviewer || reviewer.isAnonymous === true) return ANONYMOUS_AUTHOR_NAME;
  const name = reviewer.displayName?.trim();
  return name && name.length > 0 ? name : ANONYMOUS_AUTHOR_NAME;
}

function avatarUrl(review: GbpReview): string | null {
  const url = review.reviewer?.profilePhotoUrl?.trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? url
      : null;
  } catch {
    return null;
  }
}

/** Adapt one raw v4 review for one location. */
export function adaptReview(
  raw: unknown,
  location: AdapterLocation,
): AdaptOutcome {
  const parsed = gbpReviewSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "invalid", issues: issuesOf(parsed.error) };
  }
  const review = parsed.data;
  const text = review.comment?.trim() ?? "";
  if (text.length === 0) {
    return { status: "star_only", updateTime: review.updateTime };
  }

  const candidate = {
    external_id: review.name,
    source: "google" as const,
    rating: GBP_STAR_RATING_VALUES[review.starRating],
    text,
    author_name: authorName(review),
    author_avatar_url: avatarUrl(review),
    occurred_at: review.createTime,
    url: googleReviewsUrl(location.placeId),
    metadata: {
      location: location.id.slice(0, METADATA_VALUE_MAX),
      location_title: location.title.slice(0, METADATA_VALUE_MAX),
    },
  };
  const checked = reviewInputSchema.safeParse(candidate);
  if (!checked.success) {
    return { status: "invalid", issues: issuesOf(checked.error) };
  }
  return { status: "ok", review: checked.data, updateTime: review.updateTime };
}

export interface AdaptedPage {
  reviews: ReviewInput[];
  /** Newest `updateTime` among the ok and star-only reviews, if any. */
  starOnly: number;
  invalid: { path: string; message: string }[][];
}

/** Adapt a page of raw reviews; invalid ones are collected, not thrown. */
export function adaptReviews(
  raws: readonly unknown[],
  location: AdapterLocation,
): AdaptedPage {
  const out: AdaptedPage = { reviews: [], starOnly: 0, invalid: [] };
  for (const raw of raws) {
    const outcome = adaptReview(raw, location);
    if (outcome.status === "ok") out.reviews.push(outcome.review);
    else if (outcome.status === "star_only") out.starOnly += 1;
    else out.invalid.push(outcome.issues);
  }
  return out;
}
