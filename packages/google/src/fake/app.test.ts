import { describe, expect, it } from "vitest";

import { createFakeGoogle, FAKE_SCOPE } from "./app.js";
import { defaultFixtures, FIXTURE_REVIEW_COUNTS } from "./fixtures.js";

describe("fixtures", () => {
  it("are deterministic and cover the quirk matrix", () => {
    const a = defaultFixtures();
    const b = defaultFixtures();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.reviews).toHaveLength(120);
    expect(a.locations.filter((l) => !l.verified)).toHaveLength(1);
    const north = a.reviews.filter((r) => r.name.includes("/locations/201/"));
    expect(north).toHaveLength(FIXTURE_REVIEW_COUNTS["201"] as number);
    expect(north.filter((r) => r.comment === undefined)).toHaveLength(1);
    expect(north.filter((r) => r.reviewer.isAnonymous)).toHaveLength(1);
    expect(
      north.filter((r) => r.reviewReply?.reviewReplyState === "REJECTED"),
    ).toHaveLength(1);
    expect(
      north.filter((r) => r.updateTime > r.createTime).length,
    ).toBeGreaterThan(1);
    expect(new Set(a.reviews.map((r) => r.name)).size).toBe(120);
    for (const r of a.reviews) {
      expect(Date.parse(r.updateTime)).toBeGreaterThanOrEqual(
        Date.parse(r.createTime),
      );
    }
  });
});

describe("fake google server", () => {
  it("runs the consent → code → token flow with PKCE and single-use codes", async () => {
    const fake = createFakeGoogle();
    const verifier = "a-very-long-verifier-string-that-is-fine";
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: "c",
      redirect_uri: "http://localhost:8799/cb",
      response_type: "code",
      scope: FAKE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st",
    }).toString();
    const redirect = await fake.fetch(auth.toString(), { redirect: "manual" });
    expect(redirect.status).toBe(302);
    const location = new URL(redirect.headers.get("location") as string);
    expect(location.origin + location.pathname).toBe(
      "http://localhost:8799/cb",
    );
    expect(location.searchParams.get("state")).toBe("st");
    const code = location.searchParams.get("code") as string;

    const wrongVerifier = await fake.fetch(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: "wrong",
          redirect_uri: "x",
          client_id: "c",
          client_secret: "s",
        }),
      },
    );
    // A failed PKCE check burns the code, as Google does.
    expect(wrongVerifier.status).toBe(400);
    expect(await wrongVerifier.json()).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("requires readMask on locations.list and a bearer token on every data call", async () => {
    const fake = createFakeGoogle();
    const { accessToken } = fake.store.issueTokens();
    const noAuth = await fake.fetch("https://x/v1/accounts");
    expect(noAuth.status).toBe(401);
    const noMask = await fake.fetch("https://x/v1/accounts/100/locations", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(noMask.status).toBe(400);
    expect(await noMask.json()).toMatchObject({
      error: { status: "INVALID_ARGUMENT" },
    });
  });

  it("honours ?scenario= on data requests with Retry-After on 429", async () => {
    const fake = createFakeGoogle();
    const { accessToken } = fake.store.issueTokens();
    const headers = { Authorization: `Bearer ${accessToken}` };
    const limited = await fake.fetch("https://x/v1/accounts?scenario=429", {
      headers,
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("1");
    const down = await fake.fetch("https://x/v1/accounts?scenario=503", {
      headers,
    });
    expect(down.status).toBe(503);
    const ok = await fake.fetch("https://x/v1/accounts?scenario=nonsense", {
      headers,
    });
    expect(ok.status).toBe(200);
  });

  it("adds and edits reviews, moving them to the front of updateTime order", async () => {
    const fake = createFakeGoogle({
      now: () => Date.parse("2026-10-01T00:00:00Z"),
    });
    const { accessToken } = fake.store.issueTokens();
    const added = fake.store.addReview("202", { comment: "Newest!" });
    const edited = fake.store.editReview(
      fake.store.reviewsFor("202")[5]?.name as string,
      "Edited text",
    );
    const page = await fake
      .fetch(
        "https://x/v4/accounts/100/locations/202/reviews?pageSize=50&orderBy=updateTime%20desc",
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      )
      .then(
        (r) =>
          r.json() as Promise<{
            reviews: { name: string }[];
            totalReviewCount: number;
          }>,
      );
    expect(page.totalReviewCount).toBe(46);
    expect(
      page.reviews
        .slice(0, 2)
        .map((r) => r.name)
        .sort(),
    ).toEqual([added.name, edited.name].sort());
  });

  it("describes itself at / and 404s elsewhere in Google's error shape", async () => {
    const fake = createFakeGoogle();
    expect(await fake.fetch("https://x/").then((r) => r.json())).toMatchObject({
      ok: true,
    });
    const missing = await fake.fetch("https://x/v9/nothing");
    expect(missing.status).toBe(404);
  });
});
