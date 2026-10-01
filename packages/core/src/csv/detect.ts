/**
 * Column auto-detection (issue #38): propose a `CsvMapping` for an upload
 * from its headers and a sample of rows. Profiles first (a vendor export
 * is recognized by its signature headers), header-name heuristics second,
 * and sample values last — a column whose cells all parse as dates is the
 * date column even if its header is `col_7`.
 */

import {
  CSV_TARGET_FIELDS,
  type CsvMapping,
  type CsvTargetField,
} from "./mapping.js";
import {
  CSV_PROFILES,
  type CsvProfile,
  type CsvProfileId,
  csvProfile,
  normalizeHeaderKey,
} from "./profiles.js";
import { parseDate, parseRating } from "./values.js";

export interface DetectedMapping {
  profile: CsvProfileId;
  mapping: CsvMapping;
  /** 0–1: how much of the profile signature matched (1 for a forced profile). */
  confidence: number;
}

export interface DetectOptions {
  /** Skip profile matching and apply this profile's columns. */
  profile?: CsvProfileId;
}

/**
 * Header words that name each field, most specific first. Matched against
 * the normalized header: exact match beats "header contains the phrase".
 */
const FIELD_HINTS: Record<CsvTargetField, readonly string[]> = {
  text: [
    "review text",
    "review content",
    "review body",
    "comment",
    "comments",
    "review",
    "text",
    "body",
    "content",
    "feedback",
    "message",
    "description",
    "testimonial",
  ],
  rating: [
    "star rating",
    "review stars",
    "rating",
    "stars",
    "score",
    "starrating",
  ],
  author_name: [
    "reviewer name",
    "author name",
    "customer name",
    "display name",
    "reviewer",
    "author",
    "customer",
    "name",
    "user",
    "username",
  ],
  occurred_at: [
    "review date",
    "date posted",
    "created at",
    "create time",
    "createtime",
    "published at",
    "posted",
    "date",
    "created",
    "timestamp",
    "time",
  ],
  external_id: ["review id", "external id", "reviewid", "id"],
  source: ["source", "platform", "site", "channel", "network"],
  url: ["review url", "review link", "permalink", "url", "link"],
  author_avatar_url: [
    "reviewer photo",
    "profile photo",
    "avatar url",
    "avatar",
    "photo",
    "profile image",
  ],
  language: ["language", "lang", "locale"],
};

const SAMPLE_THRESHOLD = 0.6;

export function detectMapping(
  headers: readonly string[],
  sampleRows: readonly (readonly string[])[],
  options: DetectOptions = {},
): DetectedMapping {
  const keys = headers.map(normalizeHeaderKey);

  let profile: CsvProfile;
  let confidence: number;
  if (options.profile) {
    profile = csvProfile(options.profile);
    confidence = 1;
  } else {
    const best = bestProfile(keys);
    profile = best.profile;
    confidence = best.score;
  }

  const fields: Partial<Record<CsvTargetField, string>> = {};
  const metadata: Record<string, string> = {};
  const claimed = new Set<number>();

  // 1. Profile columns.
  keys.forEach((key, index) => {
    const header = headers[index] as string;
    const field = profile.fields[key];
    if (field && fields[field] === undefined) {
      fields[field] = header;
      claimed.add(index);
      return;
    }
    const metaKey = profile.metadata[key];
    if (metaKey && !Object.values(metadata).includes(metaKey)) {
      metadata[header] = metaKey;
      claimed.add(index);
    }
  });

  // 2. Header heuristics for whatever the profile left open.
  for (const field of CSV_TARGET_FIELDS) {
    if (fields[field] !== undefined) continue;
    const index = byHeaderHint(field, keys, claimed);
    if (index === -1) continue;
    if (!samplesAgree(field, column(sampleRows, index))) continue;
    fields[field] = headers[index] as string;
    claimed.add(index);
  }

  // 3. Sample values for rating and date when no header gave them away.
  if (fields.occurred_at === undefined) {
    const index = byValues(
      keys,
      claimed,
      sampleRows,
      (v) => parseDate(v) !== null,
    );
    if (index !== -1) {
      fields.occurred_at = headers[index] as string;
      claimed.add(index);
    }
  }
  if (fields.rating === undefined) {
    const index = byValues(
      keys,
      claimed,
      sampleRows,
      (v) => parseRating(v) !== null,
    );
    if (index !== -1) {
      fields.rating = headers[index] as string;
      claimed.add(index);
    }
  }
  if (fields.text === undefined) {
    // The longest free-text column is the review.
    const index = longestText(keys, claimed, sampleRows);
    if (index !== -1) {
      fields.text = headers[index] as string;
      claimed.add(index);
    }
  }

  return { profile: profile.id, mapping: { fields, metadata }, confidence };
}

function bestProfile(keys: readonly string[]): {
  profile: CsvProfile;
  score: number;
} {
  const present = new Set(keys);
  let best: { profile: CsvProfile; score: number } = {
    profile: csvProfile("generic"),
    score: 0,
  };
  for (const profile of CSV_PROFILES) {
    if (profile.signature.length === 0) continue;
    const hits = profile.signature.filter((h) => present.has(h)).length;
    const score = hits / profile.signature.length;
    // A real match needs most of the signature, not one shared word.
    if (hits >= 3 && score >= 0.6 && score > best.score) {
      best = { profile, score };
    }
  }
  return best;
}

function byHeaderHint(
  field: CsvTargetField,
  keys: readonly string[],
  claimed: ReadonlySet<number>,
): number {
  const hints = FIELD_HINTS[field];
  // Exact matches, in hint priority order.
  for (const hint of hints) {
    const index = keys.findIndex((k, i) => !claimed.has(i) && k === hint);
    if (index !== -1) return index;
  }
  // Then a header that contains the hint as a whole word ("Review Text (en)").
  for (const hint of hints) {
    const re = new RegExp(`(^| )${hint}( |$)`);
    const index = keys.findIndex((k, i) => !claimed.has(i) && re.test(k));
    if (index !== -1) return index;
  }
  return -1;
}

/** For typed fields, the header is only trusted if the cells look right. */
function samplesAgree(field: CsvTargetField, values: string[]): boolean {
  const filled = values.filter((v) => v.trim() !== "");
  if (filled.length === 0) return true;
  if (field === "rating")
    return ratio(filled, (v) => parseRating(v) !== null) >= SAMPLE_THRESHOLD;
  if (field === "occurred_at")
    return ratio(filled, (v) => parseDate(v) !== null) >= SAMPLE_THRESHOLD;
  if (field === "url" || field === "author_avatar_url") {
    return (
      ratio(filled, (v) => /^https?:\/\//i.test(v.trim())) >= SAMPLE_THRESHOLD
    );
  }
  return true;
}

function byValues(
  keys: readonly string[],
  claimed: ReadonlySet<number>,
  sampleRows: readonly (readonly string[])[],
  test: (value: string) => boolean,
): number {
  for (let i = 0; i < keys.length; i++) {
    if (claimed.has(i)) continue;
    const filled = column(sampleRows, i).filter((v) => v.trim() !== "");
    if (filled.length === 0) continue;
    if (ratio(filled, test) >= 0.9) return i;
  }
  return -1;
}

function longestText(
  keys: readonly string[],
  claimed: ReadonlySet<number>,
  sampleRows: readonly (readonly string[])[],
): number {
  let best = -1;
  let bestLength = 0;
  for (let i = 0; i < keys.length; i++) {
    if (claimed.has(i)) continue;
    const values = column(sampleRows, i).filter((v) => v.trim() !== "");
    if (values.length === 0) continue;
    const avg = values.reduce((sum, v) => sum + v.length, 0) / values.length;
    // Prose has spaces; ids and URLs do not.
    const wordy = ratio(values, (v) => v.trim().includes(" "));
    if (avg > bestLength && avg >= 20 && wordy >= 0.5) {
      best = i;
      bestLength = avg;
    }
  }
  return best;
}

function column(rows: readonly (readonly string[])[], index: number): string[] {
  return rows.map((row) => row[index] ?? "");
}

function ratio(
  values: readonly string[],
  test: (value: string) => boolean,
): number {
  if (values.length === 0) return 0;
  return values.filter(test).length / values.length;
}
