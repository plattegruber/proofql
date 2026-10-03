/**
 * One id per request, on every response as `x-request-id` and inside every
 * error envelope — and one logger per request that carries it (#30).
 *
 * The id reuses the caller's `x-request-id` when present (so a client can
 * correlate its own logs), else Cloudflare's `cf-ray`, else a fresh uuid.
 * The middleware runs first so error responses have both.
 *
 * `c.get("log")` is a child of the worker's base logger
 * (`@proofql/core` `createLogger`, service `api`, environment from
 * `env.ENVIRONMENT`) bound to `request_id`, `method`, and `path`. Every
 * line the request emits goes through it, so filtering Workers Logs on one
 * `request_id` shows the whole request without any call site having to
 * pass the id along. Route code never calls `console.*`.
 */

import { createLogger, type Logger, type LogSink } from "@proofql/core";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { AppEnv } from "./bindings.js";

export const REQUEST_ID_HEADER = "x-request-id";

/** Caller-supplied ids are capped so a hostile header cannot bloat logs. */
const MAX_INCOMING_LENGTH = 128;

/**
 * And restricted to a token charset (#49): the id is echoed in a response
 * header and written into every log line, so a value carrying newlines,
 * quotes or control characters would be a log-injection vector. Anything a
 * uuid, a ray id, or a sensible client correlation id needs is here;
 * anything else earns a fresh uuid rather than an error.
 */
const INCOMING_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Whether a caller-supplied id is one we will echo and log. */
export function isAcceptableRequestId(value: string): boolean {
  return value.length <= MAX_INCOMING_LENGTH && INCOMING_ID_PATTERN.test(value);
}

export interface RequestContextOptions {
  /** Where log lines go; tests pass `recordingSink().sink`. Default: console. */
  sink?: LogSink;
}

/** The id for this request (module doc). */
export function resolveRequestId(c: Context<AppEnv>): string {
  const incoming = c.req.header(REQUEST_ID_HEADER) ?? c.req.header("cf-ray");
  return incoming !== undefined && isAcceptableRequestId(incoming)
    ? incoming
    : crypto.randomUUID();
}

/**
 * The worker-level logger for a request's `env`. `c.env` is undefined under
 * `app.request()` with no bindings (the type says otherwise), hence the
 * optional shape.
 */
function baseLogger(c: Context<AppEnv>, sink: LogSink | undefined): Logger {
  const env = c.env as { ENVIRONMENT?: string } | undefined;
  return createLogger({
    service: "api",
    environment: env?.ENVIRONMENT ?? "unknown",
    ...(sink === undefined ? {} : { sink }),
  });
}

/**
 * Installs `c.get("requestId")` and `c.get("log")`, and echoes the id on
 * the response. Mounted first in `createApp`.
 */
export function requestContext(options: RequestContextOptions = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const id = resolveRequestId(c);
    c.set("requestId", id);
    c.set(
      "log",
      baseLogger(c, options.sink).child({
        request_id: id,
        method: c.req.method,
        path: c.req.path,
      }),
    );
    await next();
    c.res.headers.set(REQUEST_ID_HEADER, id);
  });
}

/** The default middleware (console sink), for tests that mount it directly. */
export const requestId = requestContext();

/**
 * This request's logger. Falls back to an unbound base logger when the
 * middleware did not run (a hand-built test app), so no code path has to
 * check before logging.
 */
export function logFor(c: Context<AppEnv>): Logger {
  return c.get("log") ?? baseLogger(c, undefined);
}
