/**
 * The cdn worker's request handling, as pure functions over the Fetch API
 * so Vitest can drive it under Node with a fake assets binding (no workerd).
 *
 * Every file comes from the `ASSETS` static-assets binding (the `public/`
 * directory, built by scripts/build.mjs); this module decides the headers:
 *
 * - `/v1.js`, `/v1.js.map`, `/version.json`, `/demo/…`: the mutable
 *   paths. `public, max-age=300, stale-while-revalidate=86400` — a release
 *   reaches every browser within five minutes, and a CDN edge may keep
 *   serving the previous build for a day while it revalidates, so a slow
 *   origin never blanks a customer's page.
 * - `/v1.<hash>.js`, `/v1.<hash>.js.map`: content-addressed, so
 *   `public, max-age=31536000, immutable`. The hashed file is the stable
 *   reference (docs, pinned integrations); `/v1.js` is what the snippet tag
 *   uses.
 * - `X-Content-Type-Options: nosniff` on everything; `Access-Control-Allow-
 *   Origin: *` on the snippet files (a script tag needs no CORS, a
 *   fetch-based loader or a source-map fetch from devtools does). The
 *   worker sets no cookies and strips any `Set-Cookie` an upstream could
 *   add: the response is identical for everyone, which is what makes it
 *   cacheable.
 * - `/health`: `{ ok: true, version, hash }` read from `/version.json`, so a
 *   deploy whose build step did not run reports unhealthy (503) instead of
 *   serving a stale or missing snippet behind a green smoke check.
 * - `/` redirects to `/demo/` — there is nothing else a person could want at
 *   the root of a CDN host.
 */

/** The subset of the `ASSETS` binding this module needs (Fetcher#fetch). */
export interface AssetSource {
  fetch(request: Request): Promise<Response>;
}

export const MUTABLE_CACHE_CONTROL =
  "public, max-age=300, stale-while-revalidate=86400";
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const NO_STORE = "no-store";

const HASHED_SNIPPET = /^\/v1\.[0-9a-f]{8}\.js(\.map)?$/;
const LATEST_SNIPPET = /^\/v1\.js(\.map)?$/;

/** `/v1.js`, `/v1.js.map`, `/v1.<hash>.js`, `/v1.<hash>.js.map`. */
export function isSnippetPath(pathname: string): boolean {
  return LATEST_SNIPPET.test(pathname) || HASHED_SNIPPET.test(pathname);
}

/** `/v1.<8 hex>.js` (and its map): content-addressed, never changes. */
export function isImmutablePath(pathname: string): boolean {
  return HASHED_SNIPPET.test(pathname);
}

/** The `Cache-Control` for a successful response at `pathname`. */
export function cacheControlFor(pathname: string): string {
  return isImmutablePath(pathname)
    ? IMMUTABLE_CACHE_CONTROL
    : MUTABLE_CACHE_CONTROL;
}

/** Content types the asset layer might leave unset; keyed by extension. */
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(pathname: string): string | undefined {
  const dot = pathname.lastIndexOf(".");
  return dot === -1 ? undefined : CONTENT_TYPES[pathname.slice(dot)];
}

/**
 * The headers every response carries, plus CORS for the snippet files.
 * Applied to the asset response *and* to errors, so a 404 is `nosniff` too.
 */
export function securityHeaders(pathname: string): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
  };
  if (isSnippetPath(pathname)) {
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
    // A year, the maximum browsers honour; the answer never changes.
    headers["Access-Control-Max-Age"] = "86400";
    // The snippet exists to be embedded by other origins (#49): say so
    // explicitly, so a customer page that opts into cross-origin isolation
    // (COEP: require-corp) can still load it. Everything else on this host
    // (demo, version.json, health) keeps the browser default.
    headers["Cross-Origin-Resource-Policy"] = "cross-origin";
  }
  return headers;
}

/**
 * Rebuild `response` with the cdn's headers: the asset layer's own
 * `Cache-Control`, `ETag` semantics and cookies are replaced wholesale.
 */
export function withCdnHeaders(response: Response, pathname: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("Set-Cookie");
  for (const [name, value] of Object.entries(securityHeaders(pathname))) {
    headers.set(name, value);
  }
  if (response.ok) {
    headers.set("Cache-Control", cacheControlFor(pathname));
    const type = contentTypeFor(pathname);
    if (type !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", type);
    }
  } else if (response.status >= 400) {
    // Never let an edge cache a 404 for the five minutes a hit would get:
    // the next deploy fixes the path and must be visible at once.
    headers.set("Cache-Control", NO_STORE);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(body: unknown, status: number, pathname: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": NO_STORE,
      ...securityHeaders(pathname),
    },
  });
}

/** What scripts/build.mjs writes to public/version.json. */
export interface VersionManifest {
  version: string;
  hash: string;
  builtAt: string;
}

export function isVersionManifest(value: unknown): value is VersionManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === "string" &&
    typeof v.hash === "string" &&
    typeof v.builtAt === "string"
  );
}

/** Read `/version.json` through the binding; null when missing or malformed. */
export async function readVersion(
  assets: AssetSource,
  origin: string,
): Promise<VersionManifest | null> {
  try {
    const res = await assets.fetch(
      new Request(new URL("/version.json", origin)),
    );
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isVersionManifest(body) ? body : null;
  } catch {
    return null;
  }
}

async function health(
  request: Request,
  assets: AssetSource,
): Promise<Response> {
  const url = new URL(request.url);
  const manifest = await readVersion(assets, url.origin);
  if (manifest === null) {
    return json(
      { ok: false, error: "version.json missing: public/ was not built" },
      503,
      url.pathname,
    );
  }
  return json(
    { ok: true, version: manifest.version, hash: manifest.hash },
    200,
    url.pathname,
  );
}

/** Route one request. Never throws: an unexpected failure is a 500 JSON. */
export async function handleRequest(
  request: Request,
  assets: AssetSource,
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === "OPTIONS") {
    // Preflight for a fetch-based loader; the snippet files are the only
    // cross-origin resources, everything else answers with no CORS grant.
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": NO_STORE, ...securityHeaders(pathname) },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method_not_allowed" }, 405, pathname);
  }

  if (pathname === "/health") return health(request, assets);

  if (pathname === "/") {
    return new Response(null, {
      status: 302,
      headers: {
        Location: new URL("/demo/", url.origin).toString(),
        "Cache-Control": NO_STORE,
        ...securityHeaders(pathname),
      },
    });
  }

  try {
    // The asset layer handles `/demo` → `/demo/` → index.html itself
    // (html_handling in wrangler.jsonc); the redirect passes through here.
    const response = await assets.fetch(request);
    return withCdnHeaders(response, pathname);
  } catch {
    return json({ error: "asset_fetch_failed" }, 500, pathname);
  }
}
