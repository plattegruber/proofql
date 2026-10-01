// Per-request database client over the Hyperdrive binding — the dashboard
// twin of the api worker's db middleware (workers/api/src/db.ts). One
// client per request, never cached in module scope: isolates cannot
// reliably share sockets across requests, Hyperdrive makes reconnects
// cheap, and per-request construction makes staleness bugs impossible.
//
// Loaders/actions call `withRequestDb(context, fn)`; the pool closes via
// `waitUntil` after the response (the callback resolving means the DB work
// is done — loaders return plain data, not streams).
import { createDb, type Db } from "@proofql/db";
import type { RouterContextProvider } from "react-router";

import { getCloudflare } from "./context";

export type { Db };

export type WithDb = <T>(
  context: Readonly<RouterContextProvider>,
  fn: (db: Db) => Promise<T>,
) => Promise<T>;

export const withRequestDb: WithDb = async (context, fn) => {
  const { env, ctx } = getCloudflare(context);
  const { db, sql } = createDb(env.HYPERDRIVE.connectionString);
  try {
    return await fn(db);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
};
