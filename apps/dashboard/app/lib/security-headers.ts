/**
 * Response headers for every dashboard response (#49; docs/security.md
 * "Dashboard"), applied once at the worker edge (workers/app.ts) so SSR
 * pages, resource routes, redirects and error pages all carry them.
 *
 * ## Content-Security-Policy
 *
 * The dashboard is a React Router app with Clerk, Google-hosted fonts, and
 * two things of our own that run in the browser: the playground calls the
 * api (`API_URL`) with `fetch`, and onboarding step 4 shows the snippet in
 * an iframe (`/app/onboarding/:slug/preview`, a bare page that loads the
 * script from `SNIPPET_SRC` and queries `API_URL`). So:
 *
 *   - `script-src`: `'self'`, Clerk's Frontend API host (derived from the
 *     publishable key — `pk_test_<base64 host$>` — so a prod key points at
 *     `clerk.<domain>` without configuration), Cloudflare Turnstile (Clerk's
 *     bot check), and the snippet's origin. `'unsafe-inline'` because React
 *     Router emits an inline hydration script per page; moving to nonces is
 *     a follow-up (the framework supports it) and is listed in
 *     docs/security.md as a residual.
 *   - `connect-src`: `'self'`, Clerk's FAPI and telemetry, and the api.
 *     Locally also the Vite dev server's websocket.
 *   - `frame-src`: `'self'` (the preview iframe) and Turnstile.
 *   - `frame-ancestors 'none'`: no page of ours is framed by anyone — except
 *     the preview page, which sets its own `frame-ancestors 'self'`; a route
 *     that sets a `Content-Security-Policy` of its own keeps it, and this
 *     module adds no `X-Frame-Options` beside it (see `applySecurityHeaders`).
 *   - `img-src https:`: review avatars come from wherever the source hosts
 *     them (and Clerk's `img.clerk.com`); images are the one resource type
 *     where an open list costs nothing.
 *   - `style-src 'unsafe-inline'`: Clerk's components inject styles.
 *
 * Everything the CSP does not list is `'self'` by `default-src`;
 * `object-src 'none'`, `base-uri 'self'`. `form-action` is deliberately not
 * set: Clerk's redirect flows are navigations, but the directive has no
 * `default-src` fallback and a wrong guess would break sign-in silently.
 *
 * ## The rest
 *
 * `X-Frame-Options: DENY` (the legacy twin of `frame-ancestors`),
 * `X-Content-Type-Options: nosniff`, `Referrer-Policy:
 * strict-origin-when-cross-origin` (the default most browsers already use,
 * made explicit so a link to a customer's site never carries a path with a
 * slug or key), a `Permissions-Policy` that turns off the sensors nothing
 * here uses, and HSTS in `preview` and `prod` only — local `pnpm dev` is
 * plain HTTP.
 */

export interface SecurityHeadersEnv {
  ENVIRONMENT?: string;
  API_URL?: string;
  SNIPPET_SRC?: string;
  CLERK_PUBLISHABLE_KEY?: string;
}

/** One year, subdomains included; no `preload` until the domain is final. */
export const HSTS_VALUE = "max-age=31536000; includeSubDomains";

export const HSTS_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "preview",
  "prod",
]);

/** Clerk's bot protection widget. */
const TURNSTILE = "https://challenges.cloudflare.com";
/** Clerk JS phones home from development instances. */
const CLERK_TELEMETRY = "https://clerk-telemetry.com";

/**
 * The Frontend API origin a Clerk publishable key points at:
 * `pk_(test|live)_<base64("<host>$")>` → `https://<host>`. Null for a
 * missing or malformed key (the local auth stub has none).
 */
export function clerkFrontendApi(
  publishableKey: string | undefined,
): string | null {
  if (!publishableKey) return null;
  const match = /^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/.exec(
    publishableKey.trim(),
  );
  if (match === null) return null;
  let decoded: string;
  try {
    decoded = atob(match[1] as string);
  } catch {
    return null;
  }
  const host = decoded.replace(/\$$/, "");
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(host)) return null;
  return `https://${host.toLowerCase()}`;
}

/** `https://cdn.proofql.dev/v1.js` → `https://cdn.proofql.dev`; null if not a URL. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function sources(...values: (string | null | undefined)[]): string {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].join(" ");
}

/** The policy for `env` (module doc). */
export function contentSecurityPolicy(env: SecurityHeadersEnv): string {
  const local = env.ENVIRONMENT === "local";
  const clerk = clerkFrontendApi(env.CLERK_PUBLISHABLE_KEY);
  const api = originOf(env.API_URL);
  const snippet = originOf(env.SNIPPET_SRC);
  const directives: [string, string][] = [
    ["default-src", "'self'"],
    [
      "script-src",
      sources("'self'", "'unsafe-inline'", clerk, TURNSTILE, snippet),
    ],
    [
      "style-src",
      sources("'self'", "'unsafe-inline'", "https://fonts.googleapis.com"),
    ],
    ["font-src", sources("'self'", "https://fonts.gstatic.com", "data:")],
    ["img-src", sources("'self'", "data:", "blob:", "https:")],
    [
      "connect-src",
      sources(
        "'self'",
        clerk,
        CLERK_TELEMETRY,
        api,
        snippet,
        local ? "ws://localhost:* http://localhost:*" : null,
      ),
    ],
    ["frame-src", sources("'self'", TURNSTILE, clerk)],
    ["worker-src", "'self' blob:"],
    ["frame-ancestors", "'none'"],
    ["base-uri", "'self'"],
    ["object-src", "'none'"],
  ];
  if (!local) directives.push(["upgrade-insecure-requests", ""]);
  return directives
    .map(([name, value]) => (value === "" ? name : `${name} ${value}`))
    .join("; ");
}

/** Every header this module sets, for `env`. */
export function securityHeadersFor(
  env: SecurityHeadersEnv,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": contentSecurityPolicy(env),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
  if (env.ENVIRONMENT !== undefined && HSTS_ENVIRONMENTS.has(env.ENVIRONMENT)) {
    headers["Strict-Transport-Security"] = HSTS_VALUE;
  }
  return headers;
}

/**
 * Add the headers to a response's `Headers`. A route that set its own
 * `Content-Security-Policy` (the onboarding preview: `frame-ancestors
 * 'self'`) keeps it, and gets no `X-Frame-Options` either — the two must
 * agree, and the route has decided who may frame it. Every other header is
 * set only when absent, so a route can always be more specific.
 */
export function applySecurityHeaders(
  headers: Headers,
  env: SecurityHeadersEnv,
): void {
  const routeOwnsFraming = headers.has("Content-Security-Policy");
  for (const [name, value] of Object.entries(securityHeadersFor(env))) {
    if (
      routeOwnsFraming &&
      (name === "Content-Security-Policy" || name === "X-Frame-Options")
    ) {
      continue;
    }
    if (!headers.has(name)) headers.set(name, value);
  }
}
