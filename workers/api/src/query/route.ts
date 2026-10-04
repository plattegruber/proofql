/**
 * `GET|POST /v1/query` — hybrid search over a project's publishable
 * reviews (scope.md §3 "Query"; #26 auth/CORS/validation, #27 search path).
 *
 * One handler serves both verbs: POST carries a JSON body, GET maps query
 * parameters onto the same shape (`./request.ts`). Either key kind
 * authenticates; publishable keys must also come from a listed browser
 * origin (`../cors.ts`).
 *
 * ## Search path
 *
 * 1. Policy is read once with the key (`requireAuth`): `min_rating`,
 *    `similarity_floor`, and the account's plan. The effective minimum rating is
 *    `max(project.min_rating, filters.min_rating)` — a caller can tighten
 *    the project's policy for one query, never loosen it.
 * 2. With `q`, the query is embedded at the edge with Workers AI (bge-m3;
 *    the deterministic fake locally and in tests). If embedding fails the
 *    response is 503 `embedding_unavailable` — deliberately **not** a
 *    full-text-only fallback: a keyword match with no vector proximity is
 *    exactly what the relevance floor exists to drop, so a silent fallback
 *    would return the irrelevant results the product promises never to
 *    show. A retryable error is better than degraded relevance nobody can
 *    see.
 * 3. `searchChunks` runs policy, filters, exact cosine, full-text rank,
 *    RRF fusion, floor, and per-review collapse in one SQL statement.
 *    Without `q` it returns the newest publishable reviews.
 * 4. **Honest fallback (#86).** With `q` and `fallback: "recent"`, an
 *    *empty* floored result is replaced by the newest publishable reviews
 *    under the same policy and filters — the no-`q` statement — and the
 *    response says so: `match: "fallback"`, every result `matched: false`
 *    with `score` and `highlight` null. Only an empty result falls back;
 *    a partial page is never topped up, because a list that is two real
 *    matches and three recent reviews has no honest label. The default
 *    `fallback: "none"` keeps `results: []` ("empty beats irrelevant"),
 *    reported as `match: "none"`. The verdict rides in the cache entry so
 *    a HIT stays labelled.
 *
 * ## Cache (`./cache.ts`, #28)
 *
 * Between validation and the quota check the handler looks the request up
 * in KV under a key built from the project, environment, the project's
 * cache generation, and a hash of the normalized request. A hit is served
 * as-is with `cached: true`, a fresh `took_ms`, `x-cache: HIT`, and is
 * counted as a free cache hit (`markCacheHit`) — so it is served even when
 * the project is at its monthly quota. A miss pays the quota check
 * (`enforceQueryQuota`), then the embedding and the search, and the
 * `results` are stored after the response goes out (`waitUntil`) for the
 * next caller; `x-cache: MISS`. `Cache-Control: no-cache` on the request
 * skips the lookup but still stores (`x-cache: BYPASS`). A failing KV read
 * is logged and treated as a miss: the cache can slow the endpoint down,
 * never take it down.
 *
 * ## Logging (#30; docs/observability.md)
 *
 * Exactly one `query.completed` line per answered query, hit or miss, with
 * the knobs that shaped the result (`similarity_floor`, `min_rating`,
 * `limit`, `mode`, `fallback`, `has_q`, `q_length`) and what came of them
 * (`returned`, `match`, `cached`, `took_ms`, `embedding_ms`, `search_ms`) —
 * the data the floor is tuned from. Never the query text, never an excerpt. Refused requests are
 * one `query.rejected` line from `onError` (`../errors.ts`); an embedding
 * outage is `query.embedding_failed`; a KV fault is `query.cache_error`.
 * Every line carries `request_id` via the per-request logger.
 *
 * ## Response
 *
 * ```json
 * { "results": [{ "score": 0.83, "matched": true, "excerpt": "…",
 *                 "excerpt_id": "<chunk uuid>",
 *                 "highlight": { "start": 41, "end": 97 },   // or null
 *                 "review": { "id", "rating", "author_name", "author_avatar_url",
 *                             "source", "occurred_at", "url", "metadata",
 *                             "text" } }],   // text: mode=reviews, or include: ["text"]
 *   "match": "query",   // query | fallback | none | recent
 *   "took_ms": 12, "cached": false, "badge": true }
 * ```
 *
 * `match` is the response's one-word verdict: `query` (real matches),
 * `fallback` (nothing cleared the floor; these are the newest reviews
 * because the caller asked for `fallback: "recent"`), `none` (nothing
 * cleared the floor and `results` is empty), `recent` (no `q` was sent).
 * A response is all matches or all fallback, never a mix; `matched` on
 * each result is the same fact per row, for templates.
 *
 * `score` is the returned excerpt's **cosine similarity to the query**
 * (`SearchResult.similarity`): already in [0, 1], already at or above the
 * project's floor, and comparable across queries. It is *not* the fused
 * RRF rank `searchChunks` orders by (`SearchResult.score`), which is only
 * meaningful within one result set; that number stays internal. Results
 * are in rank order, so `score` may be non-monotone when the full-text
 * branch promoted a row. Without `q` there is no query vector and `score`
 * is `null`. `excerpt` is a verbatim slice of `review.text`; in
 * `mode=excerpts` it is the best-matching chunk, in `mode=reviews` the
 * same best chunk accompanies the whole review as `review.text`; in either
 * mode `include: ["text"]` adds `review.text` (#85). `highlight` is where
 * `excerpt` sits inside `review.text` — `{ start, end }` in UTF-16 code
 * units, end exclusive, so `review.text.slice(start, end) === excerpt`
 * holds in every browser (the chunker's verbatim invariant,
 * packages/core/src/chunking.ts) — or `null` when there is nothing to
 * mark: without `q`, and when the match is the review's `full` chunk (a
 * whole-review match highlights nothing). `badge`
 * is `planFor(account.plan).badge` (free tier: true), derived per request
 * from the plan that arrived with the key — never from the cached body and
 * never from the `projects.show_badge` mirror — so it flips on the first
 * request after a plan change, cache HIT or not. `cached` says whether
 * `results` came from KV. (#42: copy this block into OpenAPI.)
 */

import { planFor, readProjectGeneration } from "@proofql/core";
import type { SearchFilters, SearchResult } from "@proofql/db";
import { searchChunks } from "@proofql/db";
import { type Context, type Handler, Hono } from "hono";

import { lookupApiKey, presentedToken, requireQueryKey } from "../auth.js";
import type { AppEnv } from "../bindings.js";
import {
  applyCorsHeaders,
  corsOriginFor,
  isAllowedOrigin,
  PREFLIGHT_HEADERS,
} from "../cors.js";
import { waitUntil } from "../db.js";
import { ApiError } from "../errors.js";
import { enforceQueryQuota, markCacheHit, queryQuota } from "../quota.js";
import { logFor } from "../request-id.js";
import {
  CACHE_HEADER,
  type CachedBody,
  type CacheOutcome,
  cacheKey,
  getCached,
  putCached,
  wantsFresh,
} from "./cache.js";
import {
  parseQueryRequest,
  type QueryFilters,
  type QueryRequest,
  queryParamsToRequest,
} from "./request.js";

export interface QueryResponseReview {
  id: string;
  rating: number | null;
  author_name: string | null;
  author_avatar_url: string | null;
  source: string;
  /** ISO 8601, or null when the source carried no date. */
  occurred_at: string | null;
  url: string | null;
  metadata: Record<string, string>;
  /** Whole review text; present in `mode=reviews` or with `include: ["text"]`. */
  text?: string;
}

/** The response's verdict on its `results` (module doc "Response"). */
export type QueryMatch = "query" | "fallback" | "none" | "recent";

/** Where `excerpt` sits in `review.text`: UTF-16 code units, `end` exclusive. */
export interface QueryHighlight {
  start: number;
  end: number;
}

export interface QueryResponseResult {
  /** Cosine similarity of the excerpt to `q`, in [0, 1]; null without `q` and on fallback rows. */
  score: number | null;
  /** True for a real match; false for a fallback row and without `q`. */
  matched: boolean;
  excerpt: string;
  /** `review_chunks.id` of the excerpt. */
  excerpt_id: string;
  /**
   * `excerpt`'s span within `review.text`, or null when there is nothing
   * to mark: no `q`, or a match on the whole review (module doc).
   */
  highlight: QueryHighlight | null;
  review: QueryResponseReview;
}

export interface QueryResponse {
  results: QueryResponseResult[];
  match: QueryMatch;
  took_ms: number;
  /** Whether `results` were served from the KV cache. */
  cached: boolean;
  /** Whether the snippet must render the "Reviews by ProofQL" badge. */
  badge: boolean;
}

/** Mounted at `/v1/query` by `createApp`: `OPTIONS`, `GET`, `POST`. */
export const queryRoutes = new Hono<AppEnv>();

/**
 * CORS preflight: unauthenticated, but echoes only an origin the key's
 * project lists (module doc in ../cors.ts). Secret keys echo any origin,
 * matching the real request's behavior.
 */
const preflight: Handler<AppEnv> = async (c) => {
  const origin = c.req.header("Origin");
  const presented = presentedToken(c);
  let allow: string | null = null;
  if (origin !== undefined && presented !== null) {
    const found = await lookupApiKey(c.get("getDb")(), presented.token);
    const auth = found?.auth;
    if (
      auth !== undefined &&
      // The real request refuses a secret key from the URL; so does preflight.
      !(presented.fromUrl && auth.kind === "secret") &&
      (auth.kind === "secret" ||
        isAllowedOrigin(origin, auth.project.allowedOrigins))
    ) {
      allow = origin;
    }
  }
  applyCorsHeaders(c, allow);
  for (const [name, value] of Object.entries(PREFLIGHT_HEADERS)) {
    c.header(name, value);
  }
  return c.body(null, 204);
};

/** Origin rules for the authenticated request; headers apply to errors too. */
const cors: Handler<AppEnv> = async (c, next) => {
  // Set before `next()`: headers registered on the context are merged into
  // whatever response is built later, including the error envelope from
  // `onError`, so a listed origin can read a 422 as well as a 200.
  applyCorsHeaders(c, null);
  const allow = corsOriginFor(c.req.header("Origin"), c.get("auth"));
  applyCorsHeaders(c, allow);
  await next();
};

/** The shared GET/POST handler (module doc). */
const handleQuery: Handler<AppEnv> = async (c) => {
  const started = performance.now();
  const auth = c.get("auth");
  const request = await readRequest(c);
  const { project } = auth;

  const policy = {
    minRating: Math.max(project.minRating, request.filters.min_rating ?? 0),
    similarityFloor: project.similarityFloor,
  };

  const cache = await lookupCache(c, request, policy);
  if (cache.hit !== null) {
    markCacheHit(c);
    const tookMs = Math.round(performance.now() - started);
    logCompleted(c, request, policy, {
      returned: cache.hit.results.length,
      match: cache.hit.match,
      cached: cache.outcome,
      took_ms: tookMs,
      embedding_ms: 0,
      search_ms: 0,
    });
    return respond(c, cache.hit, tookMs, true, cache.outcome);
  }

  // Only a miss costs quota — and the check comes before the expensive work.
  await enforceQueryQuota(c);

  let queryEmbedding: number[] | undefined;
  let embedMs = 0;
  if (request.q !== undefined) {
    const embedStarted = performance.now();
    try {
      // Resolved inside the try: an unbound AI binding is the same outage
      // to the caller as a failed call (src/embedder.ts).
      queryEmbedding = await c.get("getEmbedder")().embedText(request.q);
    } catch (error) {
      // No FTS-only fallback — see the module doc for why.
      logFor(c).log("query.embedding_failed", {
        project_id: auth.projectId,
        key_environment: auth.environment,
        key_kind: auth.kind,
        q_length: request.q.length,
        embedding_ms: Math.round(performance.now() - embedStarted),
        error,
      });
      throw new ApiError(
        "embedding_unavailable",
        "The embedding service is temporarily unavailable; retry the query shortly.",
        { cause: error },
      );
    }
    embedMs = performance.now() - embedStarted;
  }

  const searchStarted = performance.now();
  const search = {
    projectId: auth.projectId,
    environment: auth.environment,
    limit: request.limit,
    policy,
    filters: toSearchFilters(request.filters),
    mode: request.mode,
  };
  let rows = await searchChunks(c.get("getDb")(), {
    ...search,
    queryEmbedding,
    queryText: request.q,
  });
  let match: QueryMatch =
    request.q === undefined ? "recent" : rows.length > 0 ? "query" : "none";
  if (match === "none" && request.fallback === "recent") {
    // Honest fallback (module doc §4): the no-q statement, same policy and
    // filters, labelled as what it is.
    rows = await searchChunks(c.get("getDb")(), search);
    match = "fallback";
  }
  const searchMs = performance.now() - searchStarted;
  const body: CachedBody = {
    results: rows.map((r) => toResponseResult(r, request, match)),
    match,
  };

  if (cache.key !== null) {
    // After the response: a slow KV write must not add to `took_ms`, and a
    // failed one is a cache miss next time, not an error now.
    waitUntil(
      c,
      putCached(c.env.CACHE, cache.key, body, {
        generation: cache.generation,
      }).catch((error: unknown) => logCacheError(c, "put", error)),
    );
  }

  const tookMs = Math.round(performance.now() - started);
  logCompleted(c, request, policy, {
    returned: body.results.length,
    match,
    cached: cache.outcome,
    took_ms: tookMs,
    embedding_ms: Math.round(embedMs),
    search_ms: Math.round(searchMs),
  });
  return respond(c, body, tookMs, false, cache.outcome);
};

interface CacheLookup {
  /** Null when KV could not be read; the result is then not stored either. */
  key: string | null;
  generation: number;
  hit: CachedBody | null;
  outcome: CacheOutcome;
}

/** Key the request and consult KV unless the caller asked for fresh results. */
async function lookupCache(
  c: Context<AppEnv>,
  request: QueryRequest,
  policy: { minRating: number; similarityFloor: number },
): Promise<CacheLookup> {
  const auth = c.get("auth");
  const kv = c.env.CACHE;
  const fresh = wantsFresh(c.req.header("Cache-Control"));
  try {
    const generation = await readProjectGeneration(kv, auth.projectId);
    const key = await cacheKey({
      projectId: auth.projectId,
      environment: auth.environment,
      generation,
      request,
      policy,
    });
    if (fresh) return { key, generation, hit: null, outcome: "BYPASS" };
    const entry = await getCached(kv, key);
    return {
      key,
      generation,
      hit:
        entry === null ? null : { results: entry.results, match: entry.match },
      outcome: entry === null ? "MISS" : "HIT",
    };
  } catch (error) {
    logCacheError(c, "get", error);
    return { key: null, generation: 0, hit: null, outcome: "MISS" };
  }
}

function respond(
  c: Context<AppEnv>,
  cachedBody: CachedBody,
  tookMs: number,
  cached: boolean,
  outcome: CacheOutcome,
): Response {
  const body: QueryResponse = {
    results: cachedBody.results,
    match: cachedBody.match,
    took_ms: tookMs,
    cached,
    badge: planFor(c.get("auth").plan).badge,
  };
  c.header(CACHE_HEADER, outcome);
  return c.json(body);
}

/** What `query.completed` reports beyond the request's own knobs. */
interface QueryOutcome {
  returned: number;
  match: QueryMatch;
  cached: CacheOutcome;
  took_ms: number;
  embedding_ms: number;
  search_ms: number;
}

/**
 * The one line per answered query (module doc "Logging"). `q_length`
 * stands in for the text; `similarity_floor` with `returned` is what the
 * floor is tuned from (docs/observability.md).
 */
function logCompleted(
  c: Context<AppEnv>,
  request: QueryRequest,
  policy: { minRating: number; similarityFloor: number },
  outcome: QueryOutcome,
): void {
  const auth = c.get("auth");
  logFor(c).log("query.completed", {
    project_id: auth.projectId,
    key_environment: auth.environment,
    key_kind: auth.kind,
    mode: request.mode,
    fallback: request.fallback,
    has_q: request.q !== undefined,
    q_length: request.q?.length ?? 0,
    limit: request.limit,
    min_rating: policy.minRating,
    similarity_floor: policy.similarityFloor,
    ...outcome,
  });
}

/** A KV fault is a slower request, not a failed one: warn, never error. */
function logCacheError(
  c: Context<AppEnv>,
  op: "get" | "put",
  error: unknown,
): void {
  const auth = c.get("auth");
  logFor(c).log("query.cache_error", {
    level: "warn",
    project_id: auth.projectId,
    key_environment: auth.environment,
    op,
    error,
  });
}

async function readRequest(c: Context<AppEnv>): Promise<QueryRequest> {
  if (c.req.method === "GET") {
    return parseQueryRequest(
      queryParamsToRequest(new URL(c.req.url).searchParams),
    );
  }
  const text = await c.req.text();
  if (text.trim() === "") return parseQueryRequest({});
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new ApiError("validation_failed", "Request body is not valid JSON.", {
      details: [{ path: "", message: "Request body is not valid JSON." }],
    });
  }
  return parseQueryRequest(decoded);
}

function toSearchFilters(filters: QueryFilters): SearchFilters {
  return {
    source: filters.source,
    since: filters.since,
    metadata: filters.metadata,
  };
}

/**
 * `excerpt`'s offsets in the whole review, or null when a mark would cover
 * everything or nothing: no-query mode (`similarity` null) and a `full`
 * chunk match (offset 0, same length as the review).
 */
export function highlightFor(
  r: Pick<SearchResult, "excerpt" | "startOffset" | "similarity"> & {
    review: Pick<SearchResult["review"], "text">;
  },
): QueryHighlight | null {
  if (r.similarity === null) return null;
  if (r.startOffset === 0 && r.excerpt.length === r.review.text.length) {
    return null;
  }
  return { start: r.startOffset, end: r.startOffset + r.excerpt.length };
}

function toResponseResult(
  r: SearchResult,
  request: Pick<QueryRequest, "mode" | "include">,
  match: QueryMatch,
): QueryResponseResult {
  const review: QueryResponseReview = {
    id: r.reviewId,
    rating: r.review.rating,
    author_name: r.review.authorName,
    author_avatar_url: r.review.authorAvatarUrl,
    source: r.review.source,
    occurred_at: r.review.occurredAt?.toISOString() ?? null,
    url: r.review.url,
    metadata: r.review.metadata,
  };
  if (request.mode === "reviews" || request.include.includes("text")) {
    review.text = r.review.text;
  }
  // A fallback row came from the recency statement, so `similarity` and
  // `highlight` are already null; `matched` restates the response verdict.
  return {
    score: r.similarity,
    matched: match === "query",
    excerpt: r.excerpt,
    excerpt_id: r.chunkId,
    highlight: highlightFor(r),
    review,
  };
}

queryRoutes.options("/", preflight);
// Quota after CORS so an over-quota 429 is readable by the snippet's origin.
// `queryQuota` only counts here; the handler enforces on a cache miss.
queryRoutes.on(
  ["GET", "POST"],
  "/",
  requireQueryKey,
  cors,
  queryQuota,
  handleQuery,
);
