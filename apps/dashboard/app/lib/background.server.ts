// Run the CSV import past the response (#38). The action redirects to the
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
import { runImport } from "./csv.server";

export function runImportInBackground(
  context: Readonly<RouterContextProvider>,
  runId: string,
): void {
  const { env, ctx, log } = getCloudflare(context);
  const { db, sql } = createDb(env.HYPERDRIVE.connectionString);
  const task = runImport(
    {
      db,
      store: env.UPLOADS,
      queue: {
        sendBatch: async (messages) => {
          await env.INGEST_QUEUE.sendBatch([...messages]);
        },
      },
      log,
    },
    runId,
  )
    .catch((error: unknown) => {
      log.log("import.failed", { ingest_run_id: runId, error });
    })
    .finally(() => sql.end({ timeout: 5 }));
  ctx.waitUntil(task);
}
