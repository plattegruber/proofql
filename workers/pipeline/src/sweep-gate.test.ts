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
  SWEEP_MARKER_EXTEND_WINDOW_MS,
  SWEEP_MARKER_KEY,
  SWEEP_MARKER_TTL_SECONDS,
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
    kv.seed(String(at("12:00")), SWEEP_MARKER_TTL_SECONDS);
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
    kv.seed("1");
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

describe("handleScheduled: an expired marker means no database", () => {
  it("one TTL after the last put, the tick is idle again", async () => {
    let now = at("12:00");
    const kv = new MemorySweepMarkerKv();
    kv.clock = () => now;
    kv.seed(String(now), SWEEP_MARKER_TTL_SECONDS);
    const { env, probe } = probeEnv(kv);

    now = at("12:55");
    await handleScheduled(env, now);
    expect(probe.opened).toBe(1);

    now = at("13:00");
    const result = await handleScheduled(env, now);
    expect(result).toEqual({ ran: [], failed: [] });
    expect(probe.opened).toBe(1);
    expect(kv.calls.delete).toBe(0);
  });
});

describe("settleSweepMarker (never deletes)", () => {
  const now = at("12:05");
  const clock = () => now;
  const ttlMs = SWEEP_MARKER_TTL_SECONDS * 1000;

  function kvAt() {
    const kv = new MemorySweepMarkerKv();
    kv.clock = clock;
    return kv;
  }

  it("idle sweep: no KV call at all, the marker is left to expire", async () => {
    const { log } = testLogger();
    const kv = kvAt();
    kv.seed(String(now - ttlMs + 60_000), SWEEP_MARKER_TTL_SECONDS);
    const marker = await planSweep(now, kv, log).then((p) => p.marker);
    const before = { ...kv.calls };
    expect(
      await settleSweepMarker({ idle: true }, marker, kv, log, clock),
    ).toBe("none");
    expect(kv.calls).toEqual(before);
  });

  it("work left near expiry: extends once, with the TTL", async () => {
    const { log, out } = testLogger();
    const kv = kvAt();
    kv.seed(
      String(now - (ttlMs - SWEEP_MARKER_EXTEND_WINDOW_MS)),
      SWEEP_MARKER_TTL_SECONDS,
    );
    const marker = (await planSweep(now, kv, log)).marker;
    expect(
      await settleSweepMarker({ idle: false }, marker, kv, log, clock),
    ).toBe("extended");
    expect(kv.puts).toEqual([
      expect.objectContaining({
        value: String(now),
        expirationTtl: SWEEP_MARKER_TTL_SECONDS,
      }),
    ]);
    expect(out.find("sweep.marker_extended")).toHaveLength(1);
    const next = (await planSweep(now, kv, log)).marker;
    expect(await settleSweepMarker({ idle: false }, next, kv, log, clock)).toBe(
      "kept",
    );
    expect(kv.calls.put).toBe(1);
  });

  it("work left, marker fresh: kept, no KV call", async () => {
    const { log } = testLogger();
    const kv = kvAt();
    kv.seed(String(now - 60_000), SWEEP_MARKER_TTL_SECONDS);
    const marker = (await planSweep(now, kv, log)).marker;
    const before = { ...kv.calls };
    expect(
      await settleSweepMarker({ idle: false }, marker, kv, log, clock),
    ).toBe("kept");
    expect(kv.calls).toEqual(before);
  });

  it("work left and no marker (a full sweep found a backlog): sets it, so the next ticks keep draining", async () => {
    const { log } = testLogger();
    const kv = kvAt();
    expect(
      await settleSweepMarker(
        { idle: false },
        { kind: "absent" },
        kv,
        log,
        clock,
      ),
    ).toBe("set");
    expect(kv.puts[0]).toMatchObject({
      value: String(now),
      expirationTtl: SWEEP_MARKER_TTL_SECONDS,
    });
  });

  it("KV failing never throws out of the tick", async () => {
    const { log } = testLogger();
    const kv = kvAt();
    kv.fail = { get: true, put: true };
    expect(
      await settleSweepMarker(
        { idle: false },
        { kind: "unknown" },
        kv,
        log,
        clock,
      ),
    ).toBe("failed");
  });
});

describe("KV write budget (free plan: 1,000 writes a day, deletes included, account-wide)", () => {
  async function day(sweepIdle: boolean) {
    const { log } = testLogger();
    const kv = new MemorySweepMarkerKv();
    let now = Date.UTC(2026, 9, 20);
    kv.clock = () => now;
    for (let m = 0; m < 24 * 60; m += 5) {
      const tick = Date.UTC(2026, 9, 20) + m * 60_000;
      now = tick;
      const plan = await planSweep(tick, kv, log);
      if (plan.run) {
        await settleSweepMarker(
          { idle: sweepIdle },
          plan.marker,
          kv,
          log,
          () => tick,
        );
      }
      // A producer sends right after every tick, all day.
      now = tick + 1_000;
      await markSweepPending(kv, {
        log,
        site: "test.producer",
        now: () => now,
      });
    }
    return kv.calls;
  }

  it("steady trickle (every send indexed by the next tick): 24 puts a day, no deletes", async () => {
    const calls = await day(true);
    expect(calls.put).toBe(24);
    expect(calls.delete).toBe(0);
  });

  it("worst case (work always pending, so sweeps extend): at most 29 puts a day, no deletes", async () => {
    const calls = await day(false);
    expect(calls.put).toBeLessThanOrEqual(29);
    expect(calls.put).toBeGreaterThanOrEqual(24);
    expect(calls.delete).toBe(0);
  });
});
