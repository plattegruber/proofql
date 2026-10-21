import { describe, expect, it, vi } from "vitest";

import { createKvFaultReporter } from "./kv-guard.js";
import { createLogger, recordingSink } from "./log.js";
import type { IngestMessage } from "./queue.js";
import { enqueueOrDefer } from "./queue-guard.js";
import {
  clearSweepMarker,
  MemorySweepMarkerKv,
  markSweepPending,
  readSweepMarker,
  SWEEP_MARKER_KEY,
  SWEEP_MARKER_MIN_HOLD_MS,
  withSweepMarker,
} from "./sweep-marker.js";

const message: IngestMessage = {
  type: "review.index",
  reviewId: "5d2f0c6e-4a1b-4c3d-9e8f-7a6b5c4d3e2f",
  projectId: "0b1c2d3e-4f5a-4b6c-8d9e-0f1a2b3c4d5e",
  environment: "live",
};

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

function ctx(now = T0) {
  const out = recordingSink();
  return {
    out,
    ctx: {
      log: createLogger({
        service: "api",
        environment: "test",
        sink: out.sink,
      }),
      site: "test.site",
      // A fresh reporter per test, so the isolate throttle cannot hide a line.
      reporter: createKvFaultReporter(),
      now: () => now,
    },
  };
}

describe("markSweepPending", () => {
  it("writes the set time when the marker is absent, and logs once", async () => {
    const kv = new MemorySweepMarkerKv();
    const { ctx: c, out } = ctx();
    expect(await markSweepPending(kv, c)).toBe("set");
    expect(kv.store.get(SWEEP_MARKER_KEY)).toBe(String(T0));
    expect(out.find("sweep.marker_set")).not.toHaveLength(0);
  });

  it("reads but never writes when the marker is already set (writes only on the transition)", async () => {
    const kv = new MemorySweepMarkerKv();
    kv.store.set(SWEEP_MARKER_KEY, "123");
    const { ctx: c } = ctx();
    expect(await markSweepPending(kv, c)).toBe("present");
    expect(kv.calls).toEqual({ get: 1, put: 0, delete: 0 });
    expect(kv.store.get(SWEEP_MARKER_KEY)).toBe("123");
  });

  it("KV failure: resolves `failed` and logs the fault, never throws", async () => {
    const kv = new MemorySweepMarkerKv();
    kv.fail.put = true;
    const { ctx: c, out } = ctx();
    expect(await markSweepPending(kv, c)).toBe("failed");
    expect(out.find("kv.limit_exceeded")).not.toHaveLength(0);

    kv.fail.get = true;
    expect(await markSweepPending(kv, c)).toBe("failed");
  });
});

describe("readSweepMarker", () => {
  it("absent, present (with the set time), and unknown when the read fails", async () => {
    const kv = new MemorySweepMarkerKv();
    const { ctx: c, out } = ctx();
    expect(await readSweepMarker(kv, c)).toEqual({ kind: "absent" });
    kv.store.set(SWEEP_MARKER_KEY, String(T0));
    expect(await readSweepMarker(kv, c)).toEqual({
      kind: "present",
      value: String(T0),
      setAt: T0,
    });
    kv.store.set(SWEEP_MARKER_KEY, "1");
    expect(await readSweepMarker(kv, c)).toMatchObject({ setAt: 1 });
    kv.store.set(SWEEP_MARKER_KEY, "yes");
    expect(await readSweepMarker(kv, c)).toMatchObject({ setAt: null });
    kv.fail.get = true;
    expect(await readSweepMarker(kv, c)).toEqual({ kind: "unknown" });
    expect(out.find("kv.limit_exceeded")).not.toHaveLength(0);
  });
});

describe("clearSweepMarker", () => {
  const old = T0 - SWEEP_MARKER_MIN_HOLD_MS;

  it("deletes a marker older than the hold that has not changed since the tick read it", async () => {
    const kv = new MemorySweepMarkerKv();
    kv.store.set(SWEEP_MARKER_KEY, String(old));
    const { ctx: c, out } = ctx();
    const seen = await readSweepMarker(kv, c);
    expect(await clearSweepMarker(kv, seen, c)).toBe("cleared");
    expect(kv.store.has(SWEEP_MARKER_KEY)).toBe(false);
    expect(out.find("sweep.marker_cleared")).not.toHaveLength(0);
  });

  it("holds a marker younger than SWEEP_MARKER_MIN_HOLD_MS, without touching KV", async () => {
    const kv = new MemorySweepMarkerKv();
    kv.store.set(SWEEP_MARKER_KEY, String(old + 1));
    const { ctx: c } = ctx();
    const seen = await readSweepMarker(kv, c);
    const before = { ...kv.calls };
    expect(await clearSweepMarker(kv, seen, c)).toBe("held");
    expect(kv.calls).toEqual(before);
    expect(kv.store.has(SWEEP_MARKER_KEY)).toBe(true);
  });

  it("keeps a marker a producer re-set after the tick read it", async () => {
    const kv = new MemorySweepMarkerKv();
    kv.store.set(SWEEP_MARKER_KEY, String(old - 1));
    const { ctx: c } = ctx();
    const seen = await readSweepMarker(kv, c);
    kv.store.set(SWEEP_MARKER_KEY, String(T0));
    expect(await clearSweepMarker(kv, seen, c)).toBe("changed");
    expect(kv.store.get(SWEEP_MARKER_KEY)).toBe(String(T0));
  });

  it("absent stays absent with no write", async () => {
    const kv = new MemorySweepMarkerKv();
    const { ctx: c } = ctx();
    expect(await clearSweepMarker(kv, { kind: "absent" }, c)).toBe("absent");
    expect(kv.calls.delete).toBe(0);
  });

  it("an unreadable tick clears only an old marker, judged on a fresh read", async () => {
    const kv = new MemorySweepMarkerKv();
    const { ctx: c } = ctx();
    kv.store.set(SWEEP_MARKER_KEY, String(T0 - 1));
    expect(await clearSweepMarker(kv, { kind: "unknown" }, c)).toBe("held");
    kv.store.set(SWEEP_MARKER_KEY, String(old));
    expect(await clearSweepMarker(kv, { kind: "unknown" }, c)).toBe("cleared");
  });

  it("a failed delete resolves `failed` (the marker stays: the next tick sweeps again)", async () => {
    const kv = new MemorySweepMarkerKv();
    kv.store.set(SWEEP_MARKER_KEY, String(old));
    kv.fail.delete = true;
    const { ctx: c, out } = ctx();
    const seen = await readSweepMarker(kv, c);
    expect(await clearSweepMarker(kv, seen, c)).toBe("failed");
    expect(kv.store.has(SWEEP_MARKER_KEY)).toBe(true);
    expect(out.find("kv.limit_exceeded")).not.toHaveLength(0);
  });
});

describe("withSweepMarker", () => {
  it("marks before the first non-empty send, once per wrapper, and passes the messages through", async () => {
    const kv = new MemorySweepMarkerKv();
    const sendBatch = vi.fn(async () => {});
    const { ctx: c } = ctx();
    const queue = withSweepMarker({ sendBatch }, kv, c);

    await queue.sendBatch([]);
    expect(kv.calls.get).toBe(0);

    await queue.sendBatch([{ body: message }]);
    await queue.sendBatch([{ body: message }, { body: message }]);
    expect(kv.calls).toEqual({ get: 1, put: 1, delete: 0 });
    expect(kv.store.has(SWEEP_MARKER_KEY)).toBe(true);
    expect(sendBatch).toHaveBeenCalledTimes(3);
    expect(sendBatch.mock.calls[2]).toEqual([
      [{ body: message }, { body: message }],
    ]);
  });

  it("a refused send still leaves the marker set, and the error reaches enqueueOrDefer unchanged", async () => {
    const kv = new MemorySweepMarkerKv();
    const { ctx: c, out } = ctx();
    const refusing = {
      sendBatch: async () => {
        throw new Error("Queue sendBatch failed: Free tier limit exceeded");
      },
    };
    const outcome = await enqueueOrDefer(
      withSweepMarker(refusing, kv, c),
      [message],
      { log: c.log, site: "test.site" },
    );
    expect(outcome).toEqual({ sent: false, quota: true });
    expect(kv.store.has(SWEEP_MARKER_KEY)).toBe(true);
    expect(out.find("quota.exhausted")).not.toHaveLength(0);
  });

  it("KV down: the send still happens", async () => {
    const kv = new MemorySweepMarkerKv();
    kv.fail = { get: true, put: true };
    const sendBatch = vi.fn(async () => {});
    const { ctx: c } = ctx();
    await withSweepMarker({ sendBatch }, kv, c).sendBatch([{ body: message }]);
    expect(sendBatch).toHaveBeenCalledTimes(1);
  });

  it("no KV binding: the queue itself", () => {
    const q = { sendBatch: async () => {} };
    const { ctx: c } = ctx();
    expect(withSweepMarker(q, undefined, c)).toBe(q);
  });
});
