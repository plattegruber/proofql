/**
 * Experimental reranking for `/v1/query` (#147), behind the `RERANK`
 * worker var (default off; `docs/performance.md` §5).
 *
 * With `RERANK=true` and a `q`, the search fetches the top
 * {@link RERANK_CANDIDATES} reviews by fused rank with the cosine floor
 * switched off, scores each one's best excerpt against `q` with
 * `@cf/baai/bge-reranker-base`, keeps those whose reranker score clears
 * `RERANK_THRESHOLD` (default {@link DEFAULT_RERANK_THRESHOLD}), and
 * returns them in reranker order. The reranker score replaces the cosine
 * floor as the relevance gate; the response's `score` stays the cosine
 * similarity, so the contract does not change.
 *
 * If the reranker call fails, the candidates are held to the ordinary
 * two-tier floor instead, so an outage degrades to today's behavior and
 * never to "everything within 20". The headers `x-rerank-ms` and
 * `x-rerank-scores` (scores of the returned rows, in order) exist for the
 * measurement (`pnpm db:tune-floor -- --rerank`).
 */

import { lexicalFloorFor } from "@proofql/core";
import type { SearchResult } from "@proofql/db";

import type { ApiBindings } from "../bindings.js";

/** Candidates the reranker sees: the search's maximum page. */
export const RERANK_CANDIDATES = 20;

/**
 * Reranker score a row must reach. Measured on the relevance fixtures in
 * #147 (`docs/performance.md` §5): the lowest threshold that keeps the
 * must-be-empty queries' FP rate at or under 5%. There it answers only
 * 10 of 35 answerable queries, which is why reranking stays off.
 */
export const DEFAULT_RERANK_THRESHOLD = 0.85;

export interface RerankConfig {
  threshold: number;
}

/** Null when reranking is off (the default) or the threshold is invalid. */
export function rerankConfig(
  env: Pick<ApiBindings, "RERANK" | "RERANK_THRESHOLD">,
): RerankConfig | null {
  if (env.RERANK !== "true") return null;
  const raw = env.RERANK_THRESHOLD;
  const threshold =
    raw === undefined || raw === "" ? DEFAULT_RERANK_THRESHOLD : Number(raw);
  if (!(threshold >= 0 && threshold <= 1)) return null;
  return { threshold };
}

export interface Reranked {
  rows: SearchResult[];
  /** Reranker score per returned row, same order. */
  scores: number[];
}

/**
 * Order `candidates` by `scores` (descending; ties keep the fused order),
 * drop those under `threshold`, keep `limit`.
 */
export function applyRerank(
  candidates: readonly SearchResult[],
  scores: readonly number[],
  threshold: number,
  limit: number,
): Reranked {
  const kept = candidates
    .map((row, i) => ({ row, score: scores[i] ?? 0, i }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit);
  return { rows: kept.map((x) => x.row), scores: kept.map((x) => x.score) };
}

/** The ordinary two-tier floor, for the reranker-failure path. */
export function passesFloor(row: SearchResult, floor: number): boolean {
  const similarity = row.similarity ?? 0;
  return (
    similarity >= floor || (row.lexical && similarity >= lexicalFloorFor(floor))
  );
}
