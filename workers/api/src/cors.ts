/**
 * CORS for publishable keys on `/v1/query` (scope.md §3 "Keys").
 *
 * A `pq_pk_…` key is public by design (it ships in page source), so the
 * *origin* is what scopes it: the request must carry an `Origin` header
 * that is in the project's `allowed_origins`, compared as a whole origin —
 * scheme, host and port, after URL normalization (`HTTPS://Shop.Example:443`
 * equals `https://shop.example`); no wildcards, no subdomain matching. A
 * missing or unlisted origin is a 403 whose message says what to add where.
 * Secret keys skip the check: they are server-to-server and an Origin, if
 * present, is simply echoed.
 *
 * Preflight (`OPTIONS /v1/query`) runs without authentication but still
 * echoes only listed origins: it reads the key from `?key=` (what the
 * snippet's GET URL carries, and the only place a browser preflight can
 * carry it — browsers strip `Authorization` from preflights) or, for
 * non-browser clients that send one anyway, from the Authorization header.
 * With no resolvable key or an unlisted origin, the preflight succeeds
 * (204) with no `Access-Control-Allow-Origin`, and the browser blocks the
 * real request itself.
 */

import type { Context } from "hono";

import type { AppEnv, AuthContext } from "./bindings.js";
import { ApiError } from "./errors.js";

/** Methods and headers `/v1/query` accepts cross-origin. */
export const PREFLIGHT_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "600",
} as const;

/** `https://Shop.Example:443/` → `https://shop.example`; null if not a URL. */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // `new URL("https://a.example/path").origin` drops the path, so an
    // allowlist entry pasted with a trailing slash or path still matches.
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Whether `origin` (the request's `Origin` header) is one of `allowed`.
 * `"null"` (opaque origins: sandboxed iframes, `file://`) never matches.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined || origin === "null") return false;
  const wanted = normalizeOrigin(origin);
  if (wanted === null) return false;
  return allowed.some((entry) => normalizeOrigin(entry) === wanted);
}

/**
 * Decide the CORS outcome for an authenticated `/v1/query` request:
 * returns the origin to echo in `Access-Control-Allow-Origin` (or null for
 * none), or throws the 403 a publishable key earns with a bad origin.
 */
export function corsOriginFor(
  origin: string | undefined,
  auth: AuthContext,
): string | null {
  if (auth.kind === "secret") return origin ?? null;
  if (origin === undefined) {
    throw new ApiError(
      "forbidden",
      "Publishable keys (pq_pk_…) are browser keys: the request must include an Origin header from a page on one of the project's allowed origins. From a server, use a secret key (pq_sk_…) instead.",
    );
  }
  if (!isAllowedOrigin(origin, auth.project.allowedOrigins)) {
    throw new ApiError(
      "forbidden",
      `Origin ${origin} is not in this project's allowed origins. Add it under Project settings → Allowed origins (exact scheme, host, and port) to use a publishable key from that page.`,
    );
  }
  return origin;
}

/**
 * Set the per-origin response headers. `Vary: Origin` goes on every
 * `/v1/query` response, allowed or not, because the response differs by
 * origin and a shared cache (#28) must not serve one origin's headers to
 * another.
 */
export function applyCorsHeaders(
  c: Context<AppEnv>,
  allowOrigin: string | null,
): void {
  c.header("Vary", "Origin");
  if (allowOrigin !== null) {
    c.header("Access-Control-Allow-Origin", allowOrigin);
  }
}
