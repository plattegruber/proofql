/**
 * Pure helpers for the review browser (#39): list parameters, the keyset
 * cursor, and the judgments the table renders (status, sentiment, excerpt).
 * No I/O, so the loader, the components, and the unit tests share them;
 * the Postgres side lives in ./reviews.server.ts.
 */
import type { schema } from "@proofql/db";

export type Environment = (typeof schema.reviews.$inferSelect)["environment"];
export type Sentiment = (typeof schema.reviews.$inferSelect)["sentiment"];
export type SentimentSource =
  (typeof schema.reviews.$inferSelect)["sentimentSource"];

/** Rows per page, keyset-paginated like `GET /v1/reviews`. */
export const PAGE_SIZE = 25;

/**
 * The pipeline's re-enqueue sweep (#72) gives up after five attempts; a
 * review still unindexed at that point is stuck, not pending.
 */
export const STUCK_INDEX_ATTEMPTS = 5;

export type ReviewStatus = "indexing" | "indexed" | "stuck";

export function reviewStatus(row: {
  indexedAt: Date | string | null;
  indexAttempts: number;
}): ReviewStatus {
  if (row.indexedAt !== null) return "indexed";
  return row.indexAttempts >= STUCK_INDEX_ATTEMPTS ? "stuck" : "indexing";
}

/**
 * Sentiment with its provenance as one short judgment: "positive · from
 * rating", "negative · model". The schema stores no classifier confidence,
 * so a model label is just "model"; when it does, this is where "model
 * 0.91" appears. Null while the pipeline has not looked at the review.
 */
export function sentimentJudgment(row: {
  sentiment: Sentiment;
  sentimentSource: SentimentSource;
}): string | null {
  if (row.sentiment === null) return null;
  const source =
    row.sentimentSource === "rating"
      ? "from rating"
      : row.sentimentSource === "model"
        ? "model"
        : null;
  return source === null ? row.sentiment : `${row.sentiment} · ${source}`;
}

/** First ~`max` characters of `text`, cut at a word boundary, with an ellipsis. */
export function excerptOf(text: string, max = 120): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut.slice(0, max)).trimEnd()}…`;
}

export const ENVIRONMENTS = ["live", "test"] as const;

export function parseEnvironment(raw: string | null | undefined): Environment {
  return raw === "test" ? "test" : "live";
}

export const HIDDEN_FILTERS = ["all", "visible", "hidden"] as const;
export type HiddenFilter = (typeof HIDDEN_FILTERS)[number];

export const INDEXED_FILTERS = ["all", "indexed", "pending"] as const;
export type IndexedFilter = (typeof INDEXED_FILTERS)[number];

export interface ReviewListFilters {
  /** Exact `source` match; undefined is every source. */
  source?: string | undefined;
  /** `rating >= minRating`; undefined is every rating (unrated included). */
  minRating?: number | undefined;
  hidden: HiddenFilter;
  indexed: IndexedFilter;
}

export interface ReviewListParams {
  environment: Environment;
  cursor: string | null;
  filters: ReviewListFilters;
}

/** The query string → list parameters. Anything malformed falls back to the default. */
export function parseListParams(
  searchParams: URLSearchParams,
): ReviewListParams {
  const minRatingRaw = Number(searchParams.get("min_rating"));
  const hidden = searchParams.get("hidden");
  const indexed = searchParams.get("indexed");
  const source = searchParams.get("source")?.trim();
  return {
    environment: parseEnvironment(searchParams.get("env")),
    cursor: searchParams.get("cursor") || null,
    filters: {
      source: source ? source : undefined,
      minRating:
        Number.isInteger(minRatingRaw) && minRatingRaw >= 1 && minRatingRaw <= 5
          ? minRatingRaw
          : undefined,
      hidden: (HIDDEN_FILTERS as readonly string[]).includes(hidden ?? "")
        ? (hidden as HiddenFilter)
        : "all",
      indexed: (INDEXED_FILTERS as readonly string[]).includes(indexed ?? "")
        ? (indexed as IndexedFilter)
        : "all",
    },
  };
}

/**
 * List parameters → query string, omitting defaults so URLs stay short and
 * the first page of the default view is the bare tab URL.
 */
export function listSearchParams(
  params: Partial<ReviewListParams> & { environment: Environment },
): URLSearchParams {
  const out = new URLSearchParams();
  if (params.environment !== "live") out.set("env", params.environment);
  const f = params.filters;
  if (f?.source) out.set("source", f.source);
  if (f?.minRating !== undefined) out.set("min_rating", String(f.minRating));
  if (f?.hidden && f.hidden !== "all") out.set("hidden", f.hidden);
  if (f?.indexed && f.indexed !== "all") out.set("indexed", f.indexed);
  if (params.cursor) out.set("cursor", params.cursor);
  return out;
}

/**
 * Keyset cursor, the api's shape (`workers/api/src/routes/
 * reviews-crud-request.ts`): the `(occurred_at, id)` of a page's last row
 * as base64url JSON. Opaque, not secret; a malformed one decodes to null
 * and the list starts over rather than erroring.
 */
export interface Cursor {
  o: string | null;
  i: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeCursor(raw: string): Cursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const json: unknown = JSON.parse(
      atob(raw.replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (typeof json !== "object" || json === null) return null;
    const { o, i } = json as { o?: unknown; i?: unknown };
    if (typeof i !== "string" || !isUuid(i)) return null;
    if (o === null) return { o: null, i };
    if (typeof o !== "string" || Number.isNaN(new Date(o).getTime())) {
      return null;
    }
    return { o, i };
  } catch {
    return null;
  }
}

export function cursorFor(row: {
  id: string;
  occurredAt: Date | null;
}): Cursor {
  return { o: row.occurredAt?.toISOString() ?? null, i: row.id };
}

/** Human date for a table cell; "—" when the source carried none. */
export function formatDate(iso: string | null): string {
  if (iso === null) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatDateTime(iso: string | null): string {
  if (iso === null) return "—";
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}
