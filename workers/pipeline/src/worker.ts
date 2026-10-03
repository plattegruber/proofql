/**
 * Wrangler entrypoint (see `main` in wrangler.jsonc), kept separate from
 * src/handlers.ts: workerd only allows handler exports on the entry module,
 * and unit tests import the handlers under Node.
 *
 * - `queue`: batches from both `proofql-ingest` and `proofql-ingest-dlq`
 *   land here (one Worker consumes both; wrangler.jsonc); `handleQueue`
 *   routes on `batch.queue`. The body type is `unknown` on purpose — each
 *   consumer validates every message before trusting it.
 * - `scheduled`: two crons (`triggers.crons` in wrangler.jsonc), routed on
 *   `controller.cron`: every five minutes re-enqueue reviews stuck with
 *   `indexed_at IS NULL` (#72); every six hours poll the Google
 *   connections (#46). Locally: `wrangler dev --test-scheduled`, then GET
 *   `/__scheduled?cron=<the cron expression, URL-encoded>` on port 8798.
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
    await handleScheduled(env, controller.cron);
  },
} satisfies ExportedHandler<PipelineBindings, unknown>;
