/**
 * Element attributes → the `GET /v1/query` URL.
 *
 * | attribute          | parameter          | notes                                  |
 * |--------------------|--------------------|----------------------------------------|
 * | `data-query`       | `q`                | omitted when blank: newest reviews     |
 * | `data-limit`       | `limit`            | default 3, clamped to 1–20             |
 * | `data-mode`        | `mode`             | `excerpts` (default) or `reviews`      |
 * | `data-highlight`   | `include=text`     | `"true"` asks for the whole text (excerpts mode) so the match can be marked |
 * | `data-fallback`    | `fallback`         | `recent`: newest reviews, labelled, when nothing matches |
 * | `data-min-rating`  | `min_rating`       | integer 1–5; anything else is dropped  |
 * | `data-source`      | `source`           | comma-separated list, passed through   |
 * | `data-since`       | `since`            | ISO date, passed through               |
 * | `data-meta-<k>`    | `metadata.<k>`     | one parameter per attribute            |
 *
 * The API rejects unknown parameters with a 422 (workers/api/src/query/
 * request.ts), so this is the complete list — no cache busters, no
 * telemetry. Parameter order is fixed so identical elements produce
 * identical URLs and share the edge cache.
 */

import type { QueryMode } from "./types.js";

export const DEFAULT_LIMIT = 3;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 20;

const META_PREFIX = "data-meta-";

export interface ElementQuery {
  q?: string;
  limit: number;
  mode?: QueryMode;
  /** Render the whole review with the matched span marked (`./render.ts`). */
  highlight: boolean;
  fallback?: "recent";
  min_rating?: number;
  source?: string;
  since?: string;
  metadata: Record<string, string>;
}

function attr(el: Element, name: string): string | undefined {
  const value = el.getAttribute(name);
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function int(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value)) return undefined;
  return Number(value);
}

/** Read what one `[data-proofql]` element asks for. */
export function readElementQuery(el: Element): ElementQuery {
  const query: ElementQuery = {
    limit: DEFAULT_LIMIT,
    highlight: attr(el, "data-highlight") === "true",
    metadata: {},
  };

  const q = attr(el, "data-query");
  if (q !== undefined) query.q = q;

  const limit = int(attr(el, "data-limit"));
  if (limit !== undefined) {
    query.limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, limit));
  }

  const mode = attr(el, "data-mode");
  if (mode === "excerpts" || mode === "reviews") query.mode = mode;

  if (attr(el, "data-fallback") === "recent") query.fallback = "recent";

  const minRating = int(attr(el, "data-min-rating"));
  if (minRating !== undefined && minRating >= 1 && minRating <= 5) {
    query.min_rating = minRating;
  }

  const source = attr(el, "data-source");
  if (source !== undefined) query.source = source;

  const since = attr(el, "data-since");
  if (since !== undefined) query.since = since;

  // `el.dataset` camel-cases names (`data-meta-location-id` → `metaLocationId`)
  // and loses the original spelling; read the attributes themselves.
  for (const { name, value } of Array.from(el.attributes)) {
    if (name.startsWith(META_PREFIX) && name.length > META_PREFIX.length) {
      query.metadata[name.slice(META_PREFIX.length)] = value;
    }
  }

  return query;
}

/** `{api}/v1/query?key=…&q=…` — a CORS simple request: no custom headers. */
export function buildQueryUrl(
  api: string,
  key: string,
  query: ElementQuery,
): string {
  const params = new URLSearchParams();
  params.set("key", key);
  if (query.q !== undefined) params.set("q", query.q);
  params.set("limit", String(query.limit));
  if (query.mode !== undefined) params.set("mode", query.mode);
  // `reviews` already carries the text; only excerpts needs to ask for it.
  if (query.highlight && query.mode !== "reviews")
    params.set("include", "text");
  if (query.fallback !== undefined) params.set("fallback", query.fallback);
  if (query.min_rating !== undefined) {
    params.set("min_rating", String(query.min_rating));
  }
  if (query.source !== undefined) params.set("source", query.source);
  if (query.since !== undefined) params.set("since", query.since);
  for (const k of Object.keys(query.metadata).sort()) {
    params.set(`metadata.${k}`, query.metadata[k] ?? "");
  }
  return `${api}/v1/query?${params.toString()}`;
}
