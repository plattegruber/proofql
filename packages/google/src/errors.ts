/**
 * Typed failures from Google, so the poller can tell "slow down" from
 * "give up" from "re-authorise" without string matching.
 *
 * Messages carry endpoint, status and Google's `status` string only — never
 * a token, never a body. NEVER-LOG(credentials) applies to everything here.
 */

/** Parse `Retry-After` — delta-seconds or an HTTP-date (RFC 9110 §10.2.3). */
export function parseRetryAfterMs(
  header: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

/** Any non-2xx (or malformed) answer from a Google data API. */
export class GoogleApiError extends Error {
  override readonly name: string = "GoogleApiError";
  constructor(
    readonly what: string,
    readonly status: number,
    /** Google's `error.status` (`PERMISSION_DENIED`, …) when the body had one. */
    readonly googleStatus: string | undefined,
    readonly retryAfterMs: number | undefined = undefined,
  ) {
    super(
      `Google ${what} failed with status ${status}${googleStatus ? ` (${googleStatus})` : ""}`,
    );
  }
}

/** 429: the shared project quota is exhausted; stop the tick, resume later. */
export class GoogleRateLimited extends GoogleApiError {
  override readonly name = "GoogleRateLimited";
}

/** 5xx: Google is having a moment; one retry, then give the connection up for this tick. */
export class GoogleUnavailable extends GoogleApiError {
  override readonly name = "GoogleUnavailable";
}

/** 401: the access token was refused; refresh and retry once, then needs_reauth. */
export class GoogleUnauthorized extends GoogleApiError {
  override readonly name = "GoogleUnauthorized";
}

/** The OAuth token endpoint refused a refresh or exchange. */
export class GoogleOAuthError extends Error {
  override readonly name: string = "GoogleOAuthError";
  constructor(
    readonly what: string,
    readonly status: number,
    /** The OAuth `error` code (`invalid_grant`, `invalid_client`, …). */
    readonly code: string | undefined,
  ) {
    super(
      `Google OAuth ${what} failed with status ${status}${code ? ` (${code})` : ""}`,
    );
  }
}

/** `invalid_grant`: the refresh token is dead (revoked, expired, 7-day testing-mode cap). */
export class GoogleInvalidGrant extends GoogleOAuthError {
  override readonly name = "GoogleInvalidGrant";
}

/** Build the right error class for a data-API response. */
export function apiErrorFor(
  what: string,
  response: Response,
  body: unknown,
  nowMs: number = Date.now(),
): GoogleApiError {
  const googleStatus = readGoogleStatus(body);
  const retryAfter = parseRetryAfterMs(
    response.headers.get("Retry-After"),
    nowMs,
  );
  if (response.status === 429) {
    return new GoogleRateLimited(what, 429, googleStatus, retryAfter);
  }
  if (response.status >= 500) {
    return new GoogleUnavailable(
      what,
      response.status,
      googleStatus,
      retryAfter,
    );
  }
  if (response.status === 401) {
    return new GoogleUnauthorized(what, 401, googleStatus);
  }
  return new GoogleApiError(what, response.status, googleStatus, retryAfter);
}

function readGoogleStatus(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === "object" && "status" in error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === "string") return status;
    }
  }
  return undefined;
}
