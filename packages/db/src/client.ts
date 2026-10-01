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
 *   hoards pooled backends.
 *
 * The raw `sql` client is exposed for hand-written queries (hybrid search
 * is one: vector distance, `ts_rank`, and RRF fusion are easier in SQL than
 * through the query builder).
 */
export function createDb(
  connectionString: string,
  opts?: { max?: number },
): { db: Db; sql: Sql } {
  const sql = postgres(connectionString, {
    prepare: false,
    max: opts?.max ?? 5,
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
