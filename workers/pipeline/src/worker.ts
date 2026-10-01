/**
 * Wrangler entrypoint (see `main` in wrangler.jsonc), kept separate from
 * src/handlers.ts: workerd only allows handler exports on the entry module,
 * and unit tests import the handlers under Node.
 *
 * - `queue`: `proofql-ingest` batches land here. The body type is `unknown`
 *   on purpose — the handler validates every message before trusting it.
 * - `fetch`: `GET /health` so `pnpm dev` has something to smoke-test.
 */

import type { PipelineBindings } from "./bindings.js";
import {
  createQueueContext,
  handleFetch,
  handleQueueBatch,
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
} satisfies ExportedHandler<PipelineBindings, unknown>;
