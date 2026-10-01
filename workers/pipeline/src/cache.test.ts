import { describe, expect, it } from "vitest";

import {
  bumpProjectGeneration,
  generationKey,
  MemoryKv,
  parseGeneration,
} from "./cache.js";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

describe("bumpProjectGeneration", () => {
  it("writes gen:<projectId> = 1 when the key is absent", async () => {
    const kv = new MemoryKv();

    await expect(bumpProjectGeneration(kv, PROJECT_ID)).resolves.toBe(1);

    expect(generationKey(PROJECT_ID)).toBe(`gen:${PROJECT_ID}`);
    expect(await kv.get(`gen:${PROJECT_ID}`)).toBe("1");
  });

  it("increments the stored integer string", async () => {
    const kv = new MemoryKv();
    await kv.put(`gen:${PROJECT_ID}`, "41");

    await expect(bumpProjectGeneration(kv, PROJECT_ID)).resolves.toBe(42);

    expect(await kv.get(`gen:${PROJECT_ID}`)).toBe("42");
  });

  it("treats garbage as generation 0", () => {
    expect(parseGeneration(null)).toBe(0);
    expect(parseGeneration("")).toBe(0);
    expect(parseGeneration("abc")).toBe(0);
    expect(parseGeneration("-3")).toBe(0);
    expect(parseGeneration("7")).toBe(7);
  });
});
