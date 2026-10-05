import { describe, expect, it } from "vitest";

import {
  BGE_RERANKER_BASE_MODEL,
  createWorkersAiReranker,
  FakeReranker,
  fakeRerankScore,
  RerankError,
} from "./rerank.js";
import { AiResponseError } from "./workersAi.js";

describe("createWorkersAiReranker", () => {
  it("sends query + contexts and returns scores in passage order", async () => {
    const calls: unknown[] = [];
    const reranker = createWorkersAiReranker({
      run: async (model, inputs) => {
        calls.push({ model, inputs });
        return {
          response: [
            { id: 1, score: 0.9 },
            { id: 0, score: 0.1 },
          ],
        };
      },
    });
    await expect(reranker.rerank("implants", ["a", "b"])).resolves.toEqual([
      0.1, 0.9,
    ]);
    expect(calls).toEqual([
      {
        model: BGE_RERANKER_BASE_MODEL,
        inputs: {
          query: "implants",
          contexts: [{ text: "a" }, { text: "b" }],
          top_k: 2,
        },
      },
    ]);
  });

  it("makes no call for no passages", async () => {
    const reranker = createWorkersAiReranker({
      run: async () => {
        throw new Error("called");
      },
    });
    await expect(reranker.rerank("q", [])).resolves.toEqual([]);
  });

  it("rejects a malformed or incomplete response", async () => {
    const short = createWorkersAiReranker({
      run: async () => ({ response: [{ id: 0, score: 0.5 }] }),
    });
    await expect(short.rerank("q", ["a", "b"])).rejects.toBeInstanceOf(
      AiResponseError,
    );
    const bad = createWorkersAiReranker({ run: async () => [0.5] });
    await expect(bad.rerank("q", ["a"])).rejects.toBeInstanceOf(
      AiResponseError,
    );
  });

  it("refuses an empty query", async () => {
    const reranker = createWorkersAiReranker({ run: async () => ({}) });
    await expect(reranker.rerank(" ", ["a"])).rejects.toBeInstanceOf(
      RerankError,
    );
  });
});

describe("FakeReranker", () => {
  it("scores by the share of query words in the passage", async () => {
    expect(fakeRerankScore("dental implants", "my implants")).toBe(0.5);
    const fake = new FakeReranker();
    await expect(
      fake.rerank("dental implants", ["dental implants", "parking"]),
    ).resolves.toEqual([1, 0]);
    expect(fake.calls).toHaveLength(1);
  });

  it("fails on demand", async () => {
    await expect(
      new FakeReranker({ shouldFail: true }).rerank("q", ["a"]),
    ).rejects.toBeInstanceOf(RerankError);
  });
});
