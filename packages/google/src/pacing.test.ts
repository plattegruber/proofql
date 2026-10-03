import { describe, expect, it } from "vitest";

import {
  createPacer,
  EMPTY_PACER_STATE,
  fnv1a,
  nextSlot,
  type PacerState,
  stableOrder,
} from "./pacing.js";

describe("nextSlot", () => {
  it("spaces consecutive requests at 60000/limit ms", () => {
    let state: PacerState = EMPTY_PACER_STATE;
    const starts: number[] = [];
    let now = 0;
    for (let i = 0; i < 5; i++) {
      const slot = nextSlot(state, now, 240);
      state = slot.state;
      starts.push(now + slot.waitMs);
      now += slot.waitMs; // the caller waits, then fires
    }
    expect(starts).toEqual([0, 250, 500, 750, 1000]);
  });

  it("never admits more than `limit` starts in any rolling minute", () => {
    const limit = 240;
    let state: PacerState = EMPTY_PACER_STATE;
    let now = 0;
    const starts: number[] = [];
    // 1,000 back-to-back requests, each fired as soon as allowed.
    for (let i = 0; i < 1000; i++) {
      const slot = nextSlot(state, now, limit);
      state = slot.state;
      now += slot.waitMs;
      starts.push(now);
    }
    for (let i = 0; i < starts.length; i++) {
      const windowStart = (starts[i] as number) - 60_000;
      const inWindow = starts.filter(
        (t) => t > windowStart && t <= (starts[i] as number),
      );
      expect(inWindow.length).toBeLessThanOrEqual(limit);
    }
    // 1,000 requests at 240/min take at least ~4 minutes.
    expect(now).toBeGreaterThanOrEqual((1000 - 1) * 250);
  });

  it("needs no wait after a quiet minute", () => {
    const busy = { admitted: Array.from({ length: 240 }, (_, i) => i * 250) };
    const slot = nextSlot(busy, 120_000, 240);
    expect(slot.waitMs).toBe(0);
    expect(slot.state.admitted).toEqual([120_000]);
  });

  it("rejects a non-positive limit", () => {
    expect(() => nextSlot(EMPTY_PACER_STATE, 0, 0)).toThrow(RangeError);
  });
});

describe("createPacer", () => {
  it("sleeps for the computed wait plus jitter, counting requests", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const pacer = createPacer({
      limitPerMinute: 120, // 500 ms spacing
      maxJitterMs: 50,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      random: () => 0.5, // 25 ms jitter
    });
    await pacer.acquire();
    await pacer.acquire();
    await pacer.acquire();
    expect(pacer.count).toBe(3);
    // first: no wait but jitter; then 500 - 25 (clock already moved) + 25.
    expect(sleeps).toEqual([25, 500, 500]);
    expect(pacer.waitedMs).toBe(1025);
  });

  it("with jitter off, a first request never waits", async () => {
    const sleeps: number[] = [];
    const pacer = createPacer({
      maxJitterMs: 0,
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await pacer.acquire();
    expect(sleeps).toEqual([]);
  });
});

describe("stableOrder", () => {
  const items = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));

  it("is deterministic for a seed and a permutation of the input", () => {
    const once = stableOrder(items, "2026-10-01T06").map((i) => i.id);
    const again = stableOrder([...items].reverse(), "2026-10-01T06").map(
      (i) => i.id,
    );
    expect(again).toEqual(once);
    expect([...once].sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("changes with the seed", () => {
    const orders = new Set(
      ["t1", "t2", "t3", "t4", "t5"].map((seed) =>
        stableOrder(items, seed)
          .map((i) => i.id)
          .join(""),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  it("fnv1a is stable", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
  });
});
