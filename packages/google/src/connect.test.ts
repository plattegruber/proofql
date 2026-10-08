import { describe, expect, it } from "vitest";
import { createGoogleClient } from "./client.js";
import {
  applyLocationSelection,
  buildAuthorizeUrl,
  CONNECT_TTL_SECONDS,
  type ConnectState,
  codeChallengeS256,
  discoverLocations,
  formatAddress,
  generateCodeVerifier,
  generateNonce,
  mergeLocationMapping,
  StateError,
  signState,
  verifyState,
} from "./connect.js";
import { resolveGoogleEndpoints } from "./endpoints.js";
import { createFakeGoogle } from "./fake/app.js";

const SECRET = "test-state-secret";
const NOW = 1_800_000_000;
const state: ConnectState = {
  projectId: "p1",
  accountId: "a1",
  nonce: "n1",
  exp: NOW + CONNECT_TTL_SECONDS,
};

describe("PKCE", () => {
  it("derives the RFC 7636 appendix B challenge", async () => {
    expect(
      await codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates distinct 43-char base64url verifiers and 22-char nonces", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateNonce()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("state", () => {
  it("round-trips a signed payload", async () => {
    const signed = await signState(SECRET, state);
    expect(signed).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyState(SECRET, signed, NOW)).toEqual(state);
  });

  it("rejects a tampered payload, a wrong secret, and an expired state", async () => {
    const signed = await signState(SECRET, state);
    const [payload, sig] = signed.split(".") as [string, string];
    const forged = `${btoa(JSON.stringify({ ...state, projectId: "p2" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}.${sig}`;
    await expect(verifyState(SECRET, forged, NOW)).rejects.toMatchObject({
      name: "StateError",
      reason: "bad_signature",
    });
    await expect(verifyState("other", signed, NOW)).rejects.toMatchObject({
      reason: "bad_signature",
    });
    await expect(verifyState(SECRET, signed, state.exp)).rejects.toMatchObject({
      reason: "expired",
    });
    await expect(verifyState(SECRET, payload, NOW)).rejects.toBeInstanceOf(
      StateError,
    );
    await expect(verifyState(SECRET, "..", NOW)).rejects.toMatchObject({
      reason: "malformed",
    });
    await expect(verifyState(SECRET, "%%%.%%%", NOW)).rejects.toMatchObject({
      reason: "malformed",
    });
  });

  it("rejects a well-signed payload of the wrong shape", async () => {
    const odd = await signState(SECRET, {
      nope: true,
    } as unknown as ConnectState);
    await expect(verifyState(SECRET, odd, NOW)).rejects.toMatchObject({
      reason: "malformed",
    });
  });
});

describe("buildAuthorizeUrl", () => {
  it("asks for business.manage offline with consent and PKCE S256", () => {
    const url = new URL(
      buildAuthorizeUrl(resolveGoogleEndpoints(), {
        clientId: "cid",
        redirectUri: "https://app.proofql.dev/app/integrations/google/callback",
        state: "st",
        codeChallenge: "ch",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cid",
      redirect_uri: "https://app.proofql.dev/app/integrations/google/callback",
      response_type: "code",
      scope: "https://www.googleapis.com/auth/business.manage",
      access_type: "offline",
      prompt: "consent",
      code_challenge: "ch",
      code_challenge_method: "S256",
      state: "st",
    });
    expect(
      buildAuthorizeUrl(
        resolveGoogleEndpoints({ GOOGLE_OAUTH_BASE: "http://localhost:8802" }),
        {
          clientId: "c",
          redirectUri: "r",
          state: "s",
          codeChallenge: "k",
        },
      ),
    ).toMatch(/^http:\/\/localhost:8802\/o\/oauth2\/v2\/auth\?/);
  });
});

describe("discovery", () => {
  it("flattens accounts × locations with the verified flag, all disabled", async () => {
    const fake = createFakeGoogle();
    const { accessToken } = fake.store.issueTokens();
    const client = createGoogleClient({
      endpoints: resolveGoogleEndpoints(),
      fetch: fake.fetch,
    });
    const found = await discoverLocations(client, accessToken);
    expect(found.accounts).toEqual({ "100": "Cedar Ridge Dental Group" });
    expect(found.locations).toEqual([
      {
        id: "201",
        account: "100",
        title: "Cedar Ridge Dental — North",
        address: "1420 Cedar Ridge Pkwy, Boulder, CO 80301",
        verified: true,
        enabled: false,
        placeId: "ChIJnorth0000000000000001",
        // Business Profile's primary category (#151).
        primaryCategory: "categories/gcid:dentist",
      },
      expect.objectContaining({ id: "202", verified: true, enabled: false }),
      expect.objectContaining({ id: "203", verified: false, enabled: false }),
    ]);
  });

  it("merges a re-discovery over the existing mapping, keeping enabled verified ones", () => {
    const existing = [
      { id: "201", account: "100", title: "N", verified: true, enabled: true },
      { id: "202", account: "100", title: "S", verified: true, enabled: false },
      {
        id: "209",
        account: "100",
        title: "Closed",
        verified: true,
        enabled: true,
      },
      { id: "203", account: "100", title: "L", verified: false, enabled: true },
    ];
    const discovered = [
      {
        id: "201",
        account: "100",
        title: "North",
        verified: true,
        enabled: false,
      },
      {
        id: "202",
        account: "100",
        title: "South",
        verified: true,
        enabled: false,
      },
      {
        id: "203",
        account: "100",
        title: "Lake",
        verified: false,
        enabled: false,
      },
      {
        id: "204",
        account: "100",
        title: "New",
        verified: true,
        enabled: false,
      },
    ];
    expect(
      mergeLocationMapping(existing, discovered).map((l) => [l.id, l.enabled]),
    ).toEqual([
      ["201", true],
      ["202", false],
      ["203", false],
      ["204", false],
    ]);
  });

  it("applies a selection without ever enabling an unverified location", () => {
    const metadata = {
      locations: [
        {
          id: "201",
          account: "100",
          title: "N",
          verified: true,
          enabled: false,
        },
        {
          id: "202",
          account: "100",
          title: "S",
          verified: true,
          enabled: true,
        },
        {
          id: "203",
          account: "100",
          title: "L",
          verified: false,
          enabled: false,
        },
      ],
    };
    expect(
      applyLocationSelection(metadata, ["201", "203", "999"]).map(
        (l) => l.enabled,
      ),
    ).toEqual([true, false, false]);
  });

  it("formats addresses from the parts Google sends", () => {
    expect(formatAddress(undefined)).toBe("");
    expect(
      formatAddress({
        addressLines: ["1 Main St", "Suite 2"],
        locality: "Boulder",
        administrativeArea: "CO",
        postalCode: "80301",
      }),
    ).toBe("1 Main St, Suite 2, Boulder, CO 80301");
    expect(formatAddress({ locality: "Boulder" })).toBe("Boulder");
  });
});
