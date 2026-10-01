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
 */
import {
  createWorkersAiEmbedder,
  type EmbeddingProvider,
  FakeEmbeddingProvider,
} from "@proofql/ai";
import { type Db, type SearchResult, searchChunks } from "@proofql/db";

import type { PlaygroundRequest } from "./playground";

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
}

export type PlaygroundOutcome =
  | {
      ok: true;
      results: PlaygroundResult[];
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
  const rows = await searchChunks(db, {
    projectId: params.projectId,
    environment: request.environment,
    queryEmbedding,
    queryText: request.q,
    limit: request.limit,
    policy,
    filters: {
      source: request.source !== undefined ? [request.source] : undefined,
      since: request.since,
      metadata:
        Object.keys(request.metadata).length > 0 ? request.metadata : undefined,
    },
    mode: request.mode,
    includeBelowFloor: true,
  });
  const searchMs = performance.now() - searchStarted;

  return {
    ok: true,
    results: rows.map(toPlaygroundResult),
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
