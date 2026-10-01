import { describe, expect, it } from "vitest";

import { chunked, QUEUE_SEND_BATCH_MAX } from "./sweep.js";

describe("chunked", () => {
  it("splits into consecutive slices of at most `size`, in order", () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunked([1, 2], 2)).toEqual([[1, 2]]);
    expect(chunked([], 3)).toEqual([]);
  });

  it("never exceeds the Queues sendBatch maximum", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const batches = chunked(items, QUEUE_SEND_BATCH_MAX);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(items);
  });
});
