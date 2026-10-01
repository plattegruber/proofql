/**
 * Wrangler entrypoint (see `main` in wrangler.jsonc), kept separate from
 * src/handlers.ts: workerd only allows handler exports on the entry module,
 * and unit tests import the handlers under Node.
 *
 * - `queue`: `proofql-ingest` batches land here.
 * - `fetch`: `GET /health` so `pnpm dev` has something to smoke-test.
 */

import type { IngestMessage, PipelineBindings } from "./bindings.js";
import { handleFetch, handleQueueBatch } from "./handlers.js";

export default {
  fetch: (request) => handleFetch(request),
  queue: (batch) => handleQueueBatch(batch),
} satisfies ExportedHandler<PipelineBindings, IngestMessage>;
