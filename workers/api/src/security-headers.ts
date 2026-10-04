/**
 * Response headers every api response carries (#49), mounted once in
 * `createApp` right after the request context so error envelopes, 404s and
 * the CORS preflight get them too:
 *
 *   - `X-Content-Type-Options: nosniff` — every body is JSON and says so;
 *     a browser must never sniff an error envelope into something else.
 *   - `Referrer-Policy: no-referrer` — the api never links out, and a
 *     `?key=` in a request URL must not leak as a referrer should a
 *     response ever be rendered.
 *   - `Cache-Control` on everything a route did not already set a policy
 *     for. A successful `GET /v1/query` gets `private, max-age=0,
 *     must-revalidate` (#112): the response varies by key, so a shared cache
 *     (a CDN, a corporate proxy) must never hold it, while the browser may
 *     keep it for back/forward and conditional revalidation. The result
 *     cache proper is server-side (src/query/cache.ts: KV behind the worker,
 *     `x-cache`, `Vary: Origin`) and unaffected. Everything else — error
 *     envelopes, `POST /v1/query`, ingest and management responses, health —
 *     is per-request and gets `no-store`.
 *   - `Strict-Transport-Security` in `preview` and `prod` only. Local
 *     `wrangler dev` is plain HTTP on localhost and must not teach a
 *     browser otherwise.
 */

import { createMiddleware } from "hono/factory";

import type { AppEnv } from "./bindings.js";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export const NO_STORE = "no-store";

/** A 2xx `GET /v1/query`: per key, so private; revalidate rather than reuse. */
export const QUERY_CACHE_CONTROL = "private, max-age=0, must-revalidate";

/** One year, subdomains included; no `preload` until the domain is final. */
export const HSTS_VALUE = "max-age=31536000; includeSubDomains";

/** Environments served over HTTPS where HSTS is safe to assert. */
export const HSTS_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "preview",
  "prod",
]);

/** A 2xx `GET /v1/query`: the one response that is not `no-store`. */
export function isCacheableQuery(
  method: string,
  path: string,
  status: number,
): boolean {
  return (
    method === "GET" &&
    (path === "/v1/query" || path.startsWith("/v1/query/")) &&
    status >= 200 &&
    status < 300
  );
}

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  const headers = c.res.headers;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  if (!headers.has("Cache-Control")) {
    headers.set(
      "Cache-Control",
      isCacheableQuery(c.req.method, c.req.path, c.res.status)
        ? QUERY_CACHE_CONTROL
        : NO_STORE,
    );
  }
  // `c.env` is undefined under `app.request()` with no bindings.
  const environment = (c.env as { ENVIRONMENT?: string } | undefined)
    ?.ENVIRONMENT;
  if (environment !== undefined && HSTS_ENVIRONMENTS.has(environment)) {
    headers.set("Strict-Transport-Security", HSTS_VALUE);
  }
});
