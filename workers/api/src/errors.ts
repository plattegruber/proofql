/**
 * The standard error envelope (scope.md §3): every non-2xx response is
 *
 *   { "error": { "code", "message", "doc_url", "request_id", "details"? } }
 *
 * `code` is a short stable string clients can switch on; `message` is for a
 * human; `doc_url` points at the docs anchor for the code. `request_id` is
 * the same value as the `x-request-id` header, so a support ticket can
 * quote one string. `details` is present only for validation failures.
 *
 * Route code throws `ApiError`; `onError` turns it into the envelope.
 * Anything else that is thrown becomes a 500 `internal` whose body carries
 * the request id and nothing about the cause — stack traces and driver
 * messages never leave the worker. One exception (#108): a database
 * connection failure (`isDatabaseUnavailable`, src/db.ts — SQLSTATE 53300
 * "too many clients", connect timeouts, refused sockets) is a 503
 * `service_unavailable` with `Retry-After: 1`, because the client can
 * retry it and nothing about the request was wrong; the snippet already
 * renders nothing on any non-2xx, and a server-side caller gets the same
 * contract `embedding_unavailable` has. The same 503 answers an exhausted
 * daily platform quota (#142: Hyperdrive's `Usage limit for account
 * exceeded, usage renews at …`, KV's `… limit exceeded for the day`;
 * `quotaExhaustion`, src/db.ts), with `Retry-After` set to the seconds until
 * the stated renewal (300 when none is stated) and one `quota.exhausted`
 * line at level error.
 *
 * Logging (docs/observability.md): every `ApiError` is one
 * `<route>.rejected` line (`query.rejected`, `reviews.rejected`, else
 * `request.rejected`) with `code` and `status`, so 4xx rates per route and
 * per code are a filter away; an unhandled error is one `request.failed`
 * line at level error with the cause — the only place it is recorded. A
 * connection failure is one `db.unavailable` line (warn, with the code)
 * followed by the route's `*.rejected` with `code: service_unavailable`.
 */

import { errorFields } from "@proofql/core";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { AppEnv } from "./bindings.js";
import { databaseUnavailableCode, quotaExhaustion } from "./db.js";
import { logFor } from "./request-id.js";

/** Base of every `doc_url`; placeholder domain until the docs site exists. */
export const ERROR_DOCS_BASE_URL = "https://docs.proofql.com/errors";

export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "validation_failed",
  "review_limit_reached",
  "not_found",
  "payload_too_large",
  "unsupported_media_type",
  "rate_limited",
  "embedding_unavailable",
  "query_quota_exceeded",
  "service_unavailable",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, ContentfulStatusCode> = {
  unauthorized: 401,
  forbidden: 403,
  validation_failed: 422,
  review_limit_reached: 422,
  not_found: 404,
  payload_too_large: 413,
  // A body that is not `application/json` (src/request-guards.ts).
  unsupported_media_type: 415,
  rate_limited: 429,
  // /v1/query could not embed `q` (Workers AI down or unbound): retryable,
  // and deliberately not a degraded full-text-only answer (query/route.ts).
  embedding_unavailable: 503,
  // Monthly query quota (src/quota.ts): also 429, but a distinct code so a
  // client can tell "slow down" from "upgrade or wait for the month".
  query_quota_exceeded: 429,
  // The database refused or timed out a connection (src/db.ts
  // `isDatabaseUnavailable`): retryable, with `Retry-After`.
  service_unavailable: 503,
  internal: 500,
};

/** `Retry-After` on a 503 `service_unavailable`: a connection storm clears in seconds. */
export const SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS = 1;

/** One flattened zod issue: `path` is dotted (`"0.rating"`), `""` at the root. */
export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    doc_url: string;
    request_id: string;
    details?: ValidationIssue[];
  };
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: ContentfulStatusCode;
  readonly details: ValidationIssue[] | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: ValidationIssue[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details;
  }
}

export function docUrl(code: ErrorCode): string {
  return `${ERROR_DOCS_BASE_URL}#${code}`;
}

/** Build the envelope body for a code. */
export function errorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: ValidationIssue[],
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      doc_url: docUrl(code),
      request_id: requestId,
      ...(details === undefined ? {} : { details }),
    },
  };
}

/** Respond with an `ApiError` as the standard envelope. */
export function errorResponse(c: Context<AppEnv>, error: ApiError): Response {
  return c.json(
    errorBody(error.code, error.message, c.get("requestId"), error.details),
    error.status,
  );
}

/**
 * Hono's own exceptions (e.g. from built-in middleware) mapped onto the
 * codes above; anything unmapped is `internal`.
 */
function fromHttpException(error: HTTPException): ApiError {
  switch (error.status) {
    case 401:
      return new ApiError("unauthorized", "Unauthorized.");
    case 403:
      return new ApiError("forbidden", "Forbidden.");
    case 404:
      return new ApiError("not_found", "Not found.");
    case 413:
      return new ApiError("payload_too_large", "Request body is too large.");
    case 429:
      return new ApiError("rate_limited", "Too many requests.");
    default:
      return new ApiError("internal", "Internal error.");
  }
}

/** `query.rejected` for `/v1/query`, `reviews.rejected` for `/v1/reviews…`, else `request.rejected`. */
export function rejectionEvent(path: string): string {
  if (path === "/v1/query" || path.startsWith("/v1/query/")) {
    return "query.rejected";
  }
  if (path === "/v1/reviews" || path.startsWith("/v1/reviews/")) {
    return "reviews.rejected";
  }
  return "request.rejected";
}

/** One line per refused request (module doc). Auth fields when auth ran. */
function logRejected(c: Context<AppEnv>, error: ApiError): void {
  const auth = c.get("auth");
  logFor(c).log(rejectionEvent(c.req.path), {
    level: error.status >= 500 ? "error" : "warn",
    code: error.code,
    status: error.status,
    ...(auth === undefined
      ? {}
      : {
          project_id: auth.projectId,
          key_environment: auth.environment,
          key_kind: auth.kind,
        }),
  });
}

/** `app.onError(onError)`: `ApiError` → its envelope; anything else → 500. */
export const onError: ErrorHandler<AppEnv> = (error, c) => {
  if (error instanceof ApiError) {
    logRejected(c, error);
    return errorResponse(c, error);
  }
  if (error instanceof HTTPException) {
    const mapped = fromHttpException(error);
    logRejected(c, mapped);
    return errorResponse(c, mapped);
  }
  const quota = quotaExhaustion(error);
  if (quota !== null) {
    // docs/observability.md `quota.exhausted` (#142, #158): a daily
    // platform allowance is spent — Hyperdrive's 100,000 queries or KV's
    // reads/writes on the Workers Free plan. Level error so it alerts: until
    // the renewal every request that needs that resource fails, for every
    // tenant. The client gets a retryable 503 that says when.
    logFor(c).log("quota.exhausted", {
      level: "error",
      resource: quota.resource,
      retry_after: quota.retryAfter,
      renews_at: quota.renewsAt,
      error: errorFields(error),
    });
    c.header("Retry-After", String(quota.retryAfter));
    const mapped = new ApiError(
      "service_unavailable",
      `ProofQL is temporarily over its daily capacity; retry in ${quota.retryAfter} seconds. Quote request id ${c.get("requestId")} if it persists.`,
      { cause: error },
    );
    logRejected(c, mapped);
    return errorResponse(c, mapped);
  }
  const unavailable = databaseUnavailableCode(error);
  if (unavailable !== null) {
    // docs/observability.md `db.unavailable`: the SQLSTATE / driver code is
    // the diagnosis (53300 = Hyperdrive's origin limit or Neon's
    // max_connections; CONNECT_TIMEOUT = the pool queue outlasted the
    // connect timeout). No stack: the cause is a known shape, not a bug.
    logFor(c).log("db.unavailable", {
      level: "warn",
      code: unavailable,
      error: errorFields(error),
    });
    c.header("Retry-After", String(SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS));
    const mapped = new ApiError(
      "service_unavailable",
      `The database is temporarily unavailable; retry in ${SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS} second. Quote request id ${c.get("requestId")} if it persists.`,
      { cause: error },
    );
    logRejected(c, mapped);
    return errorResponse(c, mapped);
  }
  // The one place the real cause is recorded (Workers Logs); nothing from
  // it reaches the client. The stack is kept here, and only here, because a
  // 500 with no stack is undiagnosable — it never carries user content.
  logFor(c).log("request.failed", {
    error: errorFields(error),
    stack: error instanceof Error ? error.stack?.slice(0, 2000) : undefined,
  });
  return errorResponse(
    c,
    new ApiError(
      "internal",
      `Internal error. Quote request id ${c.get("requestId")} when reporting it.`,
    ),
  );
};

/** `app.notFound(notFound)`: unknown routes get the envelope, and a `*.rejected` line, too. */
export const notFound: NotFoundHandler<AppEnv> = (c) => {
  const error = new ApiError(
    "not_found",
    `No route for ${c.req.method} ${c.req.path}.`,
  );
  logRejected(c, error);
  return errorResponse(c, error);
};
