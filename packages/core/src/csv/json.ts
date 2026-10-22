/**
 * JSON uploads flattened to the same `{ headers, rows }` table a CSV
 * parses to, so one mapping UI and one normalizer serve both (issue #38).
 *
 * Accepted shapes:
 *   - an array of objects (`[{...}, {...}]`);
 *   - an object with exactly one array-valued key holding objects — Google
 *     A Takeout `reviews.json` page is `{ "reviews": [...] }` — or a `reviews`
 *     / `data` / `items` / `results` key when there are several.
 *
 * Nested objects flatten to dotted headers (`reviewer.displayName`);
 * arrays and scalars that are not strings serialize with `JSON.stringify`
 * minus the quotes, so `starRating: 5` becomes `"5"` and a `tags` array
 * stays inspectable. Header order is first-appearance across all records.
 */

import type { CsvTable } from "./parse.js";

const COLLECTION_KEYS = ["reviews", "data", "items", "results", "records"];

export class JsonShapeError extends Error {
  override readonly name = "JsonShapeError";
}

/** Parse JSON text and flatten it; throws `JsonShapeError` when it is not a list of records. */
export function parseJsonTable(text: string): CsvTable {
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new JsonShapeError("The file is not valid JSON.");
  }
  return flattenJsonToTable(value);
}

export function flattenJsonToTable(value: unknown): CsvTable {
  const records = findRecords(value);
  const headers: string[] = [];
  const seen = new Set<string>();
  const flat: Record<string, string>[] = records.map((record) => {
    const row: Record<string, string> = {};
    flattenInto(record, "", row);
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
    return row;
  });
  return {
    headers,
    rows: flat.map((row) => headers.map((h) => row[h] ?? "")),
  };
}

function findRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return assertObjects(value);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const arrays = Object.entries(object).filter(([, v]) => Array.isArray(v));
    if (arrays.length === 1) return assertObjects(arrays[0]?.[1] as unknown[]);
    for (const key of COLLECTION_KEYS) {
      const candidate = object[key];
      if (Array.isArray(candidate)) return assertObjects(candidate);
    }
  }
  throw new JsonShapeError(
    "Expected a JSON array of review objects, or an object with a single array of them (like a Google Takeout reviews.json page).",
  );
}

function assertObjects(items: unknown[]): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new JsonShapeError(
        "Every item in the JSON array must be an object with the review's fields.",
      );
    }
    records.push(item as Record<string, unknown>);
  }
  return records;
}

function flattenInto(
  value: unknown,
  prefix: string,
  out: Record<string, string>,
): void {
  if (value === null || value === undefined) {
    if (prefix) out[prefix] = "";
    return;
  }
  if (Array.isArray(value)) {
    out[prefix] = JSON.stringify(value);
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as object)) {
      flattenInto(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  out[prefix] = typeof value === "string" ? value : String(value);
}
