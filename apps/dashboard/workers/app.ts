/**
 * Workers fetch handler for the dashboard (see `main` in wrangler.jsonc).
 *
 * The object handed to `requestHandler` becomes `context` in every
 * middleware/loader/action. With `v8_middleware` on it is a
 * RouterContextProvider, so the Workers `env` and `ctx` travel under the
 * typed `cloudflareContext` key (app/lib/context.ts) and server code reads
 * them with `getCloudflare(context)`.
 *
 * Structured logging and request ids arrive with #30 (`createLogger` in
 * @proofql/core); this entry grows the logger wiring then.
 */
import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext } from "~/lib/context";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    const context = new RouterContextProvider(
      new Map([[cloudflareContext, { env, ctx }]]),
    );
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<Env>;
