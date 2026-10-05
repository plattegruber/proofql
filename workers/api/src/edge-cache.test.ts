/**
 * The pieces under the api's caches (#158): the workers.dev detection that
 * decides between the Cache API and KV, the KV write budget, the
 * generation memo, and the bounded map they share.
 */

import { describe, expect, it } from "vitest";

import {
  EDGE_CACHE_PATH,
  edgeCacheUrl,
  GenerationMemo,
  isWorkersDevHost,
  LruTtl,
  MissCounter,
} from "./edge-cache.js";

describe("isWorkersDevHost", () => {
  it("recognizes *.workers.dev, where Cache API puts are no-ops", () => {
    expect(
      isWorkersDevHost("proofql-api-preview.gruberplatte.workers.dev"),
    ).toBe(true);
    expect(isWorkersDevHost("PROOFQL-API.X.WORKERS.DEV")).toBe(true);
  });

  it("treats custom domains and localhost as Cache-API capable", () => {
    expect(isWorkersDevHost("api.proofql.com")).toBe(false);
    expect(isWorkersDevHost("workers.dev.example.com")).toBe(false);
    expect(isWorkersDevHost("localhost")).toBe(false);
  });
});

describe("edgeCacheUrl", () => {
  it("keys under the reserved path on the request's own origin", () => {
    expect(
      edgeCacheUrl(
        "https://api.proofql.com/v1/query?q=x",
        "q",
        "q:p:live:3:ab",
      ),
    ).toBe(`https://api.proofql.com${EDGE_CACHE_PATH}q/q%3Ap%3Alive%3A3%3Aab`);
  });
});

describe("LruTtl", () => {
  it("expires by age and evicts the least recently used past its bound", () => {
    let clock = 0;
    const lru = new LruTtl<number>(2, () => clock);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a", 100)?.value).toBe(1); // a is now most recent
    lru.set("c", 3);
    expect(lru.get("b", 100)).toBeUndefined();
    expect(lru.get("a", 100)?.value).toBe(1);
    clock = 100;
    expect(lru.get("a", 100)).toBeUndefined();
    expect(lru.size).toBe(1);
  });
});

describe("MissCounter (the KV write budget)", () => {
  it("writes on the second MISS within the window, never on the first", () => {
    let clock = 0;
    const counter = new MissCounter({ windowMs: 1_000, now: () => clock });
    expect(counter.recordMiss("k")).toBe(false);
    clock = 500;
    expect(counter.recordMiss("k")).toBe(true);
    // Written: the count starts over.
    expect(counter.recordMiss("k")).toBe(false);
  });

  it("a second MISS after the window is a first MISS again", () => {
    let clock = 0;
    const counter = new MissCounter({ windowMs: 1_000, now: () => clock });
    expect(counter.recordMiss("k")).toBe(false);
    clock = 999;
    // The window runs from the first MISS, not the latest.
    expect(counter.recordMiss("other")).toBe(false);
    clock = 1_000;
    expect(counter.recordMiss("k")).toBe(false);
    clock = 1_500;
    expect(counter.recordMiss("k")).toBe(true);
  });

  it("one-off queries never write; threshold 1 always writes", () => {
    const counter = new MissCounter({ windowMs: 1_000 });
    const writes = Array.from({ length: 100 }, (_, i) =>
      counter.recordMiss(`q${i}`),
    ).filter(Boolean);
    expect(writes).toHaveLength(0);
    const eager = new MissCounter({ windowMs: 1_000, threshold: 1 });
    expect(eager.recordMiss("k")).toBe(true);
  });
});

describe("GenerationMemo", () => {
  it("remembers a generation for its TTL", () => {
    let clock = 0;
    const memo = new GenerationMemo(10_000, () => clock);
    memo.set("p", 4);
    expect(memo.get("p")).toBe(4);
    clock = 10_000;
    expect(memo.get("p")).toBeUndefined();
  });

  it("is off at 0 ms (tests read KV every time)", () => {
    const memo = new GenerationMemo(0);
    memo.set("p", 4);
    expect(memo.get("p")).toBeUndefined();
  });
});
