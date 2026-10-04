import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema/index.js";

export type Db = PostgresJsDatabase<typeof schema>;
export type { Sql };

/**
 * Create a Drizzle client (and the raw postgres-js client under it) for a
 * connection string. Nothing connects at module scope and nothing reads
 * `process.env`: the caller owns configuration.
 *
 * - Cloudflare Workers: `createDb(env.HYPERDRIVE.connectionString)`, once
 *   per request. Isolates cannot reliably share sockets across requests,
 *   and Hyperdrive makes reconnecting cheap.
 * - Node (local dev, CI, scripts): `createDb(process.env.DATABASE_URL)`.
 *
 * Defaults, and why (see README "Hyperdrive caveats"):
 *
 * - `prepare: false` — named prepared statements bind to one pooled backend
 *   and break under Hyperdrive's transaction-mode pooling. Off everywhere so
 *   local and production behave identically.
 * - `max: 5` — Hyperdrive pools upstream; a large client-side pool only
 *   hoards pooled backends. The api worker passes `max: 1` (#108): nothing
 *   on its hot path runs two statements concurrently, so a wider pool only
 *   widens the burst footprint toward Hyperdrive's origin connection limit.
 * - `connectTimeout` / `idleTimeout` (seconds) map onto postgres-js's
 *   `connect_timeout` (default 30) and `idle_timeout` (default: never). A
 *   per-request client that cannot connect should fail fast and surface as
 *   a retryable error rather than hold the request for half a minute.
 *
 * The raw `sql` client is exposed for hand-written queries (hybrid search
 * is one: vector distance, `ts_rank`, and RRF fusion are easier in SQL than
 * through the query builder).
 */
export interface CreateDbOptions {
  /** Pool size; default 5. */
  max?: number;
  /** Seconds to wait for a connection before failing; default postgres-js's 30. */
  connectTimeout?: number;
  /** Seconds an idle connection is kept; default postgres-js's "forever". */
  idleTimeout?: number;
}

export function createDb(
  connectionString: string,
  opts?: CreateDbOptions,
): { db: Db; sql: Sql } {
  const sql = postgres(connectionString, {
    prepare: false,
    max: opts?.max ?? 5,
    ...(opts?.connectTimeout === undefined
      ? {}
      : { connect_timeout: opts.connectTimeout }),
    ...(opts?.idleTimeout === undefined
      ? {}
      : { idle_timeout: opts.idleTimeout }),
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
