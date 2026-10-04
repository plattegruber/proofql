/**
 * Pure side of the query playground (#40): the form's parameters, their
 * validation, and the two things a developer copies out of it — the curl
 * for `POST /v1/query` and the one-tag snippet from scope.md §3. No I/O;
 * the search itself is in ./playground.server.ts.
 *
 * Parsing is by hand rather than a shared zod schema: the form is six
 * fields with the api's own bounds (`workers/api/src/query/request.ts`),
 * and the dashboard does not depend on zod. Values arrive as strings from
 * the query string, so this is also where "" becomes "absent".
 */
import { type Environment, parseEnvironment } from "./reviews";

/**
 * `MAX_SEARCH_LIMIT` from `@proofql/db`, restated: this module reaches the
 * browser bundle, and importing the db barrel would drag `postgres` in.
 * `playground.server.ts` asserts the two agree.
 */
export const MAX_SEARCH_LIMIT = 20;

export const PLAYGROUND_MODES = ["excerpts", "reviews"] as const;
export type PlaygroundMode = (typeof PLAYGROUND_MODES)[number];

/** The api's default page, and the playground's. */
export const DEFAULT_LIMIT = 5;
/** `q` cap from the api contract. */
export const Q_MAX_LENGTH = 500;

/** The one-tag embed's script origin (scope.md §3 "Snippet"). */
export const SNIPPET_SRC = "https://cdn.proofql.com/v1.js";

export const PLAYGROUND_FALLBACKS = ["none", "recent"] as const;
export type PlaygroundFallback = (typeof PLAYGROUND_FALLBACKS)[number];

export interface PlaygroundRequest {
  environment: Environment;
  /** Trimmed; undefined is no-query mode (the newest publishable reviews). */
  q: string | undefined;
  mode: PlaygroundMode;
  limit: number;
  /** The api's `fallback` (#86): `recent` answers an empty result with the newest reviews, labelled. */
  fallback: PlaygroundFallback;
  /** Tightens the project's `min_rating` for this query; never loosens it. */
  minRating: number | undefined;
  source: string | undefined;
  /** `occurred_at >= since`; the form's `YYYY-MM-DD` as a UTC midnight. */
  since: Date | undefined;
  /** `since` as typed, for echoing back into the form and the curl. */
  sinceRaw: string | undefined;
  metadata: Record<string, string>;
}

/** Field name → one message; the convention renders one per field. */
export type FieldErrors = Record<string, string>;

export interface ParsedPlayground {
  request: PlaygroundRequest;
  fieldErrors: FieldErrors;
}

function blankToUndefined(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Query string → request. Invalid values are reported as field errors and
 * replaced by the default, so the page always renders a usable form; the
 * loader runs the search only when `fieldErrors` is empty.
 */
export function parsePlaygroundParams(
  searchParams: URLSearchParams,
): ParsedPlayground {
  const fieldErrors: FieldErrors = {};

  const q = blankToUndefined(searchParams.get("q"));
  if (q !== undefined && q.length > Q_MAX_LENGTH) {
    fieldErrors.q = `Keep the query to ${Q_MAX_LENGTH} characters.`;
  }

  const modeRaw = searchParams.get("mode") ?? "excerpts";
  const mode: PlaygroundMode = (PLAYGROUND_MODES as readonly string[]).includes(
    modeRaw,
  )
    ? (modeRaw as PlaygroundMode)
    : "excerpts";
  if (mode !== modeRaw) fieldErrors.mode = "Choose excerpts or reviews.";

  // A checkbox: present as `fallback=recent`, absent otherwise.
  const fallbackRaw = searchParams.get("fallback") ?? "none";
  const fallback: PlaygroundFallback = (
    PLAYGROUND_FALLBACKS as readonly string[]
  ).includes(fallbackRaw)
    ? (fallbackRaw as PlaygroundFallback)
    : "none";
  if (fallback !== fallbackRaw) fieldErrors.fallback = "Choose none or recent.";

  let limit = DEFAULT_LIMIT;
  const limitRaw = blankToUndefined(searchParams.get("limit"));
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_SEARCH_LIMIT) limit = n;
    else
      fieldErrors.limit = `Limit is a whole number from 1 to ${MAX_SEARCH_LIMIT}.`;
  }

  let minRating: number | undefined;
  const minRatingRaw = blankToUndefined(searchParams.get("min_rating"));
  if (minRatingRaw !== undefined) {
    const n = Number(minRatingRaw);
    if (Number.isInteger(n) && n >= 1 && n <= 5) minRating = n;
    else
      fieldErrors.min_rating = "Minimum rating is a whole number from 1 to 5.";
  }

  const source = blankToUndefined(searchParams.get("source"));
  if (source !== undefined && source.length > 64) {
    fieldErrors.source = "Source names are at most 64 characters.";
  }

  let since: Date | undefined;
  const sinceRaw = blankToUndefined(searchParams.get("since"));
  if (sinceRaw !== undefined) {
    const parsed = parseSince(sinceRaw);
    if (parsed === null) {
      fieldErrors.since = "Use an ISO date, like 2025-01-01.";
    } else {
      since = parsed;
    }
  }

  const metadata: Record<string, string> = {};
  const keys = searchParams.getAll("mk");
  const values = searchParams.getAll("mv");
  keys.forEach((rawKey, index) => {
    const key = rawKey.trim();
    const value = (values[index] ?? "").trim();
    if (key === "" && value === "") return;
    if (key === "") {
      fieldErrors.metadata = "Every metadata value needs a key.";
      return;
    }
    if (key.length > 64 || value.length > 512) {
      fieldErrors.metadata =
        "Metadata keys are at most 64 characters and values at most 512.";
      return;
    }
    metadata[key] = value;
  });
  if (Object.keys(metadata).length > 32) {
    fieldErrors.metadata = "At most 32 metadata filters.";
  }

  return {
    request: {
      environment: parseEnvironment(searchParams.get("env")),
      q,
      mode,
      limit,
      fallback,
      minRating,
      source,
      since,
      sinceRaw,
      metadata,
    },
    fieldErrors,
  };
}

/** `YYYY-MM-DD` or a full ISO timestamp, as the api accepts (`isoDate`). */
export function parseSince(raw: string): Date | null {
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const isDateTime =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(
      raw,
    );
  if (!isDateOnly && !isDateTime) return null;
  const date = new Date(isDateOnly ? `${raw}T00:00:00Z` : raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The `POST /v1/query` body this request stands for (scope.md §3). */
export function queryBody(request: PlaygroundRequest): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  if (request.minRating !== undefined) filters.min_rating = request.minRating;
  if (request.source !== undefined) filters.source = [request.source];
  if (request.sinceRaw !== undefined) filters.since = request.sinceRaw;
  if (Object.keys(request.metadata).length > 0) {
    filters.metadata = request.metadata;
  }
  const body: Record<string, unknown> = {};
  if (request.q !== undefined) body.q = request.q;
  body.limit = request.limit;
  body.mode = request.mode;
  if (request.fallback !== "none") body.fallback = request.fallback;
  if (Object.keys(filters).length > 0) body.filters = filters;
  return body;
}

/** Placeholder secret key for the environment — plaintexts are never stored. */
export function secretKeyPlaceholder(environment: Environment): string {
  return `pq_sk_${environment}_…`;
}

export function publishableKeyPlaceholder(environment: Environment): string {
  return `pq_pk_${environment}_…`;
}

/** Single-quote a string for a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The secret-key curl for this query. The key is a placeholder: the
 * dashboard only ever holds hashes (Keys tab, #37).
 */
export function curlFor(request: PlaygroundRequest, apiUrl: string): string {
  const body = JSON.stringify(queryBody(request));
  return [
    `curl -s -X POST ${shellQuote(`${apiUrl.replace(/\/$/, "")}/v1/query`)} \\`,
    `  -H ${shellQuote(`Authorization: Bearer ${secretKeyPlaceholder(request.environment)}`)} \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d ${shellQuote(body)}`,
  ].join("\n");
}

function attr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

/** The snippet's built-in API origin (`packages/snippet/src/config.ts`). */
export const SNIPPET_DEFAULT_API = "https://api.proofql.com";

/**
 * The one-tag embed exactly as `packages/snippet/README.md` documents it:
 * `data-query` and `data-limit` on the element, the filters as their
 * attributes (`data-mode`, `data-min-rating`, `data-source`, `data-since`,
 * `data-meta-<key>`), a publishable-key placeholder on the script, and
 * `data-api` only when the api is not the snippet's default (local dev).
 */
export function snippetFor(
  request: PlaygroundRequest,
  apiUrl: string = SNIPPET_DEFAULT_API,
): string {
  const attrs: string[] = ["data-proofql"];
  if (request.q !== undefined) attrs.push(`data-query="${attr(request.q)}"`);
  attrs.push(`data-limit="${request.limit}"`);
  if (request.mode !== "excerpts") attrs.push(`data-mode="${request.mode}"`);
  if (request.fallback !== "none") {
    attrs.push(`data-fallback="${request.fallback}"`);
  }
  if (request.minRating !== undefined) {
    attrs.push(`data-min-rating="${request.minRating}"`);
  }
  if (request.source !== undefined) {
    attrs.push(`data-source="${attr(request.source)}"`);
  }
  if (request.sinceRaw !== undefined) {
    attrs.push(`data-since="${attr(request.sinceRaw)}"`);
  }
  for (const [key, value] of Object.entries(request.metadata)) {
    attrs.push(`data-meta-${attr(key)}="${attr(value)}"`);
  }
  const script: string[] = [
    `src="${SNIPPET_SRC}"`,
    `data-key="${publishableKeyPlaceholder(request.environment)}"`,
  ];
  const api = apiUrl.replace(/\/$/, "");
  if (api !== SNIPPET_DEFAULT_API) script.push(`data-api="${attr(api)}"`);
  return [
    `<div ${attrs.join(" ")}></div>`,
    `<script async ${script.join(" ")}></script>`,
  ].join("\n");
}
