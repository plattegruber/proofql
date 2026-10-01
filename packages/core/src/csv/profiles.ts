/**
 * Built-in column profiles for the exports customers actually have (issue
 * #38). A profile is a set of signature headers and the field each one
 * feeds; `detectMapping` picks the profile whose signature the upload
 * matches best and falls back to header heuristics otherwise.
 *
 * The header lists are the vendors' export formats as observed; they are
 * matched case-insensitively after collapsing punctuation and whitespace,
 * so `Review_Date`, `review date` and `Review Date` are the same column.
 */

import type { ReviewSource } from "../review.js";
import type { CsvTargetField } from "./mapping.js";

export const CSV_PROFILE_IDS = [
  "google-takeout",
  "google-business-profile",
  "yelp",
  "trustpilot",
  "birdeye",
  "podium",
  "generic",
] as const;

export type CsvProfileId = (typeof CSV_PROFILE_IDS)[number];

export interface CsvProfile {
  id: CsvProfileId;
  label: string;
  /** The `source` every row gets unless a column maps to `source`. */
  source: ReviewSource;
  /** Normalized header → target field. */
  fields: Record<string, CsvTargetField>;
  /** Normalized header → metadata key, for columns worth keeping. */
  metadata: Record<string, string>;
  /** Normalized headers that identify the format (a subset of the keys above). */
  signature: readonly string[];
  /** Accepted file kinds; Takeout is JSON. */
  kinds: readonly ("csv" | "json")[];
}

/** `"Review_Date "` → `"review date"`; the key form every lookup uses. */
export function normalizeHeaderKey(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}

export const CSV_PROFILES: readonly CsvProfile[] = [
  {
    id: "google-takeout",
    label: "Google Takeout (Reviews.json)",
    source: "google",
    fields: {
      name: "external_id",
      "reviewer.displayname": "author_name",
      "reviewer.profilephotourl": "author_avatar_url",
      starrating: "rating",
      comment: "text",
      createtime: "occurred_at",
    },
    metadata: {},
    signature: ["reviewer.displayname", "starrating", "comment", "createtime"],
    kinds: ["json", "csv"],
  },
  {
    id: "google-business-profile",
    label: "Google Business Profile export",
    source: "google",
    fields: {
      "review id": "external_id",
      "reviewer name": "author_name",
      "reviewer photo": "author_avatar_url",
      "star rating": "rating",
      "review text": "text",
      "review date": "occurred_at",
      "review url": "url",
    },
    metadata: { "location name": "location" },
    signature: [
      "review id",
      "reviewer name",
      "star rating",
      "review text",
      "review date",
    ],
    kinds: ["csv"],
  },
  {
    id: "yelp",
    label: "Yelp for Business",
    source: "yelp",
    fields: {
      "review id": "external_id",
      reviewer: "author_name",
      rating: "rating",
      review: "text",
      "review date": "occurred_at",
      "review url": "url",
    },
    metadata: { "business name": "business" },
    signature: ["reviewer", "rating", "review", "review date", "review url"],
    kinds: ["csv"],
  },
  {
    id: "trustpilot",
    label: "Trustpilot",
    source: "trustpilot",
    fields: {
      "review id": "external_id",
      "reviewer name": "author_name",
      "review stars": "rating",
      "review content": "text",
      "review date": "occurred_at",
      "review link": "url",
      language: "language",
    },
    metadata: { "review title": "title", "reviewer country": "country" },
    signature: [
      "review stars",
      "review content",
      "review title",
      "reviewer name",
    ],
    kinds: ["csv"],
  },
  {
    id: "birdeye",
    label: "Birdeye",
    source: "custom",
    fields: {
      "review id": "external_id",
      source: "source",
      "reviewer name": "author_name",
      rating: "rating",
      review: "text",
      "review date": "occurred_at",
      "review url": "url",
    },
    metadata: { location: "location", "business name": "business" },
    signature: [
      "review id",
      "source",
      "reviewer name",
      "rating",
      "review",
      "review date",
      "location",
    ],
    kinds: ["csv"],
  },
  {
    id: "podium",
    label: "Podium",
    source: "custom",
    fields: {
      "review id": "external_id",
      site: "source",
      "customer name": "author_name",
      stars: "rating",
      comment: "text",
      "date posted": "occurred_at",
      link: "url",
    },
    metadata: { "location name": "location" },
    signature: ["site", "customer name", "stars", "comment", "date posted"],
    kinds: ["csv"],
  },
  {
    id: "generic",
    label: "Generic CSV (detect columns)",
    source: "custom",
    fields: {},
    metadata: {},
    signature: [],
    kinds: ["csv", "json"],
  },
];

export function csvProfile(id: CsvProfileId): CsvProfile {
  const profile = CSV_PROFILES.find((p) => p.id === id);
  if (!profile) throw new Error(`unknown csv profile ${id}`);
  return profile;
}
