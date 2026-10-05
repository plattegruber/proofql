/**
 * Every KV call in every worker goes through these guards (#158): on the
 * Workers Free plan the account gets 100,000 KV reads and **1,000 KV
 * writes** a day, and when either runs out every `get()` or `put()` throws
 * `KV get() limit exceeded for the day` / `KV put() limit exceeded for the
 * day` until 00:00 UTC. KV is a cache or a hint everywhere ProofQL uses it,
 * so none of that may fail a request:
 *
 *   - `guardKvRead` returns the caller's fallback (a cache miss, "no
 *     generation", an empty counter) when the read throws;
 *   - `guardKvWrite` swallows a throwing write and reports `false`;
 *   - `safeBumpProjectGeneration` is `bumpProjectGeneration` that never
 *     throws: the database change it follows has already committed, so a
 *     failed bump must not turn a successful edit into an error page. The
 *     cost is staleness, bounded by the cached entries' own TTL.
 *
 * Failures are logged, but at most **once per isolate per minute** per
 * (event, op) pair, with a `suppressed` count of the failures the throttle
 * swallowed since the last line: an exhausted quota fails every call for
 * hours, and a line per request would spend the log budget on one fact.
 *
 *   kv.limit_exceeded  warn  the daily quota is spent (the message matched)
 *   kv.read_failed     warn  any other get/list failure
 *   kv.write_failed    warn  any other put/delete failure
 *
 * Fields: `op`, `site` (which call site, e.g. `api.query_cache`),
 * `suppressed`, `error`. docs/observability.md has the catalogue entries.
 */

import {
  bumpProjectGeneration,
  type GenerationKv,
} from "./cache-generation.js";
import type { Logger } from "./log.js";

/** The text Cloudflare puts in a KV error once the daily quota is spent. */
export const KV_LIMIT_PATTERN =
  /\bKV (?:get|put|delete|list)\(\) limit exceeded\b/i;

export type KvOp = "get" | "put" | "delete" | "list";

export type KvFaultEvent =
  | "kv.limit_exceeded"
  | "kv.read_failed"
  | "kv.write_failed";

/** Messages of `error` and up to four `cause`s, for pattern matching. */
export function errorMessages(error: unknown): string[] {
  const out: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (typeof current === "string") {
      out.push(current);
      break;
    }
    if (typeof current !== "object") break;
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string") out.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

/** Whether `error` (or a cause) is KV's daily-limit error. */
export function isKvLimitError(error: unknown): boolean {
  return errorMessages(error).some((m) => KV_LIMIT_PATTERN.test(m));
}

/** Which event a failure of `op` with `error` is logged as. */
export function kvFaultEvent(op: KvOp, error: unknown): KvFaultEvent {
  if (isKvLimitError(error)) return "kv.limit_exceeded";
  return op === "get" || op === "list" ? "kv.read_failed" : "kv.write_failed";
}

export interface KvFaultReporterOptions {
  /** Minimum gap between two lines for one (event, op); default 60 s. */
  intervalMs?: number;
  now?: () => number;
}

export interface KvFaultReporter {
  /** Log the failure unless one like it was logged within the interval. */
  report(log: Logger, op: KvOp, site: string, error: unknown): void;
}

export const KV_FAULT_LOG_INTERVAL_MS = 60_000;

export function createKvFaultReporter(
  options: KvFaultReporterOptions = {},
): KvFaultReporter {
  const intervalMs = options.intervalMs ?? KV_FAULT_LOG_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const last = new Map<string, { at: number; suppressed: number }>();
  return {
    report(log, op, site, error) {
      const event = kvFaultEvent(op, error);
      const key = `${event}:${op}`;
      const t = now();
      const seen = last.get(key);
      if (seen !== undefined && t - seen.at < intervalMs) {
        seen.suppressed += 1;
        return;
      }
      last.set(key, { at: t, suppressed: 0 });
      log.log(event, {
        level: "warn",
        op,
        site,
        suppressed: seen?.suppressed ?? 0,
        // `error` would force level error (log.ts `levelFor`); the explicit
        // level wins, and the message is the diagnosis.
        error,
      });
    },
  };
}

/** The isolate's reporter: module state lives as long as the isolate. */
export const kvFaults: KvFaultReporter = createKvFaultReporter();

export interface KvGuardContext {
  log: Logger;
  /** Call site, e.g. `api.query_cache`; goes into the log line. */
  site: string;
  /** Defaults to the isolate's `kvFaults`. */
  reporter?: KvFaultReporter;
}

/** Run a KV read; on any throw, report it and return `fallback`. */
export async function guardKvRead<T>(
  ctx: KvGuardContext,
  fallback: T,
  read: () => Promise<T>,
  op: KvOp = "get",
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    (ctx.reporter ?? kvFaults).report(ctx.log, op, ctx.site, error);
    return fallback;
  }
}

/** Run a KV write; on any throw, report it and resolve `false`. */
export async function guardKvWrite(
  ctx: KvGuardContext,
  write: () => Promise<unknown>,
  op: KvOp = "put",
): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    (ctx.reporter ?? kvFaults).report(ctx.log, op, ctx.site, error);
    return false;
  }
}

/**
 * `bumpProjectGeneration` that never throws (module doc): the new
 * generation, or null when the read or the write failed. Call it after the
 * database change has committed, as before.
 */
export async function safeBumpProjectGeneration(
  kv: GenerationKv,
  projectId: string,
  ctx: KvGuardContext,
): Promise<number | null> {
  try {
    return await bumpProjectGeneration(kv, projectId);
  } catch (error) {
    // The read half of a bump failing is as fatal to the bump as the write.
    (ctx.reporter ?? kvFaults).report(ctx.log, "put", ctx.site, error);
    return null;
  }
}

/** The literal errors Cloudflare throws once the daily quota is spent. */
export const KV_GET_LIMIT_MESSAGE = "KV get() limit exceeded for the day.";
export const KV_PUT_LIMIT_MESSAGE = "KV put() limit exceeded for the day.";

/**
 * For tests (#158): a KV binding whose every read throws the literal
 * `KV get() limit exceeded…` and every write the literal `KV put() limit
 * exceeded…`, as a namespace does after its free-plan quota. `calls` counts
 * attempts per method so a test can also assert a site did not retry.
 */
export function exhaustedKv(which: { reads?: boolean; writes?: boolean } = {}) {
  const reads = which.reads ?? true;
  const writes = which.writes ?? true;
  const calls = { get: 0, getWithMetadata: 0, put: 0, delete: 0, list: 0 };
  const store = new Map<string, string>();
  const failRead = () => {
    if (reads) throw new Error(KV_GET_LIMIT_MESSAGE);
  };
  const failWrite = () => {
    if (writes) throw new Error(KV_PUT_LIMIT_MESSAGE);
  };
  return {
    calls,
    store,
    async get(key: string): Promise<string | null> {
      calls.get += 1;
      failRead();
      return store.get(key) ?? null;
    },
    async getWithMetadata(
      key: string,
    ): Promise<{ value: string | null; metadata: unknown }> {
      calls.getWithMetadata += 1;
      failRead();
      return { value: store.get(key) ?? null, metadata: null };
    },
    async put(key: string, value: string): Promise<void> {
      calls.put += 1;
      failWrite();
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      calls.delete += 1;
      failWrite();
      store.delete(key);
    },
    async list(): Promise<{ keys: { name: string }[] }> {
      calls.list += 1;
      failRead();
      return { keys: [...store.keys()].map((name) => ({ name })) };
    },
  };
}
