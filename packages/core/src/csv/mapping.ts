/**
 * The column mapping the CSV import works from (issue #38): which upload
 * column feeds which field of the ingest shape (`ReviewInput`, scope §3),
 * and which extra columns ride along as `metadata.<key>`.
 */

import { z } from "zod";

/** Fields of the ingest shape a column can map to, in display order. */
export const CSV_TARGET_FIELDS = [
  "text",
  "rating",
  "author_name",
  "occurred_at",
  "external_id",
  "source",
  "url",
  "author_avatar_url",
  "language",
] as const;

export type CsvTargetField = (typeof CSV_TARGET_FIELDS)[number];

export const CSV_TARGET_FIELD_LABELS: Record<CsvTargetField, string> = {
  text: "Review text",
  rating: "Rating",
  author_name: "Author name",
  occurred_at: "Date",
  external_id: "External id",
  source: "Source",
  url: "Review URL",
  author_avatar_url: "Author avatar URL",
  language: "Language",
};

/** Fields the import cannot do without — a row missing one fails. */
export const CSV_REQUIRED_FIELDS: readonly CsvTargetField[] = [
  "text",
  "author_name",
  "occurred_at",
];

const METADATA_KEY_RE = /^[a-z0-9_]{1,64}$/;

export const csvMappingSchema = z.object({
  /** Target field → upload column header. Absent ⇒ not mapped. */
  fields: z.partialRecord(z.enum(CSV_TARGET_FIELDS), z.string().min(1)),
  /** Upload column header → metadata key (`metadata.<key>`). */
  metadata: z.record(z.string().min(1), z.string().regex(METADATA_KEY_RE)),
});

export type CsvMapping = z.output<typeof csvMappingSchema>;

/** A header turned into a metadata key: `"Location Name"` → `location_name`. */
export function metadataKeyFor(header: string): string {
  const key = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return key === "" ? "column" : key;
}

/** Columns that no field and no metadata entry claims. */
export function unmappedColumns(
  headers: readonly string[],
  mapping: CsvMapping,
): string[] {
  const used = new Set<string>([
    ...Object.values(mapping.fields),
    ...Object.keys(mapping.metadata),
  ]);
  return headers.filter((h) => !used.has(h));
}
