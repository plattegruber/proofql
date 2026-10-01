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
 * messages never leave the worker.
 */

import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { AppEnv } from "./bindings.js";

/** Base of every `doc_url`; placeholder domain until the docs site exists. */
export const ERROR_DOCS_BASE_URL = "https://docs.proofql.com/errors";

export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "validation_failed",
  "review_limit_reached",
  "not_found",
  "payload_too_large",
  "rate_limited",
  "embedding_unavailable",
  "query_quota_exceeded",
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
  rate_limited: 429,
  // /v1/query could not embed `q` (Workers AI down or unbound): retryable,
  // and deliberately not a degraded full-text-only answer (query/route.ts).
  embedding_unavailable: 503,
  // Monthly query quota (src/quota.ts): also 429, but a distinct code so a
  // client can tell "slow down" from "upgrade or wait for the month".
  query_quota_exceeded: 429,
  internal: 500,
};

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

/** `app.onError(onError)`: `ApiError` → its envelope; anything else → 500. */
export const onError: ErrorHandler<AppEnv> = (error, c) => {
  if (error instanceof ApiError) return errorResponse(c, error);
  if (error instanceof HTTPException) {
    return errorResponse(c, fromHttpException(error));
  }
  // Workers Logs capture console output per invocation; this is the one
  // place the real cause is recorded. Nothing from it reaches the client.
  // biome-ignore lint/suspicious/noConsole: deliberate server-side error log
  console.error(`[${c.get("requestId")}] unhandled error`, error);
  return errorResponse(
    c,
    new ApiError(
      "internal",
      `Internal error. Quote request id ${c.get("requestId")} when reporting it.`,
    ),
  );
};

/** `app.notFound(notFound)`: unknown routes get the envelope too. */
export const notFound: NotFoundHandler<AppEnv> = (c) =>
  errorResponse(
    c,
    new ApiError("not_found", `No route for ${c.req.method} ${c.req.path}.`),
  );
