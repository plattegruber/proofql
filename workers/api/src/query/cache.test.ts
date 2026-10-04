/**
 * The query cache's pure parts (#28): what is and is not part of a key's
 * identity, canonical JSON, the stored shape and its TTL against the
 * Map-backed fake KV, and the `Cache-Control` parse. No database.
 */

import { generationKey } from "@proofql/core";
import { describe, expect, it } from "vitest";
import { fakeKv } from "../../test/helpers.js";
import {
  CACHE_TTL_SECONDS,
  cacheIdentity,
  cacheKey,
  canonicalJson,
  getCached,
  normalizeQ,
  onProjectPolicyChanged,
  putCached,
  wantsFresh,
} from "./cache.js";
import { parseQueryRequest } from "./request.js";
import type { QueryResponseResult } from "./route.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";

function keyFor(
  body: unknown,
  overrides: Partial<Parameters<typeof cacheKey>[0]> = {},
): Promise<string> {
  return cacheKey({
    projectId: PROJECT,
    environment: "live",
    generation: 3,
    request: parseQueryRequest(body),
    policy: { minRating: 4, similarityFloor: 0.55 },
    ...overrides,
  });
}

describe("normalizeQ", () => {
  it("trims, collapses whitespace, and lower-cases", () => {
    expect(normalizeQ("  Dental \n\t IMPLANTS  ")).toBe("dental implants");
    expect(normalizeQ("x")).toBe("x");
  });
});

describe("cacheKey", () => {
  it("has the documented shape: q:<project>:<env>:<generation>:<sha256 hex>", async () => {
    const key = await keyFor({ q: "implants" });
    expect(key).toMatch(new RegExp(`^q:${PROJECT}:live:3:[0-9a-f]{64}$`));
  });

  it("is insensitive to q whitespace and case", async () => {
    const base = await keyFor({ q: "dental implants" });
    expect(await keyFor({ q: "  Dental   IMPLANTS " })).toBe(base);
    expect(await keyFor({ q: "dental\timplants" })).toBe(base);
    expect(await keyFor({ q: "dental implant" })).not.toBe(base);
  });

  it("is insensitive to filter key order, metadata key order, and source order or duplicates", async () => {
    const a = await keyFor({
      q: "implants",
      filters: {
        min_rating: 5,
        source: ["google", "yelp"],
        since: "2025-01-01",
        metadata: { location: "north", floor: "2" },
      },
    });
    const b = await keyFor({
      q: "implants",
      filters: {
        metadata: { floor: "2", location: "north" },
        since: "2025-01-01T00:00:00Z",
        source: ["yelp", "google", "google"],
        min_rating: 5,
      },
    });
    expect(b).toBe(a);

    // The flat GET spelling folds into the same identity.
    const flat = await keyFor({
      q: "implants",
      filters: {
        min_rating: 5,
        source: "google,yelp".split(","),
        since: "2025-01-01",
        "metadata.floor": "2",
        "metadata.location": "north",
      },
    });
    expect(flat).toBe(a);
  });

  it("treats defaults and explicit defaults alike", async () => {
    const implicit = await keyFor({ q: "implants" });
    const explicit = await keyFor({
      q: "implants",
      limit: 5,
      mode: "excerpts",
      include: [],
      filters: {},
    });
    expect(explicit).toBe(implicit);
    // `include` is a set: order and repeats are not identity.
    expect(await keyFor({ q: "implants", include: ["text", "text"] })).toBe(
      await keyFor({ q: "implants", include: "text" }),
    );
  });

  it("changes with anything the search depends on", async () => {
    const base = await keyFor({ q: "implants" });
    const variants = await Promise.all([
      keyFor({ q: "implants", limit: 6 }),
      keyFor({ q: "implants", mode: "reviews" }),
      keyFor({ q: "implants", include: ["text"] }),
      keyFor({ q: "implants", filters: { min_rating: 5 } }),
      keyFor({ q: "implants", filters: { source: ["google"] } }),
      keyFor({ q: "implants", filters: { since: "2025-01-01" } }),
      keyFor({ q: "implants", filters: { metadata: { location: "n" } } }),
      keyFor({}), // no q at all
      keyFor({ q: "implants" }, { environment: "test" }),
      keyFor({ q: "implants" }, { generation: 4 }),
      keyFor(
        { q: "implants" },
        { projectId: "22222222-2222-4222-8222-222222222222" },
      ),
      keyFor(
        { q: "implants" },
        { policy: { minRating: 3, similarityFloor: 0.55 } },
      ),
      keyFor(
        { q: "implants" },
        { policy: { minRating: 4, similarityFloor: 0.5 } },
      ),
    ]);
    for (const variant of variants) expect(variant).not.toBe(base);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("exposes the identity it hashes", () => {
    expect(
      cacheIdentity({
        projectId: PROJECT,
        environment: "live",
        generation: 1,
        request: parseQueryRequest({
          q: " Implants ",
          filters: { source: ["yelp", "google"], since: "2025-01-01" },
        }),
        policy: { minRating: 4, similarityFloor: 0.55 },
      }),
    ).toEqual({
      q: "implants",
      limit: 5,
      mode: "excerpts",
      include: [],
      filters: {
        min_rating: null,
        source: ["google", "yelp"],
        since: "2025-01-01T00:00:00.000Z",
        metadata: null,
      },
      policy: { min_rating: 4, similarity_floor: 0.55 },
    });
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level, serializes dates, and drops undefined", () => {
    expect(
      canonicalJson({
        b: { z: 1, y: [{ d: 2, c: new Date("2025-01-01T00:00:00Z") }] },
        a: undefined,
        c: null,
      }),
    ).toBe(
      '{"b":{"y":[{"c":"2025-01-01T00:00:00.000Z","d":2}],"z":1},"c":null}',
    );
  });
});

describe("putCached / getCached", () => {
  const results: QueryResponseResult[] = [
    {
      score: 0.8,
      excerpt: "My implant feels like my own tooth.",
      excerpt_id: "33333333-3333-4333-8333-333333333333",
      highlight: null,
      review: {
        id: "44444444-4444-4444-8444-444444444444",
        rating: 5,
        author_name: "Marcus T.",
        author_avatar_url: null,
        source: "google",
        occurred_at: "2026-03-01T00:00:00.000Z",
        url: null,
        metadata: { location: "north" },
      },
    },
  ];

  it("round-trips results and metadata with the default TTL", async () => {
    let clock = Date.UTC(2026, 9, 1);
    const kv = fakeKv({ now: () => clock });
    const storedAt = new Date(clock);

    await putCached(kv, "q:k", results, { generation: 7, now: storedAt });

    expect(kv.store.get("q:k")).toEqual({
      value: JSON.stringify(results),
      metadata: { generation: 7, storedAt: storedAt.toISOString() },
      expiresAt: clock + CACHE_TTL_SECONDS * 1000,
    });
    expect(await getCached(kv, "q:k")).toEqual({
      results,
      metadata: { generation: 7, storedAt: storedAt.toISOString() },
    });
    // Deep-equal and byte-equal: the stored JSON is the results verbatim.
    expect(JSON.stringify((await getCached(kv, "q:k"))?.results)).toBe(
      JSON.stringify(results),
    );

    clock += CACHE_TTL_SECONDS * 1000 - 1;
    expect(await getCached(kv, "q:k")).not.toBeNull();
    clock += 1;
    expect(await getCached(kv, "q:k")).toBeNull();
  });

  it("honours an explicit TTL", async () => {
    let clock = 1_000_000;
    const kv = fakeKv({ now: () => clock });
    await putCached(kv, "q:k", [], { generation: 1, ttlSeconds: 60 });
    clock += 59_000;
    expect(await getCached(kv, "q:k")).toEqual({
      results: [],
      metadata: { generation: 1, storedAt: expect.any(String) },
    });
    clock += 1_000;
    expect(await getCached(kv, "q:k")).toBeNull();
  });

  it("misses on an absent key and on anything that is not a results array", async () => {
    const kv = fakeKv();
    expect(await getCached(kv, "q:absent")).toBeNull();
    await kv.put("q:garbage", "{not json");
    expect(await getCached(kv, "q:garbage")).toBeNull();
    await kv.put("q:object", JSON.stringify({ results: [] }));
    expect(await getCached(kv, "q:object")).toBeNull();
    await kv.put("q:nometa", JSON.stringify([]));
    expect(await getCached(kv, "q:nometa")).toEqual({
      results: [],
      metadata: null,
    });
  });
});

describe("wantsFresh", () => {
  it("is true only for a no-cache directive", () => {
    expect(wantsFresh(undefined)).toBe(false);
    expect(wantsFresh("")).toBe(false);
    expect(wantsFresh("no-cache")).toBe(true);
    expect(wantsFresh("max-age=0, No-Cache")).toBe(true);
    expect(wantsFresh("no-store")).toBe(false);
    expect(wantsFresh("max-age=0")).toBe(false);
  });
});

describe("onProjectPolicyChanged", () => {
  it("bumps the project's generation, orphaning every key built on the old one", async () => {
    const kv = fakeKv();
    const before = await keyFor({ q: "implants" }, { generation: 0 });

    await expect(onProjectPolicyChanged(kv, PROJECT)).resolves.toBe(1);
    expect(kv.peek(generationKey(PROJECT))).toBe("1");

    const after = await keyFor({ q: "implants" }, { generation: 1 });
    expect(after).not.toBe(before);
  });
});
