/**
 * Row → `ReviewInput` (issue #38). One function, used twice: the mapping
 * step runs it in the browser over the preview rows so the user sees the
 * same verdict the import will reach, and the import runs it on Workers
 * over every row. Nothing here may depend on where it runs.
 *
 * Errors are per field and phrased for the person fixing the file: what is
 * wrong and what to do about it. Warnings never fail a row.
 */

import { z } from "zod";

import {
  REVIEW_SOURCES,
  type ReviewInput,
  type ReviewSource,
  reviewInputSchema,
} from "../review.js";
import type { CsvMapping, CsvTargetField } from "./mapping.js";
import { parseDate, parseRating, sha1Hex } from "./values.js";

export const csvDefaultsSchema = z.object({
  /** `source` for rows whose source column is unmapped or empty. */
  source: z.enum(REVIEW_SOURCES),
});

export type CsvDefaults = z.output<typeof csvDefaultsSchema>;

export interface CsvRowError {
  field: CsvTargetField | "row";
  /** The upload column the value came from; null for a missing mapping. */
  column: string | null;
  /** The offending cell, trimmed; "" when empty. */
  value: string;
  message: string;
}

export type CsvRowResult =
  | { ok: true; review: ReviewInput; warnings: string[] }
  | { ok: false; errors: CsvRowError[] };

/** Author shown when the export has no name for a review. */
export const ANONYMOUS_AUTHOR = "Anonymous";

/** The fallback `external_id` hashes `source|author|date|text[0..64)`. */
export const EXTERNAL_ID_TEXT_PREFIX = 64;

export function normalizeRow(
  row: readonly string[],
  headers: readonly string[],
  mapping: CsvMapping,
  defaults: CsvDefaults,
): CsvRowResult {
  const errors: CsvRowError[] = [];
  const warnings: string[] = [];
  const cell = (
    field: CsvTargetField,
  ): { column: string | null; value: string } => {
    const column = mapping.fields[field];
    if (column === undefined) return { column: null, value: "" };
    const index = headers.indexOf(column);
    return { column, value: index === -1 ? "" : (row[index] ?? "").trim() };
  };

  const text = cell("text");
  if (text.column === null) {
    errors.push({
      field: "text",
      column: null,
      value: "",
      message: "No column is mapped to the review text. Pick one above.",
    });
  } else if (text.value === "") {
    errors.push({
      field: "text",
      column: text.column,
      value: "",
      message: `"${text.column}" is empty. A review needs text; fill it in or remove the row.`,
    });
  }

  const ratingCell = cell("rating");
  let rating: number | null = null;
  if (ratingCell.value !== "") {
    rating = parseRating(ratingCell.value);
    if (rating === null) {
      errors.push({
        field: "rating",
        column: ratingCell.column,
        value: ratingCell.value,
        message: `"${ratingCell.value}" is not a rating we can read (expected 1–5, "4/5", "★★★★☆" or "4 stars").`,
      });
    }
  }

  const dateCell = cell("occurred_at");
  let occurredAt: string | null = null;
  if (dateCell.column === null) {
    errors.push({
      field: "occurred_at",
      column: null,
      value: "",
      message: "No column is mapped to the date. Pick one above.",
    });
  } else if (dateCell.value === "") {
    errors.push({
      field: "occurred_at",
      column: dateCell.column,
      value: "",
      message: `"${dateCell.column}" is empty. Every review needs a date.`,
    });
  } else {
    occurredAt = parseDate(dateCell.value);
    if (occurredAt === null) {
      errors.push({
        field: "occurred_at",
        column: dateCell.column,
        value: dateCell.value,
        message: `"${dateCell.value}" is not a date we can read (ISO 8601, m/d/yyyy, "Jan 5, 2026" or a Unix timestamp).`,
      });
    }
  }

  const authorCell = cell("author_name");
  const author = authorCell.value === "" ? ANONYMOUS_AUTHOR : authorCell.value;
  if (authorCell.value === "" && authorCell.column !== null) {
    warnings.push(
      `"${authorCell.column}" is empty; the author is stored as ${ANONYMOUS_AUTHOR}.`,
    );
  }

  const sourceCell = cell("source");
  const source =
    sourceCell.value === ""
      ? defaults.source
      : normalizeSource(sourceCell.value);

  const url = optionalUrl(cell("url"), warnings);
  const avatar = optionalUrl(cell("author_avatar_url"), warnings);

  const languageCell = cell("language");
  const language =
    languageCell.value.length >= 2 ? languageCell.value : undefined;

  const metadata: Record<string, string> = {};
  for (const [column, key] of Object.entries(mapping.metadata)) {
    const index = headers.indexOf(column);
    const value = index === -1 ? "" : (row[index] ?? "").trim();
    if (value !== "") metadata[key] = value.slice(0, 512);
  }

  if (errors.length > 0) return { ok: false, errors };

  const idCell = cell("external_id");
  const externalId =
    idCell.value !== ""
      ? idCell.value
      : sha1Hex(
          [
            source,
            author,
            occurredAt,
            text.value.slice(0, EXTERNAL_ID_TEXT_PREFIX),
          ].join("|"),
        );

  const candidate = {
    external_id: externalId,
    source,
    rating,
    text: text.value,
    author_name: author,
    author_avatar_url: avatar,
    occurred_at: occurredAt as string,
    url,
    ...(language !== undefined ? { language } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
  const parsed = reviewInputSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "row");
      const target = (
        field in mapping.fields || field === "metadata" ? field : "row"
      ) as CsvTargetField | "row";
      errors.push({
        field: target,
        column:
          target === "row"
            ? null
            : (mapping.fields[target as CsvTargetField] ?? null),
        value: "",
        message: `${field}: ${issue.message}`,
      });
    }
    return { ok: false, errors };
  }
  return { ok: true, review: parsed.data, warnings };
}

function optionalUrl(
  cell: { column: string | null; value: string },
  warnings: string[],
): string | null {
  if (cell.value === "") return null;
  if (z.url().safeParse(cell.value).success) return cell.value;
  if (cell.column)
    warnings.push(`"${cell.column}" is not a URL and was left out.`);
  return null;
}

/**
 * Map an export's source label onto our known set: "Google Maps" →
 * `google`, "FB" → `facebook`; anything unrecognized is `custom`.
 */
export function normalizeSource(raw: string): ReviewSource {
  const value = raw.trim().toLowerCase();
  if (value.includes("google")) return "google";
  if (value.includes("yelp")) return "yelp";
  if (value.includes("facebook") || value === "fb" || value.includes("meta"))
    return "facebook";
  if (value.includes("trustpilot")) return "trustpilot";
  return "custom";
}

export interface CsvValidationSummary {
  total: number;
  valid: number;
  invalid: number;
  /** Row numbers are 1-based data rows, header excluded. */
  errors: { rowNumber: number; errors: CsvRowError[] }[];
  warnings: { rowNumber: number; warnings: string[] }[];
}

/** Run `normalizeRow` over preview rows and tally; `firstRowNumber` keeps the file's numbering. */
export function validateRows(
  rows: readonly (readonly string[])[],
  headers: readonly string[],
  mapping: CsvMapping,
  defaults: CsvDefaults,
  { firstRowNumber = 1 }: { firstRowNumber?: number } = {},
): CsvValidationSummary {
  const summary: CsvValidationSummary = {
    total: rows.length,
    valid: 0,
    invalid: 0,
    errors: [],
    warnings: [],
  };
  rows.forEach((row, i) => {
    const rowNumber = firstRowNumber + i;
    const result = normalizeRow(row, headers, mapping, defaults);
    if (result.ok) {
      summary.valid += 1;
      if (result.warnings.length > 0) {
        summary.warnings.push({ rowNumber, warnings: result.warnings });
      }
    } else {
      summary.invalid += 1;
      summary.errors.push({ rowNumber, errors: result.errors });
    }
  });
  return summary;
}
