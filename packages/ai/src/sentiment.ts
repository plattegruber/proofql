/**
 * The sentiment seam. The publication policy is rating-based; the
 * classifier only fills `sentiment` for reviews whose source carries no
 * star rating (docs/scope.md §2). Production is {@link createWorkersAiSentimentClassifier}
 * over `@cf/huggingface/distilbert-sst-2-int8`; tests use
 * {@link FakeSentimentClassifier}, a deterministic lexicon lookup.
 *
 * SST-2 is a two-class model, so its top score is always at least 0.5. A
 * result whose confidence falls below {@link SentimentClassifierOptions.neutralThreshold}
 * is reported as `neutral` rather than guessed; the policy treats neutral
 * as publishable (`sentiment <> 'negative'`), so the threshold is the
 * dial between "hide when unsure" (high) and "show when unsure" (low).
 */

import {
  AiProviderError,
  AiResponseError,
  isRecord,
  type WorkersAiBinding,
} from "./workersAi.js";

export type Sentiment = "positive" | "negative" | "neutral";

export interface SentimentResult {
  sentiment: Sentiment;
  /**
   * The model's confidence in its top label, in [0, 1]. Kept even when the
   * result is `neutral`, so callers can log or re-threshold.
   */
  confidence: number;
}

export interface SentimentClassifier {
  readonly model: string;
  classify(text: string): Promise<SentimentResult>;
}

/** The Workers AI model id. */
export const DISTILBERT_SST2_MODEL = "@cf/huggingface/distilbert-sst-2-int8";

/** Below this top-label confidence the classifier answers `neutral`. */
export const DEFAULT_NEUTRAL_THRESHOLD = 0.6;

export class SentimentError extends AiProviderError {}

export interface SentimentClassifierOptions {
  /** Confidence below which the result is `neutral` (default 0.6). */
  neutralThreshold?: number;
}

function resolveThreshold(options: SentimentClassifierOptions): number {
  const threshold = options.neutralThreshold ?? DEFAULT_NEUTRAL_THRESHOLD;
  if (!(threshold >= 0 && threshold <= 1)) {
    throw new RangeError(
      `neutralThreshold must be within [0, 1] (got ${threshold})`,
    );
  }
  return threshold;
}

/**
 * Collapse a labeled score into the public result: the top label wins
 * unless its confidence is under the threshold, in which case `neutral`.
 */
export function toSentimentResult(
  label: "positive" | "negative",
  confidence: number,
  neutralThreshold: number,
): SentimentResult {
  return {
    sentiment: confidence < neutralThreshold ? "neutral" : label,
    confidence,
  };
}

export interface WorkersAiSentimentClassifierOptions
  extends SentimentClassifierOptions {
  /** Override the model id (default distilbert-sst-2-int8). */
  model?: string;
}

/**
 * Workers AI text-classification response:
 * `[{ label: "POSITIVE" | "NEGATIVE", score: number }, ...]`.
 * Returns the top-scoring label and its score.
 */
function parseClassificationResponse(
  model: string,
  raw: unknown,
): { label: "positive" | "negative"; score: number } {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AiResponseError(
      model,
      "expected a non-empty array of { label, score }",
    );
  }
  let best: { label: "positive" | "negative"; score: number } | undefined;
  for (const item of raw) {
    if (
      !isRecord(item) ||
      typeof item.label !== "string" ||
      typeof item.score !== "number" ||
      !Number.isFinite(item.score)
    ) {
      throw new AiResponseError(
        model,
        "each entry must be { label: string, score: number }",
      );
    }
    const label = item.label.toLowerCase();
    if (label !== "positive" && label !== "negative") {
      throw new AiResponseError(model, `unknown label "${item.label}"`);
    }
    if (best === undefined || item.score > best.score) {
      best = { label, score: item.score };
    }
  }
  return best as { label: "positive" | "negative"; score: number };
}

/** The production `SentimentClassifier` over a Workers AI binding. */
export function createWorkersAiSentimentClassifier(
  ai: WorkersAiBinding,
  options: WorkersAiSentimentClassifierOptions = {},
): SentimentClassifier {
  const model = options.model ?? DISTILBERT_SST2_MODEL;
  const neutralThreshold = resolveThreshold(options);
  return {
    model,
    async classify(text: string): Promise<SentimentResult> {
      if (text.trim().length === 0) {
        throw new SentimentError(
          "classify: empty text; callers must skip empty text",
        );
      }
      const raw = await ai.run(model, { text });
      const { label, score } = parseClassificationResponse(model, raw);
      return toSentimentResult(label, score, neutralThreshold);
    },
  };
}

/** Model id stamped by the fake; never a real Workers AI model. */
export const FAKE_SENTIMENT_MODEL = "fake-distilbert-sst-2";

const POSITIVE_WORDS = new Set([
  "amazing",
  "best",
  "excellent",
  "fantastic",
  "friendly",
  "gentle",
  "good",
  "great",
  "happy",
  "helpful",
  "kind",
  "love",
  "loved",
  "painless",
  "perfect",
  "professional",
  "recommend",
  "wonderful",
]);

const NEGATIVE_WORDS = new Set([
  "awful",
  "bad",
  "confusing",
  "disappointed",
  "disappointing",
  "horrible",
  "mess",
  "never",
  "overpriced",
  "painful",
  "poor",
  "rude",
  "slow",
  "terrible",
  "unprofessional",
  "waste",
  "worst",
  "wrong",
]);

/**
 * Deterministic lexicon scoring, shaped like SST-2's output: the top
 * label's share of the opinion words found, so one-sided text scores 1.0,
 * a 2:1 split scores 0.67, and text with no opinion words scores 0.5
 * (always neutral). Exported so tests can predict the fake's answer.
 */
export function fakeSentiment(
  text: string,
  neutralThreshold: number = DEFAULT_NEUTRAL_THRESHOLD,
): SentimentResult {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  let positive = 0;
  let negative = 0;
  for (const token of tokens) {
    if (POSITIVE_WORDS.has(token)) positive++;
    else if (NEGATIVE_WORDS.has(token)) negative++;
  }
  const total = positive + negative;
  if (total === 0 || positive === negative) {
    return { sentiment: "neutral", confidence: 0.5 };
  }
  const label = positive > negative ? "positive" : "negative";
  return toSentimentResult(
    label,
    Math.max(positive, negative) / total,
    neutralThreshold,
  );
}

/** The injectable test double: records calls, scores via {@link fakeSentiment}. */
export class FakeSentimentClassifier implements SentimentClassifier {
  readonly model = FAKE_SENTIMENT_MODEL;
  /** Every classify() invocation's text, in order. */
  readonly calls: string[] = [];

  readonly #neutralThreshold: number;

  constructor(options: SentimentClassifierOptions = {}) {
    this.#neutralThreshold = resolveThreshold(options);
  }

  async classify(text: string): Promise<SentimentResult> {
    this.calls.push(text);
    return fakeSentiment(text, this.#neutralThreshold);
  }
}
