import { describe, expect, it } from "vitest";

import * as ai from "./index.js";

describe("@proofql/ai public surface", () => {
  it("exports the providers, fakes, and helpers the pipeline and tests depend on", () => {
    expect(typeof ai.createWorkersAiEmbedder).toBe("function");
    expect(typeof ai.FakeEmbeddingProvider).toBe("function");
    expect(typeof ai.fakeEmbed).toBe("function");
    expect(typeof ai.createWorkersAiSentimentClassifier).toBe("function");
    expect(typeof ai.FakeSentimentClassifier).toBe("function");
    expect(typeof ai.cosineSimilarity).toBe("function");
    expect(ai.EMBEDDING_DIMENSIONS).toBe(1024);
    expect(ai.EMBEDDING_BATCH_SIZE).toBe(50);
  });
});
