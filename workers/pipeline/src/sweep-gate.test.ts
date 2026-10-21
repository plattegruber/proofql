/**
 * The cron's sweep gate (2026-10-14 Neon suspension): an idle tick must not
 * touch Postgres; the KV marker turns the sweep on, an idle sweep turns it
 * off, a KV failure sweeps anyway, and the six database ticks a day always
 * sweep in full.
 *
 * "Touches Postgres" is observed directly: the env's HYPERDRIVE binding
 * throws the moment anything reads its connection string, which is the
 * first thing opening a database client does.
 */

import {
  type IngestMessage,
  MemorySweepMarkerKv,
  markSweepPending,
  SWEEP_MARKER_KEY,
  SWEEP_MARKER_MIN_HOLD_MS,
} from "@proofql/core";
import { describe, expect, it } from "vitest";

import { testLogger } from "../test/log.js";
import type { PipelineBindings } from "./bindings.js";
import { handleScheduled, planSweep, settleSweepMarker } from "./handlers.js";

const at = (hhmm: string) => Date.parse(`2026-10-20T${hhmm}:00.000Z`);

function probeEnv(kv: MemorySweepMarkerKv) {
  const probe = { opened: 0 };
  const env = {
    ENVIRONMENT: "test",
    HYPERDRIVE: {
      get connectionString(): string {
        probe.opened += 1;
        throw new Error("database touched");
      },
    } as unknown as Hyperdrive,
    CACHE: kv as unknown as KVNamespace,
    INGEST_QUEUE: {
      sendBatch: async () => {},
    } as unknown as Queue<IngestMessage>,
  } satisfies Omit<PipelineBindings, "AI">;
  return { env, probe };
}

describe("handleScheduled: Postgres only when there is work", () => {
  it("an idle tick (no marker, no other job) opens no database client", async () => {
    const kv = new MemorySweepMarkerKv();
    const { env, probe } = probeEnv(kv);
    const result = await handleScheduled(env, at("12:05"));
    expect(result).toEqual({ ran: [], failed: [] });
    expect(probe.opened).toBe(0);
    // One KV read, no write: 288 a day per environment.
    expect(kv.calls).toEqual({ get: 1, put: 0, delete: 0 });
  });

  it("a set marker runs the sweep (and so reaches the database)", async () => {
    const kv = new MemorySweepMarkerKv();
    kv.store.set(SWEEP_MARKER_KEY, String(at("12:00")));
    const { env, probe } = probeEnv(kv);
    const result = await handleScheduled(env, at("12:05"));
    expect(result.failed).toEqual(["sweep"]);
    expect(probe.opened).toBe(1);
  });

  it("KV failing: the sweep runs anyway (fail safe)", async () => {
    const kv = new MemorySweepMarkerKv();
    kv.fail.get = true;
    const { env, probe } = probeEnv(kv);
    const result = await handleScheduled(env, at("12:05"));
    expect(result.failed).toContain("sweep");
    expect(probe.opened).toBeGreaterThan(0);
  });

  it("a full-sweep tick sweeps with no marker, alongside the job that wakes the database anyway", async () => {
    for (const t of ["00:00", "06:00", "12:00", "18:00", "03:30", "04:15"]) {
      const kv = new MemorySweepMarkerKv();
      const { env, probe } = probeEnv(kv);
      const result = await handleScheduled(env, at(t));
      expect(result.failed[0], t).toBe("sweep");
      expect(probe.opened, t).toBeGreaterThan(0);
    }
  });

  it("a day of idle ticks: six database ticks, 288 KV reads, no KV writes", async () => {
    const kv = new MemorySweepMarkerKv();
    const { env, probe } = probeEnv(kv);
    let dbTicks = 0;
    for (let m = 0; m < 24 * 60; m += 5) {
      const before = probe.opened;
      await handleScheduled(env, Date.UTC(2026, 9, 20, 0, m));
      if (probe.opened > before) dbTicks += 1;
    }
    expect(dbTicks).toBe(6);
    expect(kv.calls.get).toBe(288);
    expect(kv.calls.put + kv.calls.delete).toBe(0);
  });
});

describe("planSweep", () => {
  it("absent → idle; present → pending; unreadable → kv_unavailable; full ticks → full", async () => {
    const { log } = testLogger();
    const kv = new MemorySweepMarkerKv();
    expect(await planSweep(at("12:05"), kv, log)).toMatchObject({
      run: false,
      reason: "idle",
    });
    expect(await planSweep(at("06:00"), kv, log)).toMatchObject({
      run: true,
      reason: "full",
      marker: { kind: "absent" },
    });
    kv.store.set(SWEEP_MARKER_KEY, "1");
    expect(await planSweep(at("12:05"), kv, log)).toMatchObject({
      run: true,
      reason: "pending",
    });
    kv.fail.get = true;
    expect(await planSweep(at("12:05"), kv, log)).toMatchObject({
      run: true,
      reason: "kv_unavailable",
    });
  });
});

describe("settleSweepMarker", () => {
  const now = at("12:05");
  const clock = () => now;

  it("idle sweep clears a marker past the hold", async () => {
    const { log, out } = testLogger();
    const kv = new MemorySweepMarkerKv();
    const value = String(now - SWEEP_MARKER_MIN_HOLD_MS);
    kv.store.set(SWEEP_MARKER_KEY, value);
    const marker = { kind: "present", value, setAt: Number(value) } as const;
    expect(
      await settleSweepMarker({ idle: true }, marker, kv, log, clock),
    ).toBe("cleared");
    expect(kv.store.has(SWEEP_MARKER_KEY)).toBe(false);
    expect(out.find("sweep.marker_cleared")).toHaveLength(1);
  });

  it("idle sweep keeps a marker younger than the hold", async () => {
    const { log } = testLogger();
    const kv = new MemorySweepMarkerKv();
    const value = String(now - 60_000);
    kv.store.set(SWEEP_MARKER_KEY, value);
    const marker = { kind: "present", value, setAt: Number(value) } as const;
    expect(
      await settleSweepMarker({ idle: true }, marker, kv, log, clock),
    ).toBe("held");
    expect(kv.store.get(SWEEP_MARKER_KEY)).toBe(value);
  });

  it("work left and no marker (a full sweep found a backlog): sets it, so the next ticks keep draining", async () => {
    const { log } = testLogger();
    const kv = new MemorySweepMarkerKv();
    expect(
      await settleSweepMarker(
        { idle: false },
        { kind: "absent" },
        kv,
        log,
        clock,
      ),
    ).toBe("set");
    expect(kv.store.get(SWEEP_MARKER_KEY)).toBe(String(now));
  });

  it("work left and the marker already set: no KV call at all", async () => {
    const { log } = testLogger();
    const kv = new MemorySweepMarkerKv();
    kv.store.set(SWEEP_MARKER_KEY, "1");
    expect(
      await settleSweepMarker(
        { idle: false },
        { kind: "present", value: "1", setAt: 1 },
        kv,
        log,
        clock,
      ),
    ).toBe("kept");
    expect(kv.calls).toEqual({ get: 0, put: 0, delete: 0 });
  });

  it("KV failing never throws out of the tick", async () => {
    const { log } = testLogger();
    const kv = new MemorySweepMarkerKv();
    kv.fail = { get: true, put: true, delete: true };
    expect(
      await settleSweepMarker(
        { idle: false },
        { kind: "unknown" },
        kv,
        log,
        clock,
      ),
    ).toBe("failed");
    expect(
      await settleSweepMarker(
        { idle: true },
        { kind: "unknown" },
        kv,
        log,
        clock,
      ),
    ).toBe("failed");
  });
});

describe("KV write budget (free plan: 1,000 puts a day, account-wide)", () => {
  it("worst case, a producer marks right after every tick of a day: at most ~144 puts and deletes per environment", async () => {
    const { log } = testLogger();
    const kv = new MemorySweepMarkerKv();
    const day = Date.UTC(2026, 9, 20);
    for (let m = 0; m < 24 * 60; m += 5) {
      const tick = day + m * 60_000;
      const plan = await planSweep(tick, kv, log);
      if (plan.run) {
        // Every sweep finds the work already indexed (the cheapest busy period).
        await settleSweepMarker(
          { idle: true },
          plan.marker,
          kv,
          log,
          () => tick,
        );
      }
      await markSweepPending(kv, {
        log,
        site: "test.producer",
        now: () => tick + 1_000,
      });
    }
    expect(kv.calls.put).toBeLessThanOrEqual(145);
    expect(kv.calls.delete).toBeLessThanOrEqual(145);
    expect(kv.calls.put).toBeGreaterThan(100);
  });
});
