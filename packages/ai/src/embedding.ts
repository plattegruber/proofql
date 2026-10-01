/**
 * The embedding seam (#17). `EmbeddingProvider` is the one interface the
 * pipeline (#23) and the search tests (#16) depend on.
 *
 * Production is {@link createWorkersAiEmbedder} over an injected Workers AI
 * binding running `@cf/baai/bge-m3`; the binding is passed in, never
 * imported, so this package has no Cloudflare runtime dependency.
 *
 * Tests and the seed use {@link FakeEmbeddingProvider} / {@link fakeEmbed}:
 * a deterministic hashed bag-of-words. It is not a semantic model; it
 * measures token overlap, which is exactly the fidelity downstream tests
 * need: identical text embeds identically (cosine 1.0), a near-copy scores
 * very high, and a paraphrase that shares vocabulary with an excerpt lands
 * nearer to it than an unrelated text does. Stable across processes, so
 * failures reproduce and retrieval fixtures get stable neighbors.
 */

import {
  AiProviderError,
  AiResponseError,
  isNumberArray,
  isRecord,
  type WorkersAiBinding,
} from "./workersAi.js";

/** bge-m3 dimensionality; matches the `halfvec(1024)` columns in `@proofql/db`. */
export const EMBEDDING_DIMENSIONS = 1024;

/** The Workers AI model id, also the `embedding_model` stamped on rows. */
export const BGE_M3_EMBEDDING_MODEL = "@cf/baai/bge-m3";

/**
 * Texts per Workers AI call. The binding accepts up to 100 inputs for
 * bge-m3; batching at 50 stays clear of the limit.
 */
export const EMBEDDING_BATCH_SIZE = 50;

/**
 * `embed` is the batch primitive: order-preserving, `result[i]` embeds
 * `texts[i]`. `embedText` is the single-text convenience. Every vector has
 * exactly {@link EMBEDDING_DIMENSIONS} numbers. Callers must not pass
 * empty or whitespace-only text; there is nothing to embed.
 */
export interface EmbeddingProvider {
  /** Concrete model id, recorded per row so a model swap is a re-embed job. */
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
  embedText(text: string): Promise<number[]>;
}

/** Base class for embedding failures; subclasses say which kind. */
export class EmbeddingError extends AiProviderError {}

/**
 * The model returned a vector of the wrong dimensionality. Fail loudly: a
 * silently truncated or padded vector would be stored and then compared
 * against every neighbor as garbage.
 */
export class EmbeddingDimensionError extends EmbeddingError {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number, model: string) {
    super(
      `Embedding model ${model} returned a ${actual}-dimension vector; expected ${expected}`,
    );
    this.expected = expected;
    this.actual = actual;
  }
}

export interface WorkersAiEmbedderOptions {
  /** Override the model id (default bge-m3). Dimensions stay 1024 regardless. */
  model?: string;
  /** Override the per-call batch size (default 50). */
  batchSize?: number;
}

/**
 * Workers AI bge-m3 multi-input response: `{ data: number[][] }`, with
 * extra keys such as `shape` tolerated.
 */
function parseEmbeddingResponse(model: string, raw: unknown): number[][] {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    throw new AiResponseError(model, "expected an object with a `data` array");
  }
  const vectors: number[][] = [];
  for (const item of raw.data) {
    if (!isNumberArray(item)) {
      throw new AiResponseError(model, "`data` must contain arrays of numbers");
    }
    vectors.push(item);
  }
  return vectors;
}

/**
 * The production `EmbeddingProvider`. Splits input into batches of
 * {@link EMBEDDING_BATCH_SIZE}, preserves order, and validates the response
 * shape, the vector count, and every vector's dimensionality.
 */
export function createWorkersAiEmbedder(
  ai: WorkersAiBinding,
  options: WorkersAiEmbedderOptions = {},
): EmbeddingProvider {
  const model = options.model ?? BGE_M3_EMBEDDING_MODEL;
  const batchSize = options.batchSize ?? EMBEDDING_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(
      `batchSize must be a positive integer (got ${batchSize})`,
    );
  }
  return {
    model,
    async embed(texts: string[]): Promise<number[][]> {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        const raw = await ai.run(model, { text: batch });
        const parsed = parseEmbeddingResponse(model, raw);
        if (parsed.length !== batch.length) {
          throw new AiResponseError(
            model,
            `${parsed.length} vectors for ${batch.length} inputs; order can no longer be trusted`,
          );
        }
        for (const vector of parsed) {
          if (vector.length !== EMBEDDING_DIMENSIONS) {
            throw new EmbeddingDimensionError(
              EMBEDDING_DIMENSIONS,
              vector.length,
              model,
            );
          }
          vectors.push(vector);
        }
      }
      return vectors;
    },
    async embedText(text: string): Promise<number[]> {
      const [vector] = await this.embed([text]);
      // embed() validated count and dimensions; one input yields one vector.
      return vector as number[];
    },
  };
}

/** Model id stamped by the fake; never a real Workers AI model. */
export const FAKE_EMBEDDING_MODEL = "fake-bge-m3";

/**
 * FNV-1a 32-bit: a tiny, stable string hash. Not cryptographic; it only
 * needs to spread tokens across dimensions deterministically.
 */
function fnv1a(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * English function words the fake ignores. Without this, two unrelated
 * sentences score ~0.3 on "the", "and", "was" alone, which squashes the
 * gap retrieval fixtures depend on. Deliberately short: it is a test
 * double, not a tokenizer.
 */
const FAKE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "his",
  "i",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "she",
  "so",
  "that",
  "the",
  "their",
  "them",
  "they",
  "this",
  "to",
  "was",
  "we",
  "were",
  "with",
  "you",
  "your",
]);

/**
 * One deterministic unit vector. Lowercase word tokens (letters, digits,
 * apostrophes) minus {@link FAKE_STOP_WORDS} are each hashed onto one of
 * the 1024 dimensions and counted, then the vector is L2-normalized so
 * cosine similarity is a dot product. Texts that share content words share
 * dimensions, which is what makes paraphrase-ish fixtures land nearer than
 * unrelated ones. Throws on token-free text: callers skip empty text, they
 * do not embed it.
 */
function fakeVector(text: string): number[] {
  const allTokens = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  if (allTokens.length === 0) {
    throw new EmbeddingError(
      "fakeEmbed: empty text; callers must skip embedding empty text, not embed it",
    );
  }
  // Drop function words so shared vocabulary means shared topic, not a
  // shared "the"; fall back to every token when nothing else is left.
  const contentTokens = allTokens.filter(
    (token) => !FAKE_STOP_WORDS.has(token),
  );
  const tokens = contentTokens.length > 0 ? contentTokens : allTokens;
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const token of tokens) {
    const dimension = fnv1a(token) % EMBEDDING_DIMENSIONS;
    vector[dimension] = (vector[dimension] ?? 0) + 1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  return vector.map((value) => value / norm);
}

/**
 * Deterministic, order-preserving, unit-norm embeddings for `texts`: the
 * same function `FakeEmbeddingProvider` uses, exported so tests and the
 * seed can build query vectors that are genuinely near a fake-embedded row.
 */
export function fakeEmbed(texts: string[]): number[][] {
  return texts.map(fakeVector);
}

export interface FakeEmbeddingProviderOptions {
  /**
   * Failure injection: called before each `embed`/`embedText`; a returned
   * error is thrown instead of embedding (for example, fail call #2 to
   * test a retry path).
   */
  shouldFail?: (call: { index: number; texts: string[] }) => Error | undefined;
}

/**
 * The injectable test double. Records every call, embeds via
 * {@link fakeEmbed}, rejects token-free text.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model = FAKE_EMBEDDING_MODEL;
  /** Every embed()/embedText() invocation's texts, in order. */
  readonly calls: string[][] = [];

  readonly #shouldFail: FakeEmbeddingProviderOptions["shouldFail"];

  constructor(options: FakeEmbeddingProviderOptions = {}) {
    this.#shouldFail = options.shouldFail;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const index = this.calls.length;
    this.calls.push([...texts]);
    const failure = this.#shouldFail?.({ index, texts });
    if (failure) throw failure;
    return fakeEmbed(texts);
  }

  async embedText(text: string): Promise<number[]> {
    const [vector] = await this.embed([text]);
    return vector as number[];
  }
}
