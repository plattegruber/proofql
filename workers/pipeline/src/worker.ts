/**
 * Wrangler entrypoint (see `main` in wrangler.jsonc), kept separate from
 * src/handlers.ts: workerd only allows handler exports on the entry module,
 * and unit tests import the handlers under Node.
 *
 * - `queue`: batches from both `proofql-ingest` and `proofql-ingest-dlq`
 *   land here (one Worker consumes both; wrangler.jsonc); `handleQueue`
 *   routes on `batch.queue`. The body type is `unknown` on purpose — each
 *   consumer validates every message before trusting it.
 * - `scheduled`: one five-minute cron (`triggers.crons` in wrangler.jsonc;
 *   the Free plan allows five per account, #174). `handleScheduled` picks
 *   the jobs due at `controller.scheduledTime` (src/schedule.ts): every
 *   tick re-enqueue reviews stuck with `indexed_at IS NULL` (#72); at
 *   00/06/12/18:00 UTC poll the Google connections (#46); at 03:30 UTC
 *   refresh the Places bootstraps older than 25 days (#116); at 04:15 UTC
 *   hard-delete workspaces soft-deleted 30+ days ago and their R2 uploads
 *   (#169). Locally: `wrangler dev --test-scheduled`, then GET
 *   `/cdn-cgi/local/scheduled?time=<epoch ms of a due time>` on port 8798.
 * - `fetch`: `GET /health` so `pnpm dev` has something to smoke-test.
 */

import type { PipelineBindings } from "./bindings.js";
import { handleFetch, handleQueue, handleScheduled } from "./handlers.js";

export default {
  fetch: (request) => handleFetch(request),
  queue: async (batch, env) => {
    await handleQueue(batch, env);
  },
  scheduled: async (controller, env) => {
    await handleScheduled(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<PipelineBindings, unknown>;
