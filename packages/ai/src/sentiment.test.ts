import { describe, expect, it } from "vitest";

import {
  createWorkersAiSentimentClassifier,
  DEFAULT_NEUTRAL_THRESHOLD,
  FakeSentimentClassifier,
  fakeSentiment,
  SentimentError,
  toSentimentResult,
} from "./sentiment.js";
import { AiResponseError, type WorkersAiBinding } from "./workersAi.js";

/** A binding that answers SST-2 style for every input. */
function sst2Binding(positive: number): WorkersAiBinding & {
  calls: { model: string; inputs: Record<string, unknown> }[];
} {
  const calls: { model: string; inputs: Record<string, unknown> }[] = [];
  return {
    calls,
    run: async (model, inputs) => {
      calls.push({ model, inputs });
      return [
        { label: "NEGATIVE", score: 1 - positive },
        { label: "POSITIVE", score: positive },
      ];
    },
  };
}

describe("toSentimentResult", () => {
  it("keeps the label at or above the threshold and neutralises below it", () => {
    expect(toSentimentResult("positive", 0.9, 0.6)).toEqual({
      sentiment: "positive",
      confidence: 0.9,
    });
    expect(toSentimentResult("negative", 0.6, 0.6)).toEqual({
      sentiment: "negative",
      confidence: 0.6,
    });
    expect(toSentimentResult("negative", 0.59, 0.6)).toEqual({
      sentiment: "neutral",
      confidence: 0.59,
    });
  });
});

describe("createWorkersAiSentimentClassifier", () => {
  it("maps the top SST-2 label to positive with its confidence", async () => {
    const binding = sst2Binding(0.97);
    const classifier = createWorkersAiSentimentClassifier(binding);
    await expect(
      classifier.classify("Gentle, thorough, and on time."),
    ).resolves.toEqual({
      sentiment: "positive",
      confidence: 0.97,
    });
    expect(classifier.model).toBe("@cf/huggingface/distilbert-sst-2-int8");
    expect(binding.calls).toEqual([
      {
        model: "@cf/huggingface/distilbert-sst-2-int8",
        inputs: { text: "Gentle, thorough, and on time." },
      },
    ]);
  });

  it("maps the top SST-2 label to negative, case-insensitively", async () => {
    const classifier = createWorkersAiSentimentClassifier({
      run: async () => [
        { label: "positive", score: 0.08 },
        { label: "negative", score: 0.92 },
      ],
    });
    await expect(classifier.classify("Waste of money.")).resolves.toEqual({
      sentiment: "negative",
      confidence: 0.92,
    });
  });

  it("answers neutral below the default threshold and honours a custom one", async () => {
    expect(DEFAULT_NEUTRAL_THRESHOLD).toBe(0.6);
    const unsure = sst2Binding(0.55);
    await expect(
      createWorkersAiSentimentClassifier(unsure).classify("It was fine."),
    ).resolves.toEqual({ sentiment: "neutral", confidence: 0.55 });

    const strict = createWorkersAiSentimentClassifier(sst2Binding(0.8), {
      neutralThreshold: 0.9,
    });
    await expect(strict.classify("Pretty good")).resolves.toEqual({
      sentiment: "neutral",
      confidence: 0.8,
    });

    const lenient = createWorkersAiSentimentClassifier(sst2Binding(0.55), {
      neutralThreshold: 0.5,
    });
    await expect(lenient.classify("It was fine.")).resolves.toEqual({
      sentiment: "positive",
      confidence: 0.55,
    });
  });

  it("rejects an out-of-range threshold", () => {
    expect(() =>
      createWorkersAiSentimentClassifier(sst2Binding(0.9), {
        neutralThreshold: 1.5,
      }),
    ).toThrow(RangeError);
  });

  it("rejects empty text", async () => {
    const classifier = createWorkersAiSentimentClassifier(sst2Binding(0.9));
    await expect(classifier.classify("  ")).rejects.toThrow(SentimentError);
  });

  it("throws AiResponseError on an unexpected response shape or label", async () => {
    for (const raw of [
      null,
      [],
      { label: "POSITIVE", score: 0.9 },
      [{ label: "POSITIVE" }],
      [{ label: "MIXED", score: 0.9 }],
    ]) {
      const classifier = createWorkersAiSentimentClassifier({
        run: async () => raw,
      });
      await expect(classifier.classify("hello")).rejects.toThrow(
        AiResponseError,
      );
    }
  });
});

describe("FakeSentimentClassifier", () => {
  it("is deterministic and keyword-driven", async () => {
    const classifier = new FakeSentimentClassifier();
    const text = "Wonderful, gentle staff. Highly recommend.";
    const first = await classifier.classify(text);
    expect(first).toEqual({ sentiment: "positive", confidence: 1 });
    expect(await classifier.classify(text)).toEqual(first);
    expect(fakeSentiment(text)).toEqual(first);
    expect(classifier.calls).toEqual([text, text]);
    expect(classifier.model).toBe("fake-distilbert-sst-2");
  });

  it("scores negative text negative and opinion-free text neutral", async () => {
    const classifier = new FakeSentimentClassifier();
    await expect(
      classifier.classify("Rude front desk and a terrible billing mess."),
    ).resolves.toEqual({ sentiment: "negative", confidence: 1 });
    await expect(
      classifier.classify("The office is on Main Street."),
    ).resolves.toEqual({
      sentiment: "neutral",
      confidence: 0.5,
    });
    await expect(
      classifier.classify("Great dentist, terrible parking."),
    ).resolves.toEqual({
      sentiment: "neutral",
      confidence: 0.5,
    });
  });

  it("applies the neutral threshold to mixed text", async () => {
    const mixed = "Great, friendly dentist but the billing was a mess.";
    expect(fakeSentiment(mixed).confidence).toBeCloseTo(2 / 3, 10);
    await expect(
      new FakeSentimentClassifier().classify(mixed),
    ).resolves.toMatchObject({
      sentiment: "positive",
    });
    await expect(
      new FakeSentimentClassifier({ neutralThreshold: 0.75 }).classify(mixed),
    ).resolves.toMatchObject({ sentiment: "neutral" });
  });
});
