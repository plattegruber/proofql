/**
 * The KV auth cache's own contract (#108): key format, round trip, TTL, and
 * that nothing which does not parse as a current entry is ever served.
 * Whether `requireApiKey` consults it correctly is the integration test.
 */

import { describe, expect, it } from "vitest";

import { fakeKv } from "../test/helpers.js";
import {
  AUTH_CACHE_TTL_SECONDS,
  type AuthCacheEntry,
  authCacheKey,
  getCachedAuth,
  isAuthCacheEntry,
  putCachedAuth,
} from "./auth-cache.js";
import type { AuthContext } from "./bindings.js";

const HASH = "a".repeat(64);

const auth: AuthContext = {
  apiKeyId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  environment: "live",
  kind: "publishable",
  plan: "paid",
  project: {
    allowedOrigins: ["https://shop.example"],
    minRating: 4,
    similarityFloor: 0.55,
  },
};

describe("authCacheKey", () => {
  it("is the key hash under the `auth:` prefix, never the plaintext", () => {
    expect(authCacheKey(HASH)).toBe(`auth:${HASH}`);
  });
});

describe("put / get", () => {
  it("round-trips the context, last_used_at and generation", async () => {
    const kv = fakeKv();
    const now = new Date("2026-10-04T12:00:00Z");
    await putCachedAuth(
      kv,
      HASH,
      { auth, lastUsedAt: "2026-10-04T11:59:00.000Z", generation: 7 },
      { now },
    );

    const entry = await getCachedAuth(kv, HASH);
    expect(entry).toEqual<AuthCacheEntry>({
      v: 1,
      auth,
      lastUsedAt: "2026-10-04T11:59:00.000Z",
      generation: 7,
      storedAt: now.toISOString(),
    });
  });

  it("expires after AUTH_CACHE_TTL_SECONDS (KV's minimum TTL)", async () => {
    let clock = Date.parse("2026-10-04T12:00:00Z");
    const kv = fakeKv({ now: () => clock });
    await putCachedAuth(kv, HASH, { auth, lastUsedAt: null, generation: 0 });

    clock += (AUTH_CACHE_TTL_SECONDS - 1) * 1000;
    expect(await getCachedAuth(kv, HASH)).not.toBeNull();
    clock += 1000;
    expect(await getCachedAuth(kv, HASH)).toBeNull();
    expect(AUTH_CACHE_TTL_SECONDS).toBe(60);
  });

  it("is a miss for an absent key", async () => {
    expect(await getCachedAuth(fakeKv(), HASH)).toBeNull();
  });

  it("is a miss for an entry that is not JSON or not the current shape", async () => {
    const kv = fakeKv();
    await kv.put(authCacheKey(HASH), "not json");
    expect(await getCachedAuth(kv, HASH)).toBeNull();

    await kv.put(authCacheKey(HASH), JSON.stringify({ v: 0, auth }));
    expect(await getCachedAuth(kv, HASH)).toBeNull();

    await kv.put(
      authCacheKey(HASH),
      JSON.stringify({
        v: 1,
        auth: { ...auth, plan: "enterprise" },
        lastUsedAt: null,
        generation: 1,
        storedAt: "x",
      }),
    );
    expect(await getCachedAuth(kv, HASH)).toBeNull();
  });
});

describe("isAuthCacheEntry", () => {
  const good: AuthCacheEntry = {
    v: 1,
    auth,
    lastUsedAt: null,
    generation: 3,
    storedAt: "2026-10-04T12:00:00.000Z",
  };

  it("accepts a complete entry", () => {
    expect(isAuthCacheEntry(good)).toBe(true);
  });

  it.each([
    ["kind", { ...good, auth: { ...auth, kind: "admin" } }],
    ["environment", { ...good, auth: { ...auth, environment: "staging" } }],
    ["plan", { ...good, auth: { ...auth, plan: 1 } }],
    ["generation", { ...good, generation: "3" }],
    ["lastUsedAt", { ...good, lastUsedAt: 5 }],
    [
      "allowedOrigins",
      {
        ...good,
        auth: { ...auth, project: { ...auth.project, allowedOrigins: "x" } },
      },
    ],
    [
      "minRating",
      {
        ...good,
        auth: { ...auth, project: { ...auth.project, minRating: "4" } },
      },
    ],
    ["project", { ...good, auth: { ...auth, project: null } }],
    ["null", null],
    ["array", []],
  ])("rejects a bad %s", (_name, value) => {
    expect(isAuthCacheEntry(value)).toBe(false);
  });
});
