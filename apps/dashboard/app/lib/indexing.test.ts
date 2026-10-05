import { describe, expect, it } from "vitest";

import {
  INDEXING_DELAYED_COPY,
  indexingHint,
  POLL_SCHEDULE,
  pollDelayMs,
  scheduleUntil,
} from "./indexing";

const MIN = 60_000;

describe("pollDelayMs", () => {
  it("polls every 2 s for the first minute", () => {
    expect(pollDelayMs(0)).toBe(2_000);
    expect(pollDelayMs(MIN - 1)).toBe(2_000);
  });

  it("every 10 s from one to five minutes", () => {
    expect(pollDelayMs(MIN)).toBe(10_000);
    expect(pollDelayMs(5 * MIN - 1)).toBe(10_000);
  });

  it("every 30 s from five to thirty minutes", () => {
    expect(pollDelayMs(5 * MIN)).toBe(30_000);
    expect(pollDelayMs(30 * MIN - 1)).toBe(30_000);
  });

  it("stops at thirty minutes", () => {
    expect(pollDelayMs(30 * MIN)).toBeNull();
    expect(pollDelayMs(24 * 60 * MIN)).toBeNull();
  });

  it("costs under 100 polls before it stops, against 900 at a flat 2 s", () => {
    let polls = 0;
    let at = 0;
    for (;;) {
      const delay = pollDelayMs(at);
      if (delay === null) break;
      at += delay;
      polls += 1;
    }
    expect(polls).toBe(30 + 24 + 50);
    expect(polls).toBeLessThan((30 * MIN) / 2_000 / 8);
  });
});

describe("scheduleUntil", () => {
  it("keeps the pace and cuts the run short", () => {
    expect(scheduleUntil(MIN)).toEqual([{ untilMs: MIN, everyMs: 2_000 }]);
    expect(scheduleUntil(2 * MIN)).toEqual([
      { untilMs: MIN, everyMs: 2_000 },
      { untilMs: 2 * MIN, everyMs: 10_000 },
    ]);
    expect(scheduleUntil(60 * MIN)).toEqual(POLL_SCHEDULE);
    expect(pollDelayMs(MIN, scheduleUntil(MIN))).toBeNull();
  });
});

describe("indexingHint", () => {
  it("says seconds normally, delayed when deferred, nothing when nothing waits", () => {
    expect(indexingHint(1_280, false)).toBe(
      "1,280 waiting on the pipeline — searchable within seconds.",
    );
    expect(indexingHint(1_280, true)).toBe(INDEXING_DELAYED_COPY);
    expect(INDEXING_DELAYED_COPY).toBe(
      "Indexing is delayed and will finish automatically, usually within the hour; you can leave this page.",
    );
    expect(indexingHint(0, true)).toBeUndefined();
  });
});
