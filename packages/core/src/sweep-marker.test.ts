import { describe, expect, it, vi } from "vitest";

import { createKvFaultReporter } from "./kv-guard.js";
import { createLogger, recordingSink } from "./log.js";
import type { IngestMessage } from "./queue.js";
import { enqueueOrDefer } from "./queue-guard.js";
import {
  extendSweepMarker,
  MemorySweepMarkerKv,
  markSweepPending,
  readSweepMarker,
  SWEEP_MARKER_EXTEND_WINDOW_MS,
  SWEEP_MARKER_KEY,
  SWEEP_MARKER_TTL_SECONDS,
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
    expect(kv.puts).toEqual([
      {
        key: SWEEP_MARKER_KEY,
        value: String(T0),
        expirationTtl: SWEEP_MARKER_TTL_SECONDS,
      },
    ]);
    expect(out.find("sweep.marker_set")).not.toHaveLength(0);
  });

  it("reads but never writes when the marker is already set (writes only on the transition)", async () => {
    const kv = new MemorySweepMarkerKv();
    kv.seed("123");
    const { ctx: c } = ctx();
    expect(await markSweepPending(kv, c)).toBe("present");
    expect(kv.calls).toEqual({ get: 1, put: 0, delete: 0 });
    expect(kv.peek()).toBe("123");
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
    kv.seed(String(T0));
    expect(await readSweepMarker(kv, c)).toEqual({
      kind: "present",
      value: String(T0),
      setAt: T0,
    });
    kv.seed("1");
    expect(await readSweepMarker(kv, c)).toMatchObject({ setAt: 1 });
    kv.seed("yes");
    expect(await readSweepMarker(kv, c)).toMatchObject({ setAt: null });
    kv.fail.get = true;
    expect(await readSweepMarker(kv, c)).toEqual({ kind: "unknown" });
    expect(out.find("kv.limit_exceeded")).not.toHaveLength(0);
  });
});

describe("extendSweepMarker (the marker expires; nothing deletes it)", () => {
  const ttlMs = SWEEP_MARKER_TTL_SECONDS * 1000;
  const due = T0 - (ttlMs - SWEEP_MARKER_EXTEND_WINDOW_MS);

  function kvAt(now: number) {
    const kv = new MemorySweepMarkerKv();
    kv.clock = () => now;
    return kv;
  }

  it("leaves a marker that is not near expiry alone, with no KV call", async () => {
    const kv = kvAt(T0);
    kv.seed(String(due + 1), SWEEP_MARKER_TTL_SECONDS);
    const { ctx: c } = ctx();
    const seen = await readSweepMarker(kv, c);
    const before = { ...kv.calls };
    expect(await extendSweepMarker(kv, seen, c)).toBe("kept");
    expect(kv.calls).toEqual(before);
  });

  it("extends a marker in its last window once, with the TTL; the new value blocks a second extension", async () => {
    const kv = kvAt(T0);
    kv.seed(String(due), SWEEP_MARKER_TTL_SECONDS);
    const { ctx: c, out } = ctx();
    const seen = await readSweepMarker(kv, c);
    expect(await extendSweepMarker(kv, seen, c)).toBe("extended");
    expect(kv.puts).toEqual([
      {
        key: SWEEP_MARKER_KEY,
        value: String(T0),
        expirationTtl: SWEEP_MARKER_TTL_SECONDS,
      },
    ]);
    expect(out.find("sweep.marker_extended")).toHaveLength(1);

    // The guard: the next tick reads the fresh value and does nothing.
    const again = await readSweepMarker(kv, c);
    expect(await extendSweepMarker(kv, again, c)).toBe("kept");
    expect(kv.calls.put).toBe(1);
    expect(kv.calls.delete).toBe(0);
  });

  it("does not extend a marker a producer re-put since the tick read it", async () => {
    const kv = kvAt(T0);
    kv.seed(String(due - 1), SWEEP_MARKER_TTL_SECONDS);
    const { ctx: c } = ctx();
    const seen = await readSweepMarker(kv, c);
    kv.seed(String(T0), SWEEP_MARKER_TTL_SECONDS);
    expect(await extendSweepMarker(kv, seen, c)).toBe("kept");
    expect(kv.calls.put).toBe(0);
  });

  it("no marker: puts one with the TTL (a full sweep found work)", async () => {
    const kv = kvAt(T0);
    const { ctx: c } = ctx();
    expect(await extendSweepMarker(kv, { kind: "absent" }, c)).toBe("set");
    expect(kv.puts[0]?.expirationTtl).toBe(SWEEP_MARKER_TTL_SECONDS);
  });

  it("a hand-put value without a time is extended (and so gains a TTL)", async () => {
    const kv = kvAt(T0);
    kv.seed("1");
    const { ctx: c } = ctx();
    const seen = await readSweepMarker(kv, c);
    expect(seen).toMatchObject({ setAt: 1 });
    expect(await extendSweepMarker(kv, seen, c)).toBe("extended");
    expect(kv.puts[0]?.expirationTtl).toBe(SWEEP_MARKER_TTL_SECONDS);
  });

  it("KV failure: `failed`, logged, never throws", async () => {
    const kv = kvAt(T0);
    kv.seed(String(due), SWEEP_MARKER_TTL_SECONDS);
    const { ctx: c, out } = ctx();
    const seen = await readSweepMarker(kv, c);
    kv.fail.put = true;
    expect(await extendSweepMarker(kv, seen, c)).toBe("failed");
    expect(out.find("kv.limit_exceeded")).not.toHaveLength(0);
  });

  it("the marker is gone one TTL after it was put", async () => {
    let now = T0;
    const kv = new MemorySweepMarkerKv();
    kv.clock = () => now;
    const { ctx: c } = ctx();
    await markSweepPending(kv, c);
    now = T0 + ttlMs - 1;
    expect(await readSweepMarker(kv, c)).toMatchObject({ kind: "present" });
    now = T0 + ttlMs;
    expect(await readSweepMarker(kv, c)).toEqual({ kind: "absent" });
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
    expect(kv.peek()).not.toBeNull();
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
    expect(kv.peek()).not.toBeNull();
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
