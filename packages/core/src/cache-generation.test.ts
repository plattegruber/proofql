import { describe, expect, it } from "vitest";

import {
  bumpProjectGeneration,
  coalesceGenerationBumps,
  generationKey,
  MemoryKv,
  parseGeneration,
  readProjectGeneration,
} from "./cache-generation.js";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

describe("project generation counter", () => {
  it("reads 0 for a project that was never bumped", async () => {
    expect(await readProjectGeneration(new MemoryKv(), PROJECT_ID)).toBe(0);
  });

  it("writes gen:<projectId> = 1 when the key is absent", async () => {
    const kv = new MemoryKv();

    await expect(bumpProjectGeneration(kv, PROJECT_ID)).resolves.toBe(1);

    expect(generationKey(PROJECT_ID)).toBe(`gen:${PROJECT_ID}`);
    expect(await kv.get(`gen:${PROJECT_ID}`)).toBe("1");
    expect(kv.puts).toEqual([{ key: `gen:${PROJECT_ID}`, value: "1" }]);
  });

  it("increments the stored integer string and reads it back", async () => {
    const kv = new MemoryKv({ [generationKey(PROJECT_ID)]: "41" });

    await expect(bumpProjectGeneration(kv, PROJECT_ID)).resolves.toBe(42);

    expect(await kv.get(`gen:${PROJECT_ID}`)).toBe("42");
    expect(await readProjectGeneration(kv, PROJECT_ID)).toBe(42);
  });

  it("keeps projects independent", async () => {
    const kv = new MemoryKv();

    await bumpProjectGeneration(kv, "p1");
    expect(await readProjectGeneration(kv, "p2")).toBe(0);
    expect(await bumpProjectGeneration(kv, "p2")).toBe(1);
    expect(await readProjectGeneration(kv, "p1")).toBe(1);
  });

  it("treats a corrupt stored value as 0", async () => {
    const kv = new MemoryKv({ [generationKey("p1")]: "not-a-number" });

    expect(await readProjectGeneration(kv, "p1")).toBe(0);
    expect(await bumpProjectGeneration(kv, "p1")).toBe(1);
  });

  it("parses only non-negative decimal integers", () => {
    expect(parseGeneration(null)).toBe(0);
    expect(parseGeneration("")).toBe(0);
    expect(parseGeneration("abc")).toBe(0);
    expect(parseGeneration("-3")).toBe(0);
    expect(parseGeneration("1e3")).toBe(0);
    expect(parseGeneration("7")).toBe(7);
  });
});

describe("coalesceGenerationBumps", () => {
  it("holds every bump of a project and writes the final value once", async () => {
    const kv = new MemoryKv({ [generationKey(PROJECT_ID)]: "4" });
    const batch = coalesceGenerationBumps(kv);
    for (let i = 0; i < 10; i++) {
      await bumpProjectGeneration(batch.kv, PROJECT_ID);
    }
    await bumpProjectGeneration(batch.kv, "other");
    expect(kv.puts).toEqual([]);
    expect([...batch.pending].sort()).toEqual([PROJECT_ID, "other"].sort());

    const written = await batch.flush();
    expect(kv.puts).toHaveLength(2);
    expect(kv.store.get(generationKey(PROJECT_ID))).toBe("14");
    expect(written).toContainEqual({ projectId: PROJECT_ID, generation: 14 });
    expect(batch.pending).toEqual([]);
    expect(await batch.flush()).toEqual([]);
  });

  it("passes non-generation writes straight through", async () => {
    const kv = new MemoryKv();
    const batch = coalesceGenerationBumps(kv);
    await batch.kv.put("places:x", "y");
    expect(kv.store.get("places:x")).toBe("y");
  });

  it("attempts every write and rethrows the first failure", async () => {
    const kv = new MemoryKv();
    let fail = true;
    const flaky = {
      get: (k: string) => kv.get(k),
      put: async (k: string, v: string) => {
        if (fail) {
          fail = false;
          throw new Error("KV put() limit exceeded for the day.");
        }
        await kv.put(k, v);
      },
    };
    const batch = coalesceGenerationBumps(flaky);
    await bumpProjectGeneration(batch.kv, "a");
    await bumpProjectGeneration(batch.kv, "b");
    await expect(batch.flush()).rejects.toThrow(/limit exceeded/);
    expect(kv.puts).toHaveLength(1);
  });
});
