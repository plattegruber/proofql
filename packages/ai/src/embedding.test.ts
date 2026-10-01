import { describe, expect, it } from "vitest";

import {
  createWorkersAiEmbedder,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  EmbeddingDimensionError,
  EmbeddingError,
  FakeEmbeddingProvider,
  fakeEmbed,
} from "./embedding.js";
import { cosineSimilarity } from "./vector.js";
import { AiResponseError, type WorkersAiBinding } from "./workersAi.js";

describe("FakeEmbeddingProvider", () => {
  const provider = new FakeEmbeddingProvider();

  it("returns a unit vector of the bge-m3 dimensionality", async () => {
    const vector = await provider.embedText("The team was gentle and kind.");
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it("is deterministic across calls and across provider instances", async () => {
    const text =
      "Dr. Patel did my implant and I forgot it wasn't my own tooth.";
    const first = await provider.embedText(text);
    const second = await provider.embedText(text);
    const other = await new FakeEmbeddingProvider().embedText(text);
    expect(first).toEqual(second);
    expect(first).toEqual(other);
    expect(fakeEmbed([text])[0]).toEqual(first);
  });

  it("pins a known vector so the hash cannot drift silently", () => {
    // Fixtures downstream (search tests, seed) rely on this exact mapping.
    const [vector] = fakeEmbed(["parking"]);
    const nonZero = (vector ?? [])
      .map((value, index) => [index, value] as const)
      .filter(([, value]) => value !== 0);
    expect(nonZero).toEqual([[103, 1]]);
  });

  it("scores near-copies high and unrelated text low", async () => {
    const original =
      "Dr. Patel was wonderful with my daughter. She actually looks " +
      "forward to the dentist now and asks when we can go back.";
    const nearCopy =
      "Dr. Patel was wonderful with my daughter - she looks forward to " +
      "the dentist now and asks when we can go back!";
    const unrelated =
      "Billing was a mess for months and nobody at the front desk could " +
      "explain the insurance charges on my statement.";

    const [a, b, c] = await Promise.all([
      provider.embedText(original),
      provider.embedText(nearCopy),
      provider.embedText(unrelated),
    ]);
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.92);
    expect(cosineSimilarity(a, c)).toBeLessThan(0.5);
  });

  it("puts a shared-vocabulary paraphrase nearer than an unrelated text (retrieval fidelity)", () => {
    const [excerpt, paraphrase, unrelated] = fakeEmbed([
      "The implant consult was thorough and they explained every option for the implant.",
      "thorough implant consult, explained the options",
      "Parking out front was easy and the lot was never full.",
    ]);
    const near = cosineSimilarity(paraphrase ?? [], excerpt ?? []);
    const far = cosineSimilarity(unrelated ?? [], excerpt ?? []);
    expect(near).toBeGreaterThan(far);
    expect(near).toBeGreaterThan(0.6);
    expect(far).toBeLessThan(0.1);
  });

  it("ignores function words so a shared 'the' is not a shared topic", () => {
    const [bare, wrapped, stopOnly, stopOnly2] = fakeEmbed([
      "dentist",
      "the dentist and I",
      "it was the",
      "it was the",
    ]);
    expect(cosineSimilarity(bare ?? [], wrapped ?? [])).toBeCloseTo(1, 10);
    // Text made only of function words still embeds (deterministically) rather than throwing.
    expect(stopOnly).toEqual(stopOnly2);
    expect(stopOnly?.some((value) => value !== 0)).toBe(true);
  });

  it("is case-insensitive and ignores punctuation", () => {
    const [a, b] = fakeEmbed(["GREAT dentist!!!", "great, dentist"]);
    expect(cosineSimilarity(a ?? [], b ?? [])).toBeCloseTo(1, 10);
  });

  it("rejects empty text; callers skip, not embed, the void", async () => {
    await expect(provider.embedText("   ")).rejects.toThrow(EmbeddingError);
    await expect(provider.embedText("   ")).rejects.toThrow(/empty text/);
  });

  it("records calls and supports failure injection", async () => {
    const boom = new Error("embedding service down");
    const failing = new FakeEmbeddingProvider({
      shouldFail: ({ index }) => (index === 1 ? boom : undefined),
    });
    await expect(failing.embed(["a"])).resolves.toHaveLength(1);
    await expect(failing.embed(["b"])).rejects.toThrow(boom);
    await expect(failing.embed(["c"])).resolves.toHaveLength(1);
    expect(failing.calls).toEqual([["a"], ["b"], ["c"]]);
    expect(failing.model).toBe("fake-bge-m3");
  });
});

/** A fake AI binding that echoes recognizable vectors per input. */
function fakeBinding(
  vectorFor: (text: string) => number[],
): WorkersAiBinding & { calls: string[][]; models: string[] } {
  const calls: string[][] = [];
  const models: string[] = [];
  return {
    calls,
    models,
    run: async (model, inputs) => {
      const text = inputs.text as string[];
      models.push(model);
      calls.push([...text]);
      return {
        data: text.map(vectorFor),
        shape: [text.length, EMBEDDING_DIMENSIONS],
      };
    },
  };
}

/** A valid vector whose first component tags the input it embeds. */
function taggedVector(tag: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = tag;
  return vector;
}

describe("createWorkersAiEmbedder", () => {
  it("batches 123 texts into calls of at most 50 and preserves order", async () => {
    const texts = Array.from({ length: 123 }, (_, index) => `text-${index}`);
    const binding = fakeBinding((text) =>
      taggedVector(Number(text.split("-")[1])),
    );
    const embedder = createWorkersAiEmbedder(binding);

    const vectors = await embedder.embed(texts);

    expect(EMBEDDING_BATCH_SIZE).toBe(50);
    expect(binding.calls.map((call) => call.length)).toEqual([50, 50, 23]);
    expect(binding.calls.flat()).toEqual(texts);
    expect(vectors).toHaveLength(123);
    vectors.forEach((vector, index) => {
      expect(vector[0]).toBe(index);
    });
  });

  it("makes exactly one call for a batch-sized input and none for an empty one", async () => {
    const binding = fakeBinding(() => taggedVector(1));
    const embedder = createWorkersAiEmbedder(binding);
    await embedder.embed(Array.from({ length: 50 }, (_, i) => `t${i}`));
    expect(binding.calls).toHaveLength(1);
    await expect(embedder.embed([])).resolves.toEqual([]);
    expect(binding.calls).toHaveLength(1);
  });

  it("honours a custom batch size", async () => {
    const binding = fakeBinding(() => taggedVector(1));
    const embedder = createWorkersAiEmbedder(binding, { batchSize: 2 });
    await embedder.embed(["a", "b", "c"]);
    expect(binding.calls).toEqual([["a", "b"], ["c"]]);
    expect(() => createWorkersAiEmbedder(binding, { batchSize: 0 })).toThrow(
      RangeError,
    );
  });

  it("embedText delegates to the batch primitive and unwraps one vector", async () => {
    const binding = fakeBinding(() => taggedVector(7));
    const embedder = createWorkersAiEmbedder(binding);
    const vector = await embedder.embedText("hello");
    expect(vector[0]).toBe(7);
    expect(binding.calls).toEqual([["hello"]]);
  });

  it("throws EmbeddingDimensionError on a wrong-dimensional vector", async () => {
    const embedder = createWorkersAiEmbedder(
      fakeBinding(() => [0.1, 0.2, 0.3]),
    );
    const failure = embedder.embed(["hello"]);
    await expect(failure).rejects.toThrow(EmbeddingDimensionError);
    await expect(failure).rejects.toThrow(EmbeddingError);
    await expect(failure).rejects.toMatchObject({ expected: 1024, actual: 3 });
    await expect(failure).rejects.toThrow(/3-dimension vector; expected 1024/);
  });

  it("rejects a vector that is one dimension off in either direction", async () => {
    for (const length of [EMBEDDING_DIMENSIONS - 1, EMBEDDING_DIMENSIONS + 1]) {
      const embedder = createWorkersAiEmbedder(
        fakeBinding(() => new Array<number>(length).fill(0)),
      );
      await expect(embedder.embed(["hello"])).rejects.toThrow(
        EmbeddingDimensionError,
      );
    }
  });

  it("throws AiResponseError on an unexpected response shape", async () => {
    for (const raw of [
      { embeddings: [[1, 2]] },
      { data: "nope" },
      { data: [["a", "b"]] },
      null,
      [[1, 2, 3]],
    ]) {
      const embedder = createWorkersAiEmbedder({ run: async () => raw });
      await expect(embedder.embed(["hello"])).rejects.toThrow(AiResponseError);
    }
  });

  it("throws AiResponseError when the vector count disagrees with the input count", async () => {
    const embedder = createWorkersAiEmbedder({
      run: async () => ({ data: [taggedVector(1)] }),
    });
    await expect(embedder.embed(["a", "b"])).rejects.toThrow(AiResponseError);
    await expect(embedder.embed(["a", "b"])).rejects.toThrow(
      /1 vectors for 2 inputs/,
    );
  });

  it("stamps and calls the bge-m3 model id by default, honouring an override", async () => {
    const binding = fakeBinding(() => taggedVector(0));
    const embedder = createWorkersAiEmbedder(binding);
    expect(embedder.model).toBe("@cf/baai/bge-m3");
    await embedder.embedText("x");
    expect(binding.models).toEqual(["@cf/baai/bge-m3"]);

    const custom = createWorkersAiEmbedder(binding, {
      model: "@cf/other/model",
    });
    expect(custom.model).toBe("@cf/other/model");
    await custom.embedText("x");
    expect(binding.models.at(-1)).toBe("@cf/other/model");
  });
});
