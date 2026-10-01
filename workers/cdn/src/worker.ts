/**
 * Wrangler entrypoint (see `main` in wrangler.jsonc). Kept separate from
 * src/handler.ts, which unit tests drive under Node with a fake `ASSETS`.
 */

import { handleRequest } from "./handler.js";

export interface CdnBindings {
  /** Workers static assets: the `public/` directory (wrangler.jsonc). */
  ASSETS: Fetcher;
  ENVIRONMENT: string;
}

export default {
  fetch: (request, env) => handleRequest(request, env.ASSETS),
} satisfies ExportedHandler<CdnBindings>;
