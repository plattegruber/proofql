/**
 * The OAuth token endpoint: refresh (#46, the poller) and the
 * authorization-code exchange (#45, the dashboard's callback).
 *
 * WebCrypto + fetch only; the token URL comes from {@link GoogleEndpoints}
 * and `fetch` is injectable, so tests run against the fake server.
 *
 * `invalid_grant` on refresh is an expected operational event, not a bug:
 * the user revoked access, the token sat unused for six months, the
 * account hit Google's 100-tokens-per-client cap, or — while the consent
 * screen is in Testing — the refresh token simply turned seven days old.
 * It surfaces as {@link GoogleInvalidGrant}; callers mark the connection
 * `needs_reauth` and never retry. Any other failure is a
 * {@link GoogleOAuthError} (transient, or a misconfigured client).
 *
 * Tokens never appear in messages or logs.
 */

import type { GoogleEndpoints } from "./endpoints.js";
import { GoogleInvalidGrant, GoogleOAuthError } from "./errors.js";
import { type OauthTokenResponse, oauthTokenResponseSchema } from "./schema.js";

export interface OAuthClientConfig {
  endpoints: Pick<GoogleEndpoints, "tokenUrl">;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch | undefined;
}

export interface IssuedTokens {
  accessToken: string;
  /** Seconds until `accessToken` expires. */
  expiresIn: number;
  /** Only on a code exchange, and only when Google granted one. */
  refreshToken?: string | undefined;
  scope?: string | undefined;
}

async function postToken(
  config: OAuthClientConfig,
  what: string,
  params: Record<string, string>,
): Promise<OauthTokenResponse> {
  const doFetch = config.fetch ?? fetch;
  const response = await doFetch(config.endpoints.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const raw: unknown = await response.json().catch(() => ({}));
  const body = oauthTokenResponseSchema.safeParse(raw);
  const code = body.success ? body.data.error : undefined;
  if (!response.ok) {
    if (code === "invalid_grant") {
      throw new GoogleInvalidGrant(what, response.status, code);
    }
    throw new GoogleOAuthError(what, response.status, code);
  }
  if (!body.success) {
    throw new GoogleOAuthError(what, response.status, "malformed_response");
  }
  return body.data;
}

function issued(what: string, body: OauthTokenResponse): IssuedTokens {
  if (!body.access_token || typeof body.expires_in !== "number") {
    throw new GoogleOAuthError(what, 200, "malformed_response");
  }
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in,
    refreshToken: body.refresh_token,
    scope: body.scope,
  };
}

/** `grant_type=refresh_token`. Throws {@link GoogleInvalidGrant} when the grant is dead. */
export async function refreshAccessToken(
  config: OAuthClientConfig,
  refreshToken: string,
): Promise<IssuedTokens> {
  const body = await postToken(config, "token refresh", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  return issued("token refresh", body);
}

/** `grant_type=authorization_code` with the PKCE verifier. */
export async function exchangeAuthorizationCode(
  config: OAuthClientConfig,
  input: { code: string; codeVerifier: string; redirectUri: string },
): Promise<IssuedTokens> {
  const body = await postToken(config, "code exchange", {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  return issued("code exchange", body);
}

/** The ISO instant `expiresIn` seconds from `now`. */
export function expiryFrom(
  expiresIn: number,
  now: number = Date.now(),
): string {
  return new Date(now + expiresIn * 1000).toISOString();
}
