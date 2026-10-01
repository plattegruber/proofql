import { describe, expect, it } from "vitest";

import {
  bumpProjectGeneration,
  generationKey,
  readProjectGeneration,
} from "./cache-purge.js";

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe("project generation counter", () => {
  it("reads 0 for a project that was never bumped", async () => {
    const env = { CACHE: fakeKv() };
    expect(await readProjectGeneration(env, "p1")).toBe(0);
  });

  it("bumps from 0 and stores the value as a decimal string", async () => {
    const env = { CACHE: fakeKv() };

    expect(await bumpProjectGeneration(env, "p1")).toBe(1);
    expect(await bumpProjectGeneration(env, "p1")).toBe(2);
    expect(env.CACHE.store.get(generationKey("p1"))).toBe("2");
    expect(await readProjectGeneration(env, "p1")).toBe(2);
  });

  it("keeps projects independent", async () => {
    const env = { CACHE: fakeKv() };

    await bumpProjectGeneration(env, "p1");
    expect(await readProjectGeneration(env, "p2")).toBe(0);
    expect(await bumpProjectGeneration(env, "p2")).toBe(1);
    expect(await readProjectGeneration(env, "p1")).toBe(1);
  });

  it("treats a corrupt stored value as 0", async () => {
    const env = { CACHE: fakeKv({ [generationKey("p1")]: "not-a-number" }) };

    expect(await readProjectGeneration(env, "p1")).toBe(0);
    expect(await bumpProjectGeneration(env, "p1")).toBe(1);
  });
});
