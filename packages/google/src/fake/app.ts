/**
 * The fake Google Business Profile server: one Hono app standing in for
 * every Google host the connector talks to (docs/google.md).
 *
 *   GET  /o/oauth2/v2/auth                              accounts.google.com — auto-approving consent
 *   POST /token                                         oauth2.googleapis.com — code exchange (PKCE S256) and refresh
 *   GET  /v1/accounts                                   Account Management v1 — pages of 20
 *   GET  /v1/accounts/{a}/locations?readMask=…          Business Information v1 — readMask required, pages of 100
 *   GET  /v4/accounts/{a}/locations/{l}/reviews         My Business v4 — pageSize ≤ 50, orderBy=updateTime desc
 *
 * Fidelity choices that matter to the connector:
 * - a refresh token is granted only with `access_type=offline` AND
 *   `prompt=consent`, as Google does on repeat consents — so a client
 *   missing the recipe hits the "no refresh token" path;
 * - data endpoints need a live Bearer token (401 `UNAUTHENTICATED`);
 * - an unverified location has no reviews to serve (403 `PERMISSION_DENIED`);
 * - `?scenario=429|500|503` on any data request, or `store.failNext(...)`,
 *   returns that status (429 with `Retry-After: 1`) before anything else.
 *
 * In-process use needs no port: inject `app.fetch` as the connector's
 * `fetch` and point every endpoint at any origin —
 * `createFakeGoogle().fetch` is exactly that adapter.
 */

import { Hono } from "hono";

import { FakeGoogleStore, type FakeGoogleStoreOptions } from "./store.js";
import type { FakeLocation, FakeReview } from "./types.js";

export const FAKE_SCOPE = "https://www.googleapis.com/auth/business.manage";
export const FAKE_GBP_PORT = 8802;

export interface FakeGoogle {
  app: Hono;
  store: FakeGoogleStore;
  /** `fetch` that routes into the app, whatever host the URL names. */
  fetch: typeof fetch;
}

function googleError(status: number, googleStatus: string, message: string) {
  return Response.json(
    { error: { code: status, message, status: googleStatus } },
    { status },
  );
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodePageToken(offset: number): string {
  return btoa(`o:${offset}`);
}

function decodePageToken(token: string | undefined): number | null {
  if (token === undefined) return 0;
  try {
    const decoded = atob(token);
    if (!decoded.startsWith("o:")) return null;
    const n = Number(decoded.slice(2));
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function paginate<T>(
  items: readonly T[],
  pageSize: number,
  token: string | undefined,
): { items: T[]; nextPageToken?: string } | null {
  const offset = decodePageToken(token);
  if (offset === null) return null;
  const page = items.slice(offset, offset + pageSize);
  const next = offset + pageSize;
  return next < items.length
    ? { items: page, nextPageToken: encodePageToken(next) }
    : { items: page };
}

function clampPageSize(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function locationWire(location: FakeLocation, readMask: Set<string>) {
  const wire: Record<string, unknown> = {};
  if (readMask.has("name")) wire.name = `locations/${location.id}`;
  if (readMask.has("title")) wire.title = location.title;
  if (readMask.has("storefrontAddress")) {
    wire.storefrontAddress = {
      regionCode: "US",
      addressLines: location.addressLines,
      locality: location.locality,
      administrativeArea: location.administrativeArea,
      postalCode: location.postalCode,
    };
  }
  if (readMask.has("categories") && location.primaryCategory) {
    wire.categories = {
      primaryCategory: {
        name: `categories/${location.primaryCategory}`,
        displayName: location.primaryCategory.replace(/^gcid:/, ""),
      },
    };
  }
  if (readMask.has("metadata")) {
    wire.metadata = {
      hasVoiceOfMerchant: location.verified,
      placeId: location.placeId,
      mapsUri: `https://maps.google.com/?cid=${location.id}`,
    };
  }
  return wire;
}

const STAR_VALUE: Record<FakeReview["starRating"], number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

export function createFakeGoogle(
  options: FakeGoogleStoreOptions = {},
): FakeGoogle {
  const store = new FakeGoogleStore(options);
  const app = new Hono();

  // --- failure injection: scenario query or queued failure, before auth ---
  app.use("/v1/*", failureInjection(store));
  app.use("/v4/*", failureInjection(store));

  // --- consent screen (auto-approve) --------------------------------------
  app.get("/o/oauth2/v2/auth", (c) => {
    const q = (name: string) => c.req.query(name);
    const redirectUri = q("redirect_uri");
    if (!q("client_id") || !redirectUri) {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (q("response_type") !== "code") {
      return c.json({ error: "unsupported_response_type" }, 400);
    }
    if (!(q("scope") ?? "").split(/\s+/).includes(FAKE_SCOPE)) {
      return c.json({ error: "invalid_scope" }, 400);
    }
    const codeChallenge = q("code_challenge");
    if (codeChallenge && q("code_challenge_method") !== "S256") {
      return c.json(
        { error: "invalid_request", error_description: "S256 only" },
        400,
      );
    }
    const withRefreshToken =
      q("access_type") === "offline" &&
      (q("prompt") ?? "").split(/\s+/).includes("consent");
    const code = store.issueAuthCode({ codeChallenge, withRefreshToken });
    const location = new URL(redirectUri);
    location.searchParams.set("code", code);
    const state = q("state");
    if (state !== undefined) location.searchParams.set("state", state);
    return c.redirect(location.toString(), 302);
  });

  // --- token endpoint -----------------------------------------------------
  app.post("/token", async (c) => {
    const params = new URLSearchParams(await c.req.text());
    const grantType = params.get("grant_type");
    if (grantType === "authorization_code") {
      const code = params.get("code");
      const verifier = params.get("code_verifier");
      const challenge = verifier ? await s256(verifier) : undefined;
      const grant = code ? store.exchangeAuthCode(code, challenge) : undefined;
      if (!grant) {
        return c.json(
          { error: "invalid_grant", error_description: "Malformed auth code." },
          400,
        );
      }
      return c.json({
        access_token: grant.accessToken,
        expires_in: grant.expiresIn,
        ...(grant.refreshToken ? { refresh_token: grant.refreshToken } : {}),
        scope: FAKE_SCOPE,
        token_type: "Bearer",
      });
    }
    if (grantType === "refresh_token") {
      const refreshToken = params.get("refresh_token");
      const grant = refreshToken
        ? store.refreshAccessToken(refreshToken)
        : undefined;
      if (!grant) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          },
          400,
        );
      }
      return c.json({
        access_token: grant.accessToken,
        expires_in: grant.expiresIn,
        scope: FAKE_SCOPE,
        token_type: "Bearer",
      });
    }
    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  // --- bearer auth for the data APIs --------------------------------------
  const requireBearer = async (
    c: { req: { header(name: string): string | undefined } },
    next: () => Promise<void>,
  ) => {
    const header = c.req.header("Authorization") ?? "";
    const tokenValue = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!store.isAccessTokenValid(tokenValue)) {
      return googleError(
        401,
        "UNAUTHENTICATED",
        "Request had invalid authentication credentials.",
      );
    }
    await next();
  };
  app.use("/v1/*", requireBearer);
  app.use("/v4/*", requireBearer);

  // --- accounts.list ------------------------------------------------------
  app.get("/v1/accounts", (c) => {
    const pageSize = clampPageSize(c.req.query("pageSize"), 20, 20);
    const paged = paginate(store.accounts, pageSize, c.req.query("pageToken"));
    if (!paged)
      return googleError(400, "INVALID_ARGUMENT", "Invalid pageToken.");
    return c.json({
      ...(paged.items.length > 0
        ? {
            accounts: paged.items.map((a) => ({
              name: `accounts/${a.id}`,
              accountName: a.accountName,
              type: "LOCATION_GROUP",
            })),
          }
        : {}),
      ...(paged.nextPageToken ? { nextPageToken: paged.nextPageToken } : {}),
    });
  });

  // --- locations.list -----------------------------------------------------
  app.get("/v1/accounts/:accountId/locations", (c) => {
    const accountId = c.req.param("accountId");
    if (!store.account(accountId)) {
      return googleError(404, "NOT_FOUND", "Requested entity was not found.");
    }
    const readMaskRaw = c.req.query("readMask");
    if (!readMaskRaw) {
      return googleError(400, "INVALID_ARGUMENT", "readMask is required.");
    }
    const readMask = new Set(readMaskRaw.split(",").map((s) => s.trim()));
    const pageSize = clampPageSize(c.req.query("pageSize"), 10, 100);
    const paged = paginate(
      store.locationsFor(accountId),
      pageSize,
      c.req.query("pageToken"),
    );
    if (!paged)
      return googleError(400, "INVALID_ARGUMENT", "Invalid pageToken.");
    return c.json({
      ...(paged.items.length > 0
        ? { locations: paged.items.map((l) => locationWire(l, readMask)) }
        : {}),
      ...(paged.nextPageToken ? { nextPageToken: paged.nextPageToken } : {}),
    });
  });

  // --- reviews.list (v4) ---------------------------------------------------
  app.get("/v4/accounts/:accountId/locations/:locationId/reviews", (c) => {
    const accountId = c.req.param("accountId");
    const locationId = c.req.param("locationId");
    const location = store.location(accountId, locationId);
    if (!location) {
      return googleError(404, "NOT_FOUND", "Requested entity was not found.");
    }
    if (!location.verified) {
      return googleError(
        403,
        "PERMISSION_DENIED",
        "Reviews are only available for verified locations.",
      );
    }
    const orderBy = c.req.query("orderBy") ?? "updateTime desc";
    if (!["updateTime desc", "rating", "rating desc"].includes(orderBy)) {
      return googleError(
        400,
        "INVALID_ARGUMENT",
        `Invalid orderBy: ${orderBy}.`,
      );
    }
    const pageSize = clampPageSize(c.req.query("pageSize"), 50, 50);
    let all = store.reviewsFor(locationId);
    if (orderBy === "rating") {
      all = [...all].sort(
        (a, b) => STAR_VALUE[a.starRating] - STAR_VALUE[b.starRating],
      );
    } else if (orderBy === "rating desc") {
      all = [...all].sort(
        (a, b) => STAR_VALUE[b.starRating] - STAR_VALUE[a.starRating],
      );
    }
    const paged = paginate(all, pageSize, c.req.query("pageToken"));
    if (!paged)
      return googleError(400, "INVALID_ARGUMENT", "Invalid pageToken.");
    const body: Record<string, unknown> = {};
    if (paged.items.length > 0) body.reviews = paged.items;
    if (paged.nextPageToken) body.nextPageToken = paged.nextPageToken;
    if (all.length > 0) {
      body.totalReviewCount = all.length;
      const mean =
        all.reduce((s, r) => s + STAR_VALUE[r.starRating], 0) / all.length;
      body.averageRating = Math.round(mean * 10) / 10;
    }
    return c.json(body);
  });

  app.get("/", (c) =>
    c.json({
      ok: true,
      what: "ProofQL fake Google Business Profile server",
      endpoints: [
        "GET /o/oauth2/v2/auth",
        "POST /token",
        "GET /v1/accounts",
        "GET /v1/accounts/{a}/locations?readMask=name,title,storefrontAddress,metadata,categories",
        "GET /v4/accounts/{a}/locations/{l}/reviews?pageSize=50&orderBy=updateTime desc",
      ],
      scenarios: "append ?scenario=429|500|503 to any /v1 or /v4 request",
      docs: "docs/google.md",
    }),
  );

  app.notFound(() => googleError(404, "NOT_FOUND", "Unknown endpoint."));

  const fakeFetch: typeof fetch = async (input, init) =>
    app.fetch(new Request(input, init));

  return { app, store, fetch: fakeFetch };
}

function failureInjection(store: FakeGoogleStore) {
  return async (
    c: {
      req: {
        method: string;
        url: string;
        query(name: string): string | undefined;
      };
    },
    next: () => Promise<void>,
  ) => {
    const url = new URL(c.req.url);
    store.requests.push({ method: c.req.method, path: url.pathname });
    const forced = store.consumeForcedFailure();
    const scenario = c.req.query("scenario");
    const status = forced ?? (scenario ? Number(scenario) : undefined);
    if (status === undefined || !Number.isInteger(status) || status < 400) {
      await next();
      return;
    }
    const headers = new Headers({ "Content-Type": "application/json" });
    if (status === 429) headers.set("Retry-After", "1");
    const googleStatus =
      status === 429
        ? "RESOURCE_EXHAUSTED"
        : status >= 500
          ? "UNAVAILABLE"
          : "FAILED_PRECONDITION";
    return new Response(
      JSON.stringify({
        error: {
          code: status,
          message: `Scenario ${status}`,
          status: googleStatus,
        },
      }),
      { status, headers },
    );
  };
}
