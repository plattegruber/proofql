/**
 * Where Google lives, and how local dev points everything at the fake.
 *
 * Real Google spreads the connector's five endpoints across five hosts
 * (ADR 0002 §2 in well-regarded). The fake server (./fake) serves all of
 * them from one origin, so three env values are enough to redirect the
 * whole connector:
 *
 *   GOOGLE_OAUTH_BASE   consent screen origin   (real: https://accounts.google.com)
 *   GOOGLE_TOKEN_URL    token endpoint          (real: https://oauth2.googleapis.com/token)
 *   GOOGLE_API_BASE     ONE origin for the three data APIs below; when set it
 *                       replaces all three real hosts (local dev / tests);
 *                       when unset each API uses its real host.
 *
 * Every function in this package takes a resolved {@link GoogleEndpoints};
 * nothing reads `process.env` or a Worker `env` directly, so a test can
 * build its own and inject the fake's `app.fetch`.
 */

export interface GoogleEndpointEnv {
  GOOGLE_OAUTH_BASE?: string | undefined;
  GOOGLE_TOKEN_URL?: string | undefined;
  GOOGLE_API_BASE?: string | undefined;
}

export interface GoogleEndpoints {
  /** `GET {authorizeUrl}?client_id=…` — the consent screen. */
  authorizeUrl: string;
  /** `POST {tokenUrl}` — code exchange and refresh. */
  tokenUrl: string;
  /** Account Management v1 origin: `GET {accountsBase}/v1/accounts`. */
  accountsBase: string;
  /** Business Information v1 origin: `GET {locationsBase}/v1/accounts/{a}/locations`. */
  locationsBase: string;
  /** My Business v4 origin: `GET {reviewsBase}/v4/accounts/{a}/locations/{l}/reviews`. */
  reviewsBase: string;
}

export const REAL_GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  accountsBase: "https://mybusinessaccountmanagement.googleapis.com",
  locationsBase: "https://mybusinessbusinessinformation.googleapis.com",
  reviewsBase: "https://mybusiness.googleapis.com",
};

/** The only Business Profile scope Google offers; every read needs it. */
export const GOOGLE_BUSINESS_MANAGE_SCOPE =
  "https://www.googleapis.com/auth/business.manage";

function origin(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Resolve the endpoints from env, falling back to real Google per value. */
export function resolveGoogleEndpoints(
  env: GoogleEndpointEnv = {},
): GoogleEndpoints {
  const apiBase = env.GOOGLE_API_BASE?.trim();
  const oauthBase = env.GOOGLE_OAUTH_BASE?.trim();
  const tokenUrl = env.GOOGLE_TOKEN_URL?.trim();
  return {
    authorizeUrl: oauthBase
      ? `${origin(oauthBase)}/o/oauth2/v2/auth`
      : REAL_GOOGLE_ENDPOINTS.authorizeUrl,
    tokenUrl: tokenUrl || REAL_GOOGLE_ENDPOINTS.tokenUrl,
    accountsBase: apiBase
      ? origin(apiBase)
      : REAL_GOOGLE_ENDPOINTS.accountsBase,
    locationsBase: apiBase
      ? origin(apiBase)
      : REAL_GOOGLE_ENDPOINTS.locationsBase,
    reviewsBase: apiBase ? origin(apiBase) : REAL_GOOGLE_ENDPOINTS.reviewsBase,
  };
}
