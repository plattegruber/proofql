import { describe, expect, it } from "vitest";

import { BUDGET_BYTES, checkBudget, gzippedSize } from "../scripts/size.mjs";

describe("size budget helpers", () => {
  it("has a 5 KB budget", () => {
    expect(BUDGET_BYTES).toBe(5120);
  });

  it("measures gzip output, which is smaller than the input for text", () => {
    const source = Buffer.from("function f(){return 1}".repeat(200));
    const size = gzippedSize(source);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(source.length);
    expect(gzippedSize(Buffer.alloc(0))).toBeGreaterThan(0); // gzip header
  });

  it("passes at or under budget and fails over it, with a readable message", () => {
    expect(checkBudget(5120, 5120)).toMatchObject({
      ok: true,
      bytes: 5120,
      budget: 5120,
    });
    expect(checkBudget(1024, 5120).message).toBe(
      "dist/v1.js: 1,024 B gzipped, 20.0% of the 5,120 B budget",
    );
    const over = checkBudget(5121, 5120);
    expect(over.ok).toBe(false);
    expect(over.message).toBe(
      "dist/v1.js is 5,121 B gzipped, over the 5,120 B budget by 1 B",
    );
  });

  it("defaults the budget", () => {
    expect(checkBudget(100).budget).toBe(BUDGET_BYTES);
  });
});
