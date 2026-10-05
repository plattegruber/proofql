import type { SearchResult } from "@proofql/db";
import { describe, expect, it } from "vitest";

import {
  applyRerank,
  DEFAULT_RERANK_THRESHOLD,
  passesFloor,
  rerankConfig,
} from "./rerank.js";

function row(id: string, similarity: number, lexical = false): SearchResult {
  return { reviewId: id, similarity, lexical } as SearchResult;
}

describe("rerankConfig", () => {
  it("is off unless RERANK is exactly 'true'", () => {
    expect(rerankConfig({})).toBeNull();
    expect(rerankConfig({ RERANK: "1" })).toBeNull();
    expect(rerankConfig({ RERANK: "true" })).toEqual({
      threshold: DEFAULT_RERANK_THRESHOLD,
    });
  });

  it("reads the threshold and refuses one outside [0, 1]", () => {
    expect(rerankConfig({ RERANK: "true", RERANK_THRESHOLD: "0.2" })).toEqual({
      threshold: 0.2,
    });
    expect(
      rerankConfig({ RERANK: "true", RERANK_THRESHOLD: "1.5" }),
    ).toBeNull();
    expect(
      rerankConfig({ RERANK: "true", RERANK_THRESHOLD: "nope" }),
    ).toBeNull();
  });
});

describe("applyRerank", () => {
  it("orders by score, keeps fused order on ties, drops under the threshold, and cuts to limit", () => {
    const rows = [row("a", 0.7), row("b", 0.6), row("c", 0.5), row("d", 0.4)];
    const out = applyRerank(rows, [0.3, 0.9, 0.3, 0.1], 0.2, 2);
    expect(out.rows.map((r) => r.reviewId)).toEqual(["b", "a"]);
    expect(out.scores).toEqual([0.9, 0.3]);
  });
});

describe("passesFloor", () => {
  it("applies the two-tier floor", () => {
    expect(passesFloor(row("a", 0.66), 0.66)).toBe(true);
    expect(passesFloor(row("a", 0.6), 0.66)).toBe(false);
    expect(passesFloor(row("a", 0.6, true), 0.66)).toBe(true);
    expect(passesFloor(row("a", 0.5, true), 0.66)).toBe(false);
  });
});
