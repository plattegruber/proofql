// Run a CSV or Takeout import past the response (#38). The action redirects to the
// progress page at once and the work rides on `ctx.waitUntil` with its own
// database client — `withRequestDb` closes the request's pool when the
// loader/action callback resolves, which is before the import would end.
//
// Workers lets `waitUntil` work continue for roughly 30 s after the
// response; `runImport` pauses itself inside that (DEFAULT_RUN_BUDGET_MS)
// and the progress page offers "Resume" when a run has stalled, so a file
// bigger than one budget still completes — in several hops.
import { createDb } from "@proofql/db";
import type { RouterContextProvider } from "react-router";

import { getCloudflare } from "./context";
import { type IndexQueue, runImport } from "./csv.server";
import { runTakeoutImport } from "./takeout.server";

/**
 * `runner` picks the code: a CSV/JSON upload (`csv`) or a Google Takeout
 * export (`takeout`, takeout.server.ts; both are `csv`-kind runs, told
 * apart by `isTakeoutRun`). Both pause inside the budget and resume from
 * their counts.
 */
export function runImportInBackground(
  context: Readonly<RouterContextProvider>,
  runId: string,
  runner: "csv" | "takeout" = "csv",
): void {
  const { env, ctx, log } = getCloudflare(context);
  const { db, sql } = createDb(env.HYPERDRIVE.connectionString);
  const queue: IndexQueue = {
    sendBatch: async (messages) => {
      await env.INGEST_QUEUE.sendBatch([...messages]);
    },
  };
  const deps = { db, store: env.UPLOADS, queue, log };
  const task = (
    runner === "takeout"
      ? runTakeoutImport({ ...deps, kv: env.CACHE }, runId)
      : runImport(deps, runId)
  )
    .catch((error: unknown) => {
      log.log("import.failed", { ingest_run_id: runId, error });
    })
    .finally(() => sql.end({ timeout: 5 }));
  ctx.waitUntil(task);
}
