/**
 * The playground's search (#40): the api's `/v1/query` policy, run straight
 * against Postgres in `searchChunks`'s debug variant so the page can show
 * the candidates the relevance floor dropped.
 *
 * Same policy as `workers/api/src/query/route.ts`: the effective minimum
 * rating is `max(project.min_rating, override)` — a caller tightens, never
 * loosens — and the floor is the project's `similarity_floor`. The query is
 * embedded like the api does it (`workers/api/src/embedder.ts`): Workers AI
 * bge-m3 where `env.AI` is bound (preview/prod), the deterministic fake
 * locally — the seed's chunks were embedded with the same fake, so local
 * queries land near the right rows — and a loud error anywhere else.
 *
 * No KV cache on this path, on purpose: the playground exists to see what
 * the database says right now, including after a hide. `took_ms` is the
 * embed plus the search, which is what an uncached api call pays.
 *
 * Honest fallback (#86): with `fallback: "recent"` and nothing above the
 * floor, the api answers with the newest publishable reviews labelled
 * `match: "fallback"`. The playground runs the same recency statement and
 * returns those rows separately (`fallback`), keeping the below-floor
 * candidates in `results` so the page can still show *why* the query came
 * back thin. `match` is the api's verdict for this request.
 */
import {
  createWorkersAiEmbedder,
  type EmbeddingProvider,
  FakeEmbeddingProvider,
} from "@proofql/ai";
import {
  type MAX_SEARCH_LIMIT as DB_MAX_SEARCH_LIMIT,
  type Db,
  type SearchResult,
  searchChunks,
} from "@proofql/db";

import { MAX_SEARCH_LIMIT, type PlaygroundRequest } from "./playground";

// The client-safe copy in ./playground.ts must track the db package.
const _limitsAgree: typeof DB_MAX_SEARCH_LIMIT = MAX_SEARCH_LIMIT;

/** The embedder for this environment; throws where none can exist. */
export function getEmbedder(
  env: Pick<Env, "AI" | "ENVIRONMENT">,
): EmbeddingProvider {
  if (env.AI) return createWorkersAiEmbedder(env.AI);
  if (env.ENVIRONMENT === "local") return new FakeEmbeddingProvider();
  throw new Error(
    `AI binding is not bound in environment "${env.ENVIRONMENT}" — add it to wrangler.jsonc (infra/environments.md)`,
  );
}

/** A result as the page renders it: `SearchResult` with wire-safe dates. */
export interface PlaygroundResult {
  reviewId: string;
  chunkId: string;
  excerpt: string;
  startOffset: number;
  similarity: number | null;
  belowFloor: boolean;
  /**
   * The chunk matches the query's words (at least half of its specific
   * words, #147), so it was held to the lexical tier of the floor
   * (`lexicalFloorFor`, #138) instead of the floor.
   */
  lexical: boolean;
  review: {
    rating: number | null;
    authorName: string | null;
    source: string;
    occurredAt: string | null;
    url: string | null;
    metadata: Record<string, string>;
    text: string;
  };
}

export interface PlaygroundPolicy {
  minRating: number;
  similarityFloor: number;
  /** `projects.category` (#151): the generic words of the partial word match. */
  category?: string | null;
}

/** The api's response-level verdict (`workers/api/src/query/route.ts`). */
export type PlaygroundMatch = "query" | "fallback" | "none" | "recent";

export type PlaygroundOutcome =
  | {
      ok: true;
      results: PlaygroundResult[];
      /** What the api would say about this request. */
      match: PlaygroundMatch;
      /** The rows the api would return on `match: "fallback"`; null otherwise. */
      fallback: PlaygroundResult[] | null;
      policy: PlaygroundPolicy;
      tookMs: number;
      embeddingMs: number;
      searchMs: number;
    }
  | {
      ok: false;
      /** The api's 503 code, so the page can say the same thing it would. */
      error: "embedding_unavailable";
      policy: PlaygroundPolicy;
    };

export interface RunPlaygroundParams {
  projectId: string;
  project: PlaygroundPolicy;
  request: PlaygroundRequest;
}

export function effectivePolicy(
  project: PlaygroundPolicy,
  request: Pick<PlaygroundRequest, "minRating">,
): PlaygroundPolicy {
  return {
    minRating: Math.max(project.minRating, request.minRating ?? 0),
    similarityFloor: project.similarityFloor,
    category: project.category ?? null,
  };
}

export async function runPlayground(
  db: Db,
  embedder: EmbeddingProvider,
  params: RunPlaygroundParams,
): Promise<PlaygroundOutcome> {
  const { request } = params;
  const policy = effectivePolicy(params.project, request);
  const started = performance.now();

  let queryEmbedding: number[] | undefined;
  let embeddingMs = 0;
  if (request.q !== undefined) {
    const embedStarted = performance.now();
    try {
      queryEmbedding = await embedder.embedText(request.q);
    } catch {
      // Same answer as the api: no full-text-only fallback (route.ts).
      return { ok: false, error: "embedding_unavailable", policy };
    }
    embeddingMs = performance.now() - embedStarted;
  }

  const searchStarted = performance.now();
  const search = {
    projectId: params.projectId,
    environment: request.environment,
    limit: request.limit,
    policy,
    filters: {
      source: request.source !== undefined ? [request.source] : undefined,
      since: request.since,
      metadata:
        Object.keys(request.metadata).length > 0 ? request.metadata : undefined,
    },
    mode: request.mode,
  };
  const rows = await searchChunks(db, {
    ...search,
    queryEmbedding,
    queryText: request.q,
    includeBelowFloor: true,
  });
  const above = rows.filter((r) => !r.belowFloor).length;
  let match: PlaygroundMatch =
    request.q === undefined ? "recent" : above > 0 ? "query" : "none";
  let fallback: PlaygroundResult[] | null = null;
  if (match === "none" && request.fallback === "recent") {
    // Same statement the api runs for its fallback: no query, same policy.
    fallback = (await searchChunks(db, search)).map(toPlaygroundResult);
    match = "fallback";
  }
  const searchMs = performance.now() - searchStarted;

  return {
    ok: true,
    results: rows.map(toPlaygroundResult),
    match,
    fallback,
    policy,
    tookMs: Math.round(performance.now() - started),
    embeddingMs: Math.round(embeddingMs),
    searchMs: Math.round(searchMs),
  };
}

export function toPlaygroundResult(r: SearchResult): PlaygroundResult {
  return {
    reviewId: r.reviewId,
    chunkId: r.chunkId,
    excerpt: r.excerpt,
    startOffset: r.startOffset,
    similarity: r.similarity,
    belowFloor: r.belowFloor,
    lexical: r.lexical,
    review: {
      rating: r.review.rating,
      authorName: r.review.authorName,
      source: r.review.source,
      occurredAt: r.review.occurredAt?.toISOString() ?? null,
      url: r.review.url,
      metadata: r.review.metadata,
      text: r.review.text,
    },
  };
}
