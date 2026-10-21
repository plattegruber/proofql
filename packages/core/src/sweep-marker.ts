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
 * The rule, in one place:
 *
 * - **Set** (`markSweepPending`) by every producer just before it sends
 *   index messages: the api's `POST /v1/reviews`, the dashboard's CSV and
 *   Places imports and its `connection.sync`, the pipeline's Google poll
 *   and Places refresh. `withSweepMarker` wraps a queue binding so the
 *   call sites do not change. The rows are already committed, so whether
 *   the send then succeeds or is refused (#159) the sweep is the safety
 *   net for them. Setting reads first and writes only when the key is
 *   absent, and a wrapped producer marks at most once, so a write is spent
 *   on the idle → busy transition only, never per review or per batch.
 * - **Read** by the cron at the start of every tick (one KV read). Absent
 *   ⇒ the sweep is skipped and the tick opens no database client unless
 *   another job is due. A failed read runs the sweep (fail safe).
 * - **Cleared** (`clearSweepMarker`) by a sweep that found nothing left to
 *   do: nothing to re-send, nothing deferred, and no unindexed review still
 *   in flight. It is held for at least {@link SWEEP_MARKER_MIN_HOLD_MS}
 *   after it was set, so it is never cleared by the first tick after a
 *   set: every set/clear cycle spans at least two ticks, which caps the
 *   cycles (one put and one delete each) at about 144 a day per
 *   environment however traffic arrives. The price is one extra sweep
 *   tick, about five more minutes of Neon compute, per isolated burst.
 * - A **full sweep** runs, marker or not, on every tick that already wakes
 *   the database for another job (00/06/12/18:00, 03:30, 04:15 UTC), so a
 *   lost marker costs at most six hours and no extra wakeup. A full sweep
 *   that finds work sets the marker, so a backlog it discovers (a
 *   `pnpm db:reindex`, a lost write) keeps draining every five minutes.
 *
 * KV is eventually consistent (a write can take up to 60 s to be seen in
 * another location) and has no compare-and-set, so a producer's set can
 * race a sweep's clear. The clear re-reads the key and deletes only an
 * unchanged value, which narrows the window; the full sweep closes it.
 *
 * KV costs: one read per cron tick (288 a day per environment), one read
 * per wrapped producer that sends, and at most one put and one delete per
 * busy period. Every KV failure goes through the isolate's `kvFaults`
 * reporter (`kv.limit_exceeded` / `kv.read_failed` / `kv.write_failed`)
 * and never fails the caller.
 */

import { type KvFaultReporter, kvFaults } from "./kv-guard.js";
import type { Logger } from "./log.js";
import type { IngestMessage } from "./queue.js";
import type { IngestProducer } from "./queue-guard.js";

/** Lives in the shared `CACHE` namespace, beside `gen:<id>` and the result cache. */
export const SWEEP_MARKER_KEY = "pipeline:sweep-pending";

/** The marker is not cleared until it is this old (module doc). */
export const SWEEP_MARKER_MIN_HOLD_MS = 5 * 60_000;

/** The KV surface the marker needs; `env.CACHE` (a `KVNamespace`) fits. */
export interface SweepMarkerKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

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
    await kv.put(SWEEP_MARKER_KEY, String((ctx.now ?? Date.now)()));
  } catch (error) {
    reporter.report(ctx.log, "put", ctx.site, error);
    return "failed";
  }
  ctx.log.log("sweep.marker_set", { site: ctx.site });
  return "set";
}

export type ClearOutcome =
  | "cleared"
  /** Younger than the minimum hold; kept. */
  | "held"
  /** Nothing to clear. */
  | "absent"
  /** A producer re-set it since the tick read it; kept. */
  | "changed"
  /** KV failed; logged. The sweep runs again next tick (fail safe). */
  | "failed";

/**
 * After a sweep found nothing to do: delete the marker the tick read
 * (`seen`), unless it is younger than the hold or has changed since.
 * Never throws. Logs `sweep.marker_cleared` when it deletes.
 */
export async function clearSweepMarker(
  kv: SweepMarkerKv,
  seen: SweepMarkerState,
  ctx: SweepMarkerContext,
): Promise<ClearOutcome> {
  if (seen.kind === "absent") return "absent";
  const now = (ctx.now ?? Date.now)();
  if (
    seen.kind === "present" &&
    seen.setAt !== null &&
    now - seen.setAt < SWEEP_MARKER_MIN_HOLD_MS
  ) {
    return "held";
  }
  const reporter = ctx.reporter ?? kvFaults;
  let current: string | null;
  try {
    current = await kv.get(SWEEP_MARKER_KEY);
  } catch (error) {
    reporter.report(ctx.log, "get", ctx.site, error);
    return "failed";
  }
  if (current === null) return "absent";
  if (seen.kind === "present" && current !== seen.value) return "changed";
  if (seen.kind === "unknown") {
    // The tick could not read it; judge the hold on the value read now.
    const setAt = parseSetAt(current);
    if (setAt !== null && now - setAt < SWEEP_MARKER_MIN_HOLD_MS) {
      return "held";
    }
  }
  try {
    await kv.delete(SWEEP_MARKER_KEY);
  } catch (error) {
    reporter.report(ctx.log, "delete", ctx.site, error);
    return "failed";
  }
  ctx.log.log("sweep.marker_cleared", { site: ctx.site });
  return "cleared";
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

/** In-memory `SweepMarkerKv` for tests; `fail` makes the named methods throw. */
export class MemorySweepMarkerKv implements SweepMarkerKv {
  readonly store = new Map<string, string>();
  readonly calls = { get: 0, put: 0, delete: 0 };
  fail: { get?: boolean; put?: boolean; delete?: boolean } = {};

  async get(key: string): Promise<string | null> {
    this.calls.get += 1;
    if (this.fail.get) throw new Error("KV get() limit exceeded for the day.");
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.calls.put += 1;
    if (this.fail.put) throw new Error("KV put() limit exceeded for the day.");
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.calls.delete += 1;
    if (this.fail.delete) {
      throw new Error("KV delete() limit exceeded for the day.");
    }
    this.store.delete(key);
  }
}
