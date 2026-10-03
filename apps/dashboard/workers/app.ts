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
import { applySecurityHeaders } from "~/lib/security-headers";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Same rule as the api (workers/api/src/request-id.ts, #49): at most 128
 * chars of a token charset, since the id is echoed in a header and written
 * into every log line — anything else is a log-injection vector and earns
 * a fresh uuid instead.
 */
const INCOMING_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(headers: Headers): string {
  const incoming = headers.get(REQUEST_ID_HEADER) ?? headers.get("cf-ray");
  return incoming !== null && INCOMING_ID_PATTERN.test(incoming)
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
    // CSP, framing, sniffing, referrer, HSTS (#49; app/lib/security-headers.ts).
    applySecurityHeaders(traced.headers, env);
    return traced;
  },
} satisfies ExportedHandler<Env>;
