/**
 * The "sweep has work" marker: one KV key that lets the pipeline's
 * five-minute cron leave Postgres alone when there is nothing to sweep.
 *
 * Why it exists (the 2026-10-14 Neon suspension): the cron used to run the
 * re-enqueue sweep (workers/pipeline/src/sweep.ts) on every tick, in both
 * environments, and the sweep's first statement reads `reviews`. Neon
 * suspends an idle compute after 5 minutes, so a query every 5 minutes
 * kept both branches' computes awake around the clock and spent the free
 * plan's 100 CU-hours a month in under two weeks. Most ticks have nothing
 * to do: a review only needs the sweep when its message was never sent or
 * never processed.
 *
 * The rule, in one place. The marker **expires; nothing ever deletes it**.
 * Clearing it on idle would cost a delete per busy period and a put for
 * each next one, up to ~144 of each per environment a day under trickle
 * traffic, against the Free plan's 1,000 puts (shared with the result
 * cache and generation bumps) and 1,000 deletes a day:
 *
 * - **Set** (`markSweepPending`) by every producer just before it sends
 *   index messages: the api's `POST /v1/reviews`, the dashboard's CSV and
 *   Places imports, the pipeline's Google poll, Places refresh and
 *   `connection.sync`. `withSweepMarker` wraps a queue binding so the call
 *   sites do not change. The rows are already committed, so whether the
 *   send then succeeds or is refused (#159) the sweep is the safety net
 *   for them. Setting reads first and puts only when the key is absent,
 *   with `expirationTtl` {@link SWEEP_MARKER_TTL_SECONDS}, so at most one
 *   put per environment per TTL window, however much traffic arrives.
 * - **Read** by the cron at the start of every tick (one KV read). Present
 *   ⇒ the sweep runs. Absent ⇒ the sweep is skipped and the tick opens no
 *   database client unless another job is due. A failed read runs the
 *   sweep (fail safe).
 * - **Expires** by itself one TTL after it was set. Until then every tick
 *   sweeps, so the database stays awake for up to an hour after the first
 *   ingest of a window: the price of spending no write on "idle again".
 * - **Extended** (`extendSweepMarker`) by a sweep that still has work
 *   (something re-sent, deferred, or unindexed in flight) when the marker
 *   is within {@link SWEEP_MARKER_EXTEND_WINDOW_MS} of expiring. The new
 *   value is the extension time, so the guard (age ≥ TTL − window) allows
 *   at most one extension per TTL window. A sweep that finds work with no
 *   marker (a full sweep after a `pnpm db:reindex` or a lost write) sets
 *   it the same way, so the backlog drains every five minutes.
 * - A **full sweep** runs, marker or not, on every tick that already wakes
 *   the database for another job (00/06/12/18:00, 03:30, 04:15 UTC), so a
 *   lost marker costs at most six hours and no extra wakeup.
 *
 * KV costs per environment per day: 288 reads for the ticks plus one per
 * wrapped producer that sends; **puts: at most one per window, a window
 * lasting at least TTL − extension window (50 minutes): ≤ 29 a day
 * worst case, about 24 under steady trickle traffic; deletes: none.**
 * Every KV failure goes through the isolate's `kvFaults` reporter
 * (`kv.limit_exceeded` / `kv.read_failed` / `kv.write_failed`) and never
 * fails the caller.
 */

import { type KvFaultReporter, kvFaults } from "./kv-guard.js";
import type { Logger } from "./log.js";
import type { IngestMessage } from "./queue.js";
import type { IngestProducer } from "./queue-guard.js";

/** Lives in the shared `CACHE` namespace, beside `gen:<id>` and the result cache. */
export const SWEEP_MARKER_KEY = "pipeline:sweep-pending";

/** The marker expires this long after it is put (module doc). */
export const SWEEP_MARKER_TTL_SECONDS = 3_600;

/** A sweep with work left extends a marker this close to expiry. */
export const SWEEP_MARKER_EXTEND_WINDOW_MS = 10 * 60_000;

/** The KV surface the marker needs; `env.CACHE` (a `KVNamespace`) fits. */
export interface SweepMarkerKv {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

const PUT_OPTIONS = { expirationTtl: SWEEP_MARKER_TTL_SECONDS } as const;

export interface SweepMarkerContext {
  log: Logger;
  /** Call site for the KV fault line, e.g. `api.ingest`. */
  site: string;
  /** Defaults to the isolate's `kvFaults`. */
  reporter?: KvFaultReporter;
  /** Clock; injectable for tests. */
  now?: () => number;
}

export type SweepMarkerState =
  | { kind: "absent" }
  /** `setAt` is the epoch ms the setter wrote, or null for a foreign value. */
  | { kind: "present"; value: string; setAt: number | null }
  /** The read failed: treat as "maybe work" (fail safe). */
  | { kind: "unknown" };

function parseSetAt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** Read the marker; never throws (a failure is `unknown`). */
export async function readSweepMarker(
  kv: SweepMarkerKv,
  ctx: SweepMarkerContext,
): Promise<SweepMarkerState> {
  try {
    const value = await kv.get(SWEEP_MARKER_KEY);
    if (value === null) return { kind: "absent" };
    return { kind: "present", value, setAt: parseSetAt(value) };
  } catch (error) {
    (ctx.reporter ?? kvFaults).report(ctx.log, "get", ctx.site, error);
    return { kind: "unknown" };
  }
}

export type MarkOutcome =
  /** The key was absent and this call wrote it. */
  | "set"
  /** The key was already there; nothing written. */
  | "present"
  /** KV failed; logged. The next full sweep covers it. */
  | "failed";

/**
 * Set the marker if it is absent (module doc). Never throws. Logs
 * `sweep.marker_set` when it writes.
 */
export async function markSweepPending(
  kv: SweepMarkerKv,
  ctx: SweepMarkerContext,
): Promise<MarkOutcome> {
  const reporter = ctx.reporter ?? kvFaults;
  let current: string | null;
  try {
    current = await kv.get(SWEEP_MARKER_KEY);
  } catch (error) {
    reporter.report(ctx.log, "get", ctx.site, error);
    return "failed";
  }
  if (current !== null) return "present";
  try {
    await kv.put(
      SWEEP_MARKER_KEY,
      String((ctx.now ?? Date.now)()),
      PUT_OPTIONS,
    );
  } catch (error) {
    reporter.report(ctx.log, "put", ctx.site, error);
    return "failed";
  }
  ctx.log.log("sweep.marker_set", { site: ctx.site });
  return "set";
}

export type ExtendOutcome =
  /** There was no marker; this call put one. */
  | "set"
  /** It was near expiry; this call put a fresh one. */
  | "extended"
  /** Left alone: not near expiry yet, or changed since the tick read it. */
  | "kept"
  /** KV failed; logged. The sweep still runs while KV fails (fail safe). */
  | "failed";

/**
 * After a sweep that still has work: put a fresh marker if there is none,
 * or if the one the tick read (`seen`) expires within
 * {@link SWEEP_MARKER_EXTEND_WINDOW_MS}. The fresh value is the current
 * time, so a marker is extended at most once per TTL window. Never
 * throws, never deletes. Logs `sweep.marker_set` / `sweep.marker_extended`.
 */
export async function extendSweepMarker(
  kv: SweepMarkerKv,
  seen: SweepMarkerState,
  ctx: SweepMarkerContext,
): Promise<ExtendOutcome> {
  if (seen.kind !== "present") {
    const outcome = await markSweepPending(kv, ctx);
    return outcome === "present" ? "kept" : outcome;
  }
  const now = (ctx.now ?? Date.now)();
  const extendAfter =
    SWEEP_MARKER_TTL_SECONDS * 1000 - SWEEP_MARKER_EXTEND_WINDOW_MS;
  // A value without a time (one put by hand) counts as due: extending it
  // also gives it a TTL.
  if (seen.setAt !== null && now - seen.setAt < extendAfter) return "kept";
  const reporter = ctx.reporter ?? kvFaults;
  try {
    // Re-read so two overlapping ticks cannot both extend one window.
    const current = await kv.get(SWEEP_MARKER_KEY);
    if (current !== null && current !== seen.value) return "kept";
    await kv.put(SWEEP_MARKER_KEY, String(now), PUT_OPTIONS);
  } catch (error) {
    reporter.report(ctx.log, "put", ctx.site, error);
    return "failed";
  }
  ctx.log.log("sweep.marker_extended", { site: ctx.site });
  return "extended";
}

/**
 * `queue` with the marker set before its first non-empty `sendBatch`
 * (module doc). The send itself is unchanged, and so is its error: callers
 * keep their own `enqueueOrDefer` handling. A wrapper marks at most once,
 * so wrap per request or per tick, not per isolate. `kv` undefined (a test
 * or local setup without the binding) passes the queue through.
 */
export function withSweepMarker<Q extends IngestProducer>(
  queue: Q,
  kv: SweepMarkerKv | undefined,
  ctx: SweepMarkerContext,
): Pick<Q, "sendBatch"> {
  if (kv === undefined) return queue;
  let marked = false;
  const sendBatch = async (messages: Iterable<{ body: IngestMessage }>) => {
    const list = [...messages];
    if (list.length > 0 && !marked) {
      marked = true;
      await markSweepPending(kv, ctx);
    }
    return queue.sendBatch(list);
  };
  // Same parameters, and it resolves to whatever the queue's send does.
  return { sendBatch: sendBatch as Q["sendBatch"] };
}

/**
 * In-memory `SweepMarkerKv` for tests: honours `expirationTtl` against
 * `clock`, records every put's options, and counts calls. `delete` exists
 * only so a test can assert nothing ever calls it.
 */
export class MemorySweepMarkerKv implements SweepMarkerKv {
  readonly store = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();
  readonly calls = { get: 0, put: 0, delete: 0 };
  readonly puts: { key: string; value: string; expirationTtl?: number }[] = [];
  fail: { get?: boolean; put?: boolean } = {};
  clock: () => number = Date.now;

  /** Seed a value (no TTL unless given), bypassing the counters. */
  seed(value: string, ttlSeconds?: number): void {
    this.store.set(SWEEP_MARKER_KEY, {
      value,
      expiresAt:
        ttlSeconds === undefined ? null : this.clock() + ttlSeconds * 1000,
    });
  }

  peek(): string | null {
    return this.live(SWEEP_MARKER_KEY);
  }

  private live(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && this.clock() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async get(key: string): Promise<string | null> {
    this.calls.get += 1;
    if (this.fail.get) throw new Error("KV get() limit exceeded for the day.");
    return this.live(key);
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.calls.put += 1;
    if (this.fail.put) throw new Error("KV put() limit exceeded for the day.");
    this.puts.push({ key, value, ...options });
    const ttl = options?.expirationTtl;
    this.store.set(key, {
      value,
      expiresAt: ttl === undefined ? null : this.clock() + ttl * 1000,
    });
  }

  async delete(key: string): Promise<void> {
    this.calls.delete += 1;
    this.store.delete(key);
  }
}
