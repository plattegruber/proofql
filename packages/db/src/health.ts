/**
 * The deep health check's database probe (`/health?deep=1` on the api and
 * the dashboard). One `select` through whatever client the caller opened
 * (Hyperdrive in production), raced against a short timeout, so a
 * suspended or unreachable Neon compute answers in seconds instead of
 * hanging until postgres-js's connect timeout.
 *
 * The statement calls `now()` on purpose: Hyperdrive caches the results of
 * read-only queries for up to 60 s by default but never caches one that
 * calls a volatile function, and a cached `select 1` would report a
 * suspended database as healthy.
 *
 * Plain `/health` never calls this. Every deep call reaches Neon and wakes
 * a suspended compute, which then stays up for its 5-minute idle window,
 * so an uptime monitor must poll the deep variant sparingly
 * (docs/launch.md §16 "Uptime monitoring").
 */

import { sql } from "drizzle-orm";

import type { Db } from "./client.js";

/** How long the probe waits for Postgres before calling it down. */
export const DB_PING_TIMEOUT_MS = 5_000;

export type DbPing =
  | { ok: true; ms: number }
  | {
      ok: false;
      ms: number;
      /** `timeout`: no answer within the limit; `failed`: the statement threw. */
      error: "timeout" | "failed";
      /** For the caller's log line only; never put it in a response body. */
      cause?: unknown;
    };

/** Probe the database; never throws. */
export async function pingDatabase(
  db: Db,
  options: { timeoutMs?: number; now?: () => number } = {},
): Promise<DbPing> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DB_PING_TIMEOUT_MS;
  const start = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      db.execute(sql`select 1 as ok, now() as at`).then(() => "ok" as const),
      timeout,
    ]);
    const ms = now() - start;
    return outcome === "ok"
      ? { ok: true, ms }
      : { ok: false, ms, error: "timeout" };
  } catch (cause) {
    return { ok: false, ms: now() - start, error: "failed", cause };
  } finally {
    clearTimeout(timer);
  }
}
