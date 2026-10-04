/**
 * Database access for the api worker.
 *
 * Production: one postgres-js client per request from the Hyperdrive
 * connection string (packages/db README "Hyperdrive caveats"), opened on
 * first use — so a request that fails auth on a malformed key, or is served
 * from the auth cache and the query cache (src/auth-cache.ts, #108), never
 * touches the database — and closed after the response is sent via
 * `waitUntil`.
 *
 * The client is `max: 1` with a short connect timeout (`API_DB_OPTIONS`):
 * no statement on the hot path runs concurrently with another, so a wider
 * pool only widened the burst footprint toward Hyperdrive's origin
 * connection limit (20 on preview), and a request that cannot get a
 * connection should fail fast into a retryable 503 (`isDatabaseUnavailable`,
 * mapped in src/errors.ts) rather than hang for postgres-js's default 30 s.
 *
 * Tests: `createApp({ db })` injects the harness's client; `getDb()` returns
 * it and nothing is opened or closed here.
 */

import { type CreateDbOptions, createDb, type Db } from "@proofql/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { ApiBindings, AppEnv } from "./bindings.js";

export interface DbHandle {
  db: Db;
  /** Release the connection(s); a no-op for injected clients. */
  close: () => Promise<void>;
}

/** How the app obtains a database for a request. */
export type DbProvider = (env: ApiBindings) => DbHandle;

/**
 * How the api opens its per-request client (module doc). `idleTimeout`
 * matters only for a client whose `close()` never ran (an evicted isolate):
 * Hyperdrive reclaims the slot after a few idle seconds instead of never.
 */
export const API_DB_OPTIONS: Readonly<CreateDbOptions> = {
  max: 1,
  connectTimeout: 10,
  idleTimeout: 5,
};

/** The real thing: Hyperdrive, per request. */
export const hyperdriveProvider: DbProvider = (env) => {
  const { db, sql } = createDb(env.HYPERDRIVE.connectionString, API_DB_OPTIONS);
  return { db, close: () => sql.end() };
};

/**
 * SQLSTATEs and driver codes that mean "the database could not be reached
 * or has no connection to give", not "the statement was wrong":
 *
 *   53300 too_many_connections       57P03 cannot_connect_now
 *   53400 configuration_limit_exceeded   08xxx connection exceptions
 *
 * plus postgres-js's own connection errors (`CONNECT_TIMEOUT`,
 * `CONNECTION_CLOSED`, …) and the socket errors under them. All are
 * transient from the caller's point of view, so src/errors.ts answers 503
 * `service_unavailable` with `Retry-After` instead of 500 `internal` (#108).
 */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "53300",
  "53400",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
]);

/** The first `code` on `error` or its `cause` chain that is in the set, else null. */
export function databaseUnavailableCode(error: unknown): string | null {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && current !== null && current !== undefined;
    depth++
  ) {
    if (typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && UNAVAILABLE_CODES.has(code)) return code;
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return null;
}

/** Whether `error` (Drizzle wraps the driver's error as `cause`) is a connection failure. */
export function isDatabaseUnavailable(error: unknown): boolean {
  return databaseUnavailableCode(error) !== null;
}

/** For tests: always the given client, never closed by the app. */
export function injectedProvider(db: Db): DbProvider {
  return () => ({ db, close: async () => {} });
}

/**
 * Run `promise` past the response without blocking it. Uses the Workers
 * execution context when there is one; under `app.request()` in tests there
 * may be none, in which case the promise simply runs detached (rejections
 * are swallowed — the work is best-effort by definition).
 */
export function waitUntil(c: Context<AppEnv>, promise: Promise<unknown>): void {
  let ctx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  if (ctx) {
    ctx.waitUntil(promise);
  } else {
    void promise.catch(() => {});
  }
}

/** Installs `c.get("getDb")`; opens lazily, closes after the response. */
export function dbMiddleware(provider: DbProvider) {
  return createMiddleware<AppEnv>(async (c, next) => {
    let handle: DbHandle | undefined;
    c.set("getDb", () => {
      handle ??= provider(c.env);
      return handle.db;
    });
    try {
      await next();
    } finally {
      if (handle) waitUntil(c, handle.close());
    }
  });
}
