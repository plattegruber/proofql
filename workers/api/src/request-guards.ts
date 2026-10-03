/**
 * Request-shape guards for every `/v1/*` request that carries a body (#49),
 * mounted once in `createApp` so no route can forget them:
 *
 *   - **415 `unsupported_media_type`** unless `Content-Type` is
 *     `application/json` (parameters such as `charset` are fine). Every
 *     write route parses JSON and nothing else; a form post, a text body,
 *     or a multipart upload aimed at the API is refused before any of it is
 *     read. A request with no body at all (`POST /v1/query` asking for the
 *     newest reviews) needs no media type and passes.
 *   - **413 `payload_too_large`** over a per-path ceiling, checked from
 *     `Content-Length` when present and otherwise while the body streams
 *     (Hono's `bodyLimit`). `/v1/query` takes 16 KiB — a maximal query is
 *     well under 2 KiB — and every other route 1 MiB, the ingest limit,
 *     as a backstop for routes that set no tighter limit of their own.
 *     The route-level limits in routes/reviews.ts (1 MiB) and
 *     routes/reviews-crud.ts (64 KiB) still apply and are the ones the
 *     spec documents per route; this guard is the floor under them.
 *
 * Both run before authentication, like the route-level body limits: they
 * are header checks that cost nothing, and a body we will not accept
 * should not earn a digest or a database round-trip. Rate-limit headers
 * are therefore absent on these responses, as the spec says.
 */

import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";

import type { AppEnv } from "./bindings.js";
import { ApiError } from "./errors.js";

/** `/v1/query`: a maximal request body is ~2 KiB. */
export const QUERY_BODY_LIMIT_BYTES = 16 * 1024;
/** Everything else under `/v1`: equals the ingest limit, the largest route. */
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

/** Methods whose body a route reads. */
export const BODY_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PATCH",
  "PUT",
]);

/** The body ceiling for a path (module doc). */
export function bodyLimitFor(path: string): number {
  return path === "/v1/query" || path.startsWith("/v1/query/")
    ? QUERY_BODY_LIMIT_BYTES
    : DEFAULT_BODY_LIMIT_BYTES;
}

/** `application/json`, with or without parameters; case-insensitive. */
export function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const mediaType = value.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function isV1(path: string): boolean {
  return path === "/v1" || path.startsWith("/v1/");
}

/** Whether the request carries a body at all (`Content-Length: 0` does not). */
function hasBody(raw: Request): boolean {
  if (raw.body === null) return false;
  return raw.headers.get("content-length") !== "0";
}

const limiters = new Map<number, ReturnType<typeof bodyLimit>>();

function limiterFor(maxSize: number) {
  let limiter = limiters.get(maxSize);
  if (limiter === undefined) {
    limiter = bodyLimit({
      maxSize,
      onError: () => {
        throw new ApiError(
          "payload_too_large",
          `Request body exceeds ${maxSize} bytes.`,
        );
      },
    });
    limiters.set(maxSize, limiter);
  }
  return limiter;
}

export const requestGuards = createMiddleware<AppEnv>(async (c, next) => {
  if (
    !isV1(c.req.path) ||
    !BODY_METHODS.has(c.req.method) ||
    !hasBody(c.req.raw)
  ) {
    await next();
    return;
  }
  if (!isJsonContentType(c.req.header("content-type"))) {
    throw new ApiError(
      "unsupported_media_type",
      "Request bodies must be JSON: send `Content-Type: application/json`.",
    );
  }
  await limiterFor(bodyLimitFor(c.req.path))(c, next);
});
