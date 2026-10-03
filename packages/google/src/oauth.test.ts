import { describe, expect, it } from "vitest";

import { resolveGoogleEndpoints } from "./endpoints.js";
import { GoogleInvalidGrant, GoogleOAuthError } from "./errors.js";
import { createFakeGoogle } from "./fake/app.js";
import {
  exchangeAuthorizationCode,
  expiryFrom,
  refreshAccessToken,
} from "./oauth.js";

function config(fake = createFakeGoogle()) {
  return {
    fake,
    config: {
      endpoints: resolveGoogleEndpoints({
        GOOGLE_TOKEN_URL: "http://fake/token",
      }),
      clientId: "client",
      clientSecret: "secret",
      fetch: fake.fetch,
    },
  };
}

describe("refreshAccessToken", () => {
  it("mints a new access token for a live refresh token", async () => {
    const { fake, config: cfg } = config();
    const { refreshToken } = fake.store.issueTokens();
    const issued = await refreshAccessToken(cfg, refreshToken);
    expect(issued.expiresIn).toBe(3600);
    expect(fake.store.isAccessTokenValid(issued.accessToken)).toBe(true);
    expect(issued.refreshToken).toBeUndefined();
  });

  it("throws GoogleInvalidGrant for a revoked token or the invalid_grant knob", async () => {
    const { fake, config: cfg } = config();
    const { refreshToken } = fake.store.issueTokens();
    fake.store.revokeRefreshToken(refreshToken);
    await expect(refreshAccessToken(cfg, refreshToken)).rejects.toBeInstanceOf(
      GoogleInvalidGrant,
    );
    const live = fake.store.issueTokens();
    fake.store.invalidGrant = true;
    const error = await refreshAccessToken(cfg, live.refreshToken).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(GoogleInvalidGrant);
    expect(error.code).toBe("invalid_grant");
    expect(error.message).not.toContain(live.refreshToken);
  });

  it("surfaces other failures as GoogleOAuthError, never as invalid_grant", async () => {
    const { config: cfg } = config();
    const broken = {
      ...cfg,
      fetch: async () =>
        Response.json({ error: "invalid_client" }, { status: 401 }),
    };
    const error = await refreshAccessToken(broken, "rt").catch((e) => e);
    expect(error).toBeInstanceOf(GoogleOAuthError);
    expect(error).not.toBeInstanceOf(GoogleInvalidGrant);
    expect(error.code).toBe("invalid_client");
    const malformed = {
      ...cfg,
      fetch: async () => Response.json({ token_type: "Bearer" }),
    };
    await expect(refreshAccessToken(malformed, "rt")).rejects.toMatchObject({
      code: "malformed_response",
    });
  });
});

describe("exchangeAuthorizationCode", () => {
  it("exchanges a code issued with offline+consent for tokens including a refresh token", async () => {
    const { fake, config: cfg } = config();
    const code = fake.store.issueAuthCode({ withRefreshToken: true });
    const issued = await exchangeAuthorizationCode(cfg, {
      code,
      codeVerifier: "verifier",
      redirectUri: "http://localhost:8799/app/integrations/google/callback",
    });
    expect(issued.refreshToken).toMatch(/^rt_/);
    expect(fake.store.isAccessTokenValid(issued.accessToken)).toBe(true);
    // Single use.
    await expect(
      exchangeAuthorizationCode(cfg, {
        code,
        codeVerifier: "verifier",
        redirectUri: "x",
      }),
    ).rejects.toBeInstanceOf(GoogleInvalidGrant);
  });

  it("omits the refresh token when consent was not re-prompted", async () => {
    const { fake, config: cfg } = config();
    const code = fake.store.issueAuthCode({ withRefreshToken: false });
    const issued = await exchangeAuthorizationCode(cfg, {
      code,
      codeVerifier: "v",
      redirectUri: "x",
    });
    expect(issued.refreshToken).toBeUndefined();
  });

  it("computes the expiry instant", () => {
    expect(expiryFrom(3600, Date.parse("2026-10-01T00:00:00Z"))).toBe(
      "2026-10-01T01:00:00.000Z",
    );
  });
});
