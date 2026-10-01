/**
 * One id per request, on every response as `x-request-id` and inside every
 * error envelope. Reuses the caller's `x-request-id` when present (so a
 * client can correlate its own logs), else Cloudflare's `cf-ray`, else a
 * fresh uuid. Must run first so error responses have it too.
 */

import { createMiddleware } from "hono/factory";

import type { AppEnv } from "./bindings.js";

export const REQUEST_ID_HEADER = "x-request-id";

/** Caller-supplied ids are capped so a hostile header cannot bloat logs. */
const MAX_INCOMING_LENGTH = 128;

export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header(REQUEST_ID_HEADER) ?? c.req.header("cf-ray");
  const id =
    incoming !== undefined &&
    incoming.length > 0 &&
    incoming.length <= MAX_INCOMING_LENGTH
      ? incoming
      : crypto.randomUUID();
  c.set("requestId", id);
  await next();
  c.res.headers.set(REQUEST_ID_HEADER, id);
});
