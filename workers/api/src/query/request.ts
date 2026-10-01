/**
 * The `/v1/query` request shape (scope.md §3 "Query"), parsed once from
 * either a POST JSON body or GET query parameters into one validated
 * `QueryRequest`. Pure zod; unit-tested with no database.
 *
 * ```json
 * { "q": "dental implants", "limit": 5, "mode": "excerpts",
 *   "filters": { "min_rating": 4, "source": ["google"],
 *                "since": "2025-01-01", "metadata": { "location": "north" } } }
 * ```
 *
 * `filters` also accepts the scope document's flat spelling,
 * `"metadata.location": "north"`, which is folded into `metadata`.
 *
 * GET maps parameters onto the same object before validation, so both
 * verbs share one schema and one set of error messages:
 *
 * | parameter          | body field                      |
 * |--------------------|---------------------------------|
 * | `q`                | `q`                             |
 * | `limit`            | `limit`                         |
 * | `mode`             | `mode`                          |
 * | `min_rating`       | `filters.min_rating`            |
 * | `source` (repeat or comma-separated) | `filters.source` |
 * | `since`            | `filters.since`                 |
 * | `metadata.<key>`   | `filters.metadata.<key>`        |
 * | `key`              | authentication, not part of the shape (`../auth.ts`) |
 *
 * Anything else — in the body or the query string — is a 422
 * `validation_failed` naming the field, never silently ignored: a typo
 * like `limt=3` must not quietly return five results.
 */

import { MAX_SEARCH_LIMIT } from "@proofql/db";
import { z } from "zod";

import { ApiError, type ValidationIssue } from "../errors.js";

export const DEFAULT_LIMIT = 5;
export const Q_MAX_LENGTH = 500;

const SOURCE_MAX = 64;
const SOURCES_MAX = 20;
const METADATA_KEY_MAX = 64;
const METADATA_VALUE_MAX = 512;
const METADATA_ENTRIES_MAX = 32;

/** `YYYY-MM-DD` or a full ISO 8601 timestamp, as `Date`. */
const isoDate = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const isDateTime =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(
        value,
      );
    const date = new Date(isDateOnly ? `${value}T00:00:00Z` : value);
    if (!(isDateOnly || isDateTime) || Number.isNaN(date.getTime())) {
      ctx.addIssue({
        code: "custom",
        message:
          "must be an ISO 8601 date (2025-01-01) or timestamp (2025-01-01T00:00:00Z)",
      });
      return z.NEVER;
    }
    return date;
  });

const sourceList = z
  .array(z.string().trim().min(1).max(SOURCE_MAX))
  .max(SOURCES_MAX);

const metadataSchema = z
  .record(
    z.string().min(1).max(METADATA_KEY_MAX),
    z.string().max(METADATA_VALUE_MAX),
  )
  .refine((m) => Object.keys(m).length <= METADATA_ENTRIES_MAX, {
    message: `metadata may have at most ${METADATA_ENTRIES_MAX} entries`,
  });

const filtersSchema = z.strictObject({
  min_rating: z.number().int().min(1).max(5).optional(),
  // A single string is one source; the GET mapper already splits commas.
  source: z
    .union([sourceList, z.string().trim().min(1).max(SOURCE_MAX)])
    .transform((v) => (typeof v === "string" ? [v] : v))
    .optional(),
  since: isoDate.optional(),
  metadata: metadataSchema.optional(),
});

export const QUERY_MODES = ["excerpts", "reviews"] as const;
export type QueryMode = (typeof QUERY_MODES)[number];

export const queryRequestSchema = z.strictObject({
  q: z
    .string()
    .trim()
    .min(1, "must not be blank")
    .max(Q_MAX_LENGTH, `must be at most ${Q_MAX_LENGTH} characters`)
    .optional(),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_LIMIT),
  mode: z.enum(QUERY_MODES).default("excerpts"),
  filters: z.preprocess(foldMetadataKeys, filtersSchema).default({}),
});

export type QueryRequest = z.output<typeof queryRequestSchema>;
export type QueryFilters = QueryRequest["filters"];

/** `{ "metadata.location": "north" }` → `{ metadata: { location: "north" } }`. */
function foldMetadataKeys(filters: unknown): unknown {
  if (
    typeof filters !== "object" ||
    filters === null ||
    Array.isArray(filters)
  ) {
    return filters;
  }
  const out: Record<string, unknown> = {};
  let metadata: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(filters)) {
    if (key.startsWith("metadata.") && key.length > "metadata.".length) {
      metadata ??= {};
      metadata[key.slice("metadata.".length)] = value;
    } else {
      out[key] = value;
    }
  }
  if (metadata) {
    const existing = out.metadata;
    out.metadata =
      typeof existing === "object" &&
      existing !== null &&
      !Array.isArray(existing)
        ? { ...existing, ...metadata }
        : metadata;
  }
  return out;
}

/** Validate an already-decoded body (POST) or mapped params (GET). */
export function parseQueryRequest(input: unknown): QueryRequest {
  const result = queryRequestSchema.safeParse(input);
  if (result.success) return result.data;
  const details: ValidationIssue[] = result.error.issues.flatMap((issue) => {
    const base = issue.path.map(String);
    // zod reports every unknown key of one object as a single issue whose
    // path is the object; name each key so `limt` shows up as `limt`.
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        path: [...base, key].join("."),
        message: "is not a recognized field",
      }));
    }
    return [{ path: base.join(".") || "(body)", message: issue.message }];
  });
  const first = details[0];
  throw new ApiError(
    "validation_failed",
    first
      ? `Invalid request: ${first.path} ${first.message}${details.length > 1 ? ` (and ${details.length - 1} more)` : ""}.`
      : "Invalid request.",
    { details },
  );
}

/** Parameters the GET form recognizes besides `metadata.*`. */
const GET_PARAMS = new Set([
  "q",
  "limit",
  "mode",
  "min_rating",
  "source",
  "since",
]);

/** `?key=` authenticates the request (see ../auth.ts); not a query field. */
const GET_AUTH_PARAMS = new Set(["key"]);

/**
 * Map GET query parameters onto the body shape. Numbers arrive as strings
 * and are converted only when they look like integers, so `limit=abc`
 * reaches the schema as a string and fails with the schema's own message.
 * Unknown parameters are passed through under their own name so the strict
 * schema reports them.
 */
export function queryParamsToRequest(params: URLSearchParams): unknown {
  const body: Record<string, unknown> = {};
  const filters: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const [name, value] of params) {
    if (GET_AUTH_PARAMS.has(name)) continue;
    if (name.startsWith("metadata.")) {
      const metadata = (filters.metadata ?? {}) as Record<string, unknown>;
      metadata[name.slice("metadata.".length)] = value;
      filters.metadata = metadata;
      continue;
    }
    if (!GET_PARAMS.has(name)) {
      body[name] = value; // unknown → the strict schema names it
      continue;
    }
    if (name === "source") {
      const list = (filters.source ?? []) as unknown[];
      list.push(
        ...value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      filters.source = list;
      continue;
    }
    if (seen.has(name)) {
      throw new ApiError(
        "validation_failed",
        `Invalid request: ${name} was given more than once.`,
        { details: [{ path: name, message: "was given more than once" }] },
      );
    }
    seen.add(name);
    if (name === "limit") body.limit = intOrString(value);
    else if (name === "min_rating") filters.min_rating = intOrString(value);
    else if (name === "since") filters.since = value;
    else body[name] = value;
  }

  if (Object.keys(filters).length > 0) body.filters = filters;
  return body;
}

function intOrString(value: string): number | string {
  return /^-?\d+$/.test(value.trim()) ? Number(value) : value;
}
