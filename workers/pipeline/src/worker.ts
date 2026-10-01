/**
 * Wrangler entrypoint (see `main` in wrangler.jsonc), kept separate from
 * src/handlers.ts: workerd only allows handler exports on the entry module,
 * and unit tests import the handlers under Node.
 *
 * - `queue`: `proofql-ingest` batches land here. The body type is `unknown`
 *   on purpose — the handler validates every message before trusting it.
 * - `scheduled`: the every-five-minutes cron (`triggers.crons` in
 *   wrangler.jsonc) re-enqueues reviews stuck with `indexed_at IS NULL`
 *   (#72). Locally: `wrangler dev --test-scheduled`, then GET
 *   `/__scheduled?cron=<the cron expression, URL-encoded>` on port 8798.
 * - `fetch`: `GET /health` so `pnpm dev` has something to smoke-test.
 */

import type { PipelineBindings } from "./bindings.js";
import {
  createQueueContext,
  handleFetch,
  handleQueueBatch,
  handleScheduled,
} from "./handlers.js";

export default {
  fetch: (request) => handleFetch(request),
  queue: async (batch, env) => {
    const { ctx, close } = createQueueContext(env);
    try {
      await handleQueueBatch(batch, ctx);
    } finally {
      await close();
    }
  },
  scheduled: async (_controller, env) => {
    await handleScheduled(env);
  },
} satisfies ExportedHandler<PipelineBindings, unknown>;
