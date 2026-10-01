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
 *    `similarity_floor`, `show_badge`. The effective minimum rating is
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
 *
 * ## Response
 *
 * ```json
 * { "results": [{ "score": 0.83, "excerpt": "…", "excerpt_id": "<chunk uuid>",
 *                 "review": { "id", "rating", "author_name", "author_avatar_url",
 *                             "source", "occurred_at", "url", "metadata",
 *                             "text" } }],   // text: mode=reviews only
 *   "took_ms": 12, "cached": false, "badge": true }
 * ```
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
 * same best chunk accompanies the whole review as `review.text`. `badge`
 * mirrors `projects.show_badge` (free tier: true). `cached` is always
 * false until #28 adds the KV layer. (#42: copy this block into OpenAPI.)
 */

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
import { ApiError } from "../errors.js";
import { log } from "../log.js";
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
  /** Whole review text; present in `mode=reviews` only. */
  text?: string;
}

export interface QueryResponseResult {
  /** Cosine similarity of the excerpt to `q`, in [0, 1]; null without `q`. */
  score: number | null;
  excerpt: string;
  /** `review_chunks.id` of the excerpt. */
  excerpt_id: string;
  review: QueryResponseReview;
}

export interface QueryResponse {
  results: QueryResponseResult[];
  took_ms: number;
  /** Always false until the KV cache (#28) lands. */
  cached: false;
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
      log("query.embedding_failed", {
        request_id: c.get("requestId"),
        project_id: auth.projectId,
        environment: auth.environment,
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
      });
      throw new ApiError(
        "embedding_unavailable",
        "The embedding service is temporarily unavailable; retry the query shortly.",
        { cause: error },
      );
    }
    embedMs = performance.now() - embedStarted;
  }

  const results = await searchChunks(c.get("getDb")(), {
    projectId: auth.projectId,
    environment: auth.environment,
    queryEmbedding,
    queryText: request.q,
    limit: request.limit,
    policy,
    filters: toSearchFilters(request.filters),
    mode: request.mode,
  });

  const tookMs = Math.round(performance.now() - started);
  log("query.served", {
    request_id: c.get("requestId"),
    project_id: auth.projectId,
    environment: auth.environment,
    key_kind: auth.kind,
    method: c.req.method,
    mode: request.mode,
    has_q: request.q !== undefined,
    limit: request.limit,
    min_rating: policy.minRating,
    similarity_floor: policy.similarityFloor,
    result_count: results.length,
    took_ms: tookMs,
    embed_ms: Math.round(embedMs),
  });

  const body: QueryResponse = {
    results: results.map((r) => toResponseResult(r, request.mode)),
    took_ms: tookMs,
    cached: false,
    badge: project.showBadge,
  };
  return c.json(body);
};

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

function toResponseResult(
  r: SearchResult,
  mode: QueryRequest["mode"],
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
  if (mode === "reviews") review.text = r.review.text;
  return {
    score: r.similarity,
    excerpt: r.excerpt,
    excerpt_id: r.chunkId,
    review,
  };
}

queryRoutes.options("/", preflight);
queryRoutes.on(["GET", "POST"], "/", requireQueryKey, cors, handleQuery);
