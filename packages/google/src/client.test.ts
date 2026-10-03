import { describe, expect, it } from "vitest";

import { createGoogleClient } from "./client.js";
import { resolveGoogleEndpoints } from "./endpoints.js";
import {
  GoogleApiError,
  GoogleRateLimited,
  GoogleUnauthorized,
  GoogleUnavailable,
  parseRetryAfterMs,
} from "./errors.js";
import { createFakeGoogle } from "./fake/app.js";

function setup() {
  const fake = createFakeGoogle();
  const { accessToken } = fake.store.issueTokens();
  // The real hosts, answered by the fake: endpoints are what production
  // uses, only `fetch` is swapped.
  const client = createGoogleClient({
    endpoints: resolveGoogleEndpoints(),
    fetch: fake.fetch,
  });
  return { fake, client, accessToken };
}

describe("createGoogleClient", () => {
  it("lists accounts and locations (readMask sent, verified flag read)", async () => {
    const { client, accessToken, fake } = setup();
    const accounts = await client.listAccounts(accessToken);
    expect(accounts.map((a) => a.name)).toEqual(["accounts/100"]);
    const locations = await client.listLocations(accessToken, "accounts/100");
    expect(
      locations.map((l) => [l.name, l.metadata?.hasVoiceOfMerchant]),
    ).toEqual([
      ["locations/201", true],
      ["locations/202", true],
      ["locations/203", false],
    ]);
    expect(locations[0]?.title).toBe("Cedar Ridge Dental — North");
    expect(locations[0]?.metadata?.placeId).toBe("ChIJnorth0000000000000001");
    const paths = fake.store.requests.map((r) => r.path);
    expect(paths).toEqual(["/v1/accounts", "/v1/accounts/100/locations"]);
    expect(client.requests).toBe(2);
  });

  it("walks review pages of 50 newest-first until nextPageToken runs out", async () => {
    const { client, accessToken } = setup();
    const first = await client.listReviewsPage(
      accessToken,
      "accounts/100/locations/201",
    );
    expect(first.reviews).toHaveLength(50);
    expect(first.totalReviewCount).toBe(70);
    expect(first.nextPageToken).toBeDefined();
    const second = await client.listReviewsPage(
      accessToken,
      "accounts/100/locations/201",
      first.nextPageToken,
    );
    expect(second.reviews).toHaveLength(20);
    expect(second.nextPageToken).toBeUndefined();
    const times = [...(first.reviews ?? []), ...(second.reviews ?? [])].map(
      (r) => Date.parse((r as { updateTime: string }).updateTime),
    );
    for (let i = 1; i < times.length; i++) {
      expect(times[i] as number).toBeLessThanOrEqual(times[i - 1] as number);
    }
  });

  it("types 429 as GoogleRateLimited with Retry-After", async () => {
    const { client, accessToken, fake } = setup();
    fake.store.failNext(429);
    const error = await client.listAccounts(accessToken).catch((e) => e);
    expect(error).toBeInstanceOf(GoogleRateLimited);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(1000);
    expect(error.googleStatus).toBe("RESOURCE_EXHAUSTED");
    // The queue drained: the next call works.
    expect(await client.listAccounts(accessToken)).toHaveLength(1);
  });

  it("types 5xx as GoogleUnavailable and 401 as GoogleUnauthorized", async () => {
    const { client, accessToken, fake } = setup();
    fake.store.failNext(503);
    await expect(client.listAccounts(accessToken)).rejects.toBeInstanceOf(
      GoogleUnavailable,
    );
    await expect(client.listAccounts("nope")).rejects.toBeInstanceOf(
      GoogleUnauthorized,
    );
    fake.store.expireAccessTokens();
    await expect(client.listAccounts(accessToken)).rejects.toMatchObject({
      name: "GoogleUnauthorized",
      googleStatus: "UNAUTHENTICATED",
    });
  });

  it("refuses to read an unverified location's reviews (403) and an unknown one (404)", async () => {
    const { client, accessToken } = setup();
    const forbidden = await client
      .listReviewsPage(accessToken, "accounts/100/locations/203")
      .catch((e) => e);
    expect(forbidden).toBeInstanceOf(GoogleApiError);
    expect(forbidden.status).toBe(403);
    expect(forbidden.googleStatus).toBe("PERMISSION_DENIED");
    await expect(
      client.listReviewsPage(accessToken, "accounts/100/locations/999"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("treats a body that fails the loose schema as MALFORMED_RESPONSE", async () => {
    const client = createGoogleClient({
      endpoints: resolveGoogleEndpoints(),
      fetch: async () => Response.json({ accounts: "not-an-array" }),
    });
    await expect(client.listAccounts("t")).rejects.toMatchObject({
      googleStatus: "MALFORMED_RESPONSE",
    });
  });

  it("parses Retry-After as seconds or an HTTP-date", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("7")).toBe(7000);
    const now = Date.parse("2026-10-01T00:00:00Z");
    expect(parseRetryAfterMs("Thu, 01 Oct 2026 00:00:30 GMT", now)).toBe(
      30_000,
    );
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});
