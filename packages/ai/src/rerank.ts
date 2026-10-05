/**
 * The reranker seam (#147, experimental): score (query, passage) pairs
 * with a cross-encoder after retrieval. Production is
 * {@link createWorkersAiReranker} over `@cf/baai/bge-reranker-base`; tests
 * use {@link FakeReranker}, a deterministic word-overlap score.
 *
 * The api only calls it when the `RERANK` flag is on (off by default;
 * `docs/performance.md` §5 has the measurement and the recommendation).
 */

import {
  AiProviderError,
  AiResponseError,
  isRecord,
  type WorkersAiBinding,
} from "./workersAi.js";

export interface Reranker {
  readonly model: string;
  /**
   * One relevance score in [0, 1] per passage, in the passages' order
   * (not sorted). An empty `passages` resolves to `[]` without a call.
   */
  rerank(query: string, passages: readonly string[]): Promise<number[]>;
}

/** The Workers AI model id. */
export const BGE_RERANKER_BASE_MODEL = "@cf/baai/bge-reranker-base";

export class RerankError extends AiProviderError {}

/**
 * Workers AI reranker response: `{ response: [{ id, score }] }`, `id` the
 * index into `contexts`, `score` sigmoid-mapped to [0, 1]. Every index
 * must come back exactly once.
 */
function parseRerankResponse(
  model: string,
  raw: unknown,
  count: number,
): number[] {
  if (!isRecord(raw) || !Array.isArray(raw.response)) {
    throw new AiResponseError(model, "expected { response: [{ id, score }] }");
  }
  const scores = new Array<number | undefined>(count).fill(undefined);
  for (const item of raw.response) {
    if (
      !isRecord(item) ||
      typeof item.id !== "number" ||
      !Number.isInteger(item.id) ||
      item.id < 0 ||
      item.id >= count ||
      typeof item.score !== "number" ||
      !Number.isFinite(item.score)
    ) {
      throw new AiResponseError(
        model,
        "each entry must be { id: index, score: number }",
      );
    }
    scores[item.id] = item.score;
  }
  if (scores.some((s) => s === undefined)) {
    throw new AiResponseError(
      model,
      `expected ${count} scores, got ${raw.response.length}`,
    );
  }
  return scores as number[];
}

/** The production `Reranker` over a Workers AI binding. */
export function createWorkersAiReranker(
  ai: WorkersAiBinding,
  options: { model?: string } = {},
): Reranker {
  const model = options.model ?? BGE_RERANKER_BASE_MODEL;
  return {
    model,
    async rerank(query, passages) {
      if (passages.length === 0) return [];
      if (query.trim().length === 0) {
        throw new RerankError("rerank: empty query");
      }
      const raw = await ai.run(model, {
        query,
        contexts: passages.map((text) => ({ text })),
        top_k: passages.length,
      });
      return parseRerankResponse(model, raw, passages.length);
    },
  };
}

/** Model id stamped by the fake; never a real Workers AI model. */
export const FAKE_RERANKER_MODEL = "fake-bge-reranker";

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

/**
 * Deterministic stand-in: the share of the query's words (3+ letters)
 * that appear in the passage. Exported so tests can predict it.
 */
export function fakeRerankScore(query: string, passage: string): number {
  const q = words(query);
  if (q.size === 0) return 0;
  const p = words(passage);
  let hit = 0;
  for (const w of q) if (p.has(w)) hit++;
  return hit / q.size;
}

export class FakeReranker implements Reranker {
  readonly model = FAKE_RERANKER_MODEL;
  readonly calls: { query: string; passages: readonly string[] }[] = [];
  constructor(private readonly options: { shouldFail?: boolean } = {}) {}

  async rerank(query: string, passages: readonly string[]): Promise<number[]> {
    this.calls.push({ query, passages });
    if (this.options.shouldFail) throw new RerankError("fake reranker failure");
    return passages.map((p) => fakeRerankScore(query, p));
  }
}
