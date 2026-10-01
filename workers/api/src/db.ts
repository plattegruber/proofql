/**
 * Database access for the api worker.
 *
 * Production: one postgres-js client per request from the Hyperdrive
 * connection string (packages/db README "Hyperdrive caveats"), opened on
 * first use — so a request that fails auth on a malformed key never touches
 * the database — and closed after the response is sent via `waitUntil`.
 *
 * Tests: `createApp({ db })` injects the harness's client; `getDb()` returns
 * it and nothing is opened or closed here.
 */

import { createDb, type Db } from "@proofql/db";
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

/** The real thing: Hyperdrive, per request. */
export const hyperdriveProvider: DbProvider = (env) => {
  const { db, sql } = createDb(env.HYPERDRIVE.connectionString);
  return { db, close: () => sql.end() };
};

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
