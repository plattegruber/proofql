/**
 * Workers fetch handler for the dashboard (see `main` in wrangler.jsonc).
 *
 * The object handed to `requestHandler` becomes `context` in every
 * middleware/loader/action. With `v8_middleware` on it is a
 * RouterContextProvider, so the Workers `env` and `ctx` travel under the
 * typed `cloudflareContext` key (app/lib/context.ts) and server code reads
 * them with `getCloudflare(context)`.
 *
 * Request-id edge (#30, docs/observability.md): the id honours an inbound
 * `x-request-id` (≤128 chars), else Cloudflare's `cf-ray`, else a fresh
 * uuid — the same rule as the api worker — and is echoed on the response.
 * The request-bound logger (service `dashboard`, bound to `request_id`,
 * `method`, `path` without the query string) rides along in the context.
 */
import { createLogger } from "@proofql/core";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext } from "~/lib/context";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export const REQUEST_ID_HEADER = "x-request-id";
const MAX_INCOMING_LENGTH = 128;

export function resolveRequestId(headers: Headers): string {
  const incoming = headers.get(REQUEST_ID_HEADER) ?? headers.get("cf-ray");
  return incoming !== null &&
    incoming.length > 0 &&
    incoming.length <= MAX_INCOMING_LENGTH
    ? incoming
    : crypto.randomUUID();
}

export default {
  async fetch(request, env, ctx) {
    const requestId = resolveRequestId(request.headers);
    const log = createLogger({
      service: "dashboard",
      environment: env.ENVIRONMENT,
    }).child({
      request_id: requestId,
      method: request.method,
      path: new URL(request.url).pathname,
    });
    const context = new RouterContextProvider(
      new Map([[cloudflareContext, { env, ctx, log, requestId }]]),
    );
    const response = await requestHandler(request, context);
    // Streamed SSR responses can carry immutable headers — rewrap.
    const traced = new Response(response.body, response);
    traced.headers.set(REQUEST_ID_HEADER, requestId);
    return traced;
  },
} satisfies ExportedHandler<Env>;
