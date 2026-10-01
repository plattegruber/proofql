/**
 * Wrangler entrypoint (see `main` in wrangler.jsonc), kept separate from
 * src/app.ts: workerd only allows handler exports on the entry module, and
 * tests import the app under Node. Real bindings only: the database comes
 * from `env.HYPERDRIVE` per request.
 */

import { createApp } from "./app.js";
import type { ApiBindings } from "./bindings.js";

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<ApiBindings>;
