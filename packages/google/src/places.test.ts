// The pure side of the Places bootstrap (#47): response shapes, the mapper
// onto reviewInputSchema (text fallback, missing text, missing reviews,
// attribution gaps), the key conventions, and the client over the fake
// Places API (field masks, the cache, `fresh`, Google's refusals). No
// services, no sockets.
import { describe, expect, it } from "vitest";

import {
  CEDAR_RIDGE_ID,
  FAKE_PLACES,
  fakePlacesApi,
  HARBOR_LIGHT_ID,
  QUIET_CORNER_ID,
} from "./fake/places.js";
import {
  createPlacesClient,
  describePlacesError,
  kvPlacesCache,
  mapPlaceReview,
  mapPlaceReviews,
  normalizeSearchQuery,
  PLACES_ANONYMOUS_AUTHOR,
  PLACES_PLACE_FIELD_MASK,
  PLACES_SEARCH_FIELD_MASK,
  placeCacheKey,
  placeDetailsSchema,
  placeIdFromArtifactKey,
  PLACES_SEARCH_CACHE_PREFIX,
  type PlacesCache,
  placesArtifactKey,
  PlacesError,
  placesSearchResponseSchema,
  searchCacheKey,
  toPlaceMatch,
} from "./places.js";

const place = { id: "ChIJx", name: "Cedar Ridge Dental" };

const review = {
  name: "places/ChIJx/reviews/abc",
  rating: 5,
  text: { text: "  Great implant work.  ", languageCode: "en" },
  originalText: { text: "Great implant work.", languageCode: "en" },
  authorAttribution: {
    displayName: "Marcus T.",
    uri: "https://www.google.com/maps/contrib/1/reviews",
    photoUri: "https://lh3.googleusercontent.com/a/x=s128",
  },
  publishTime: "2026-03-14T18:20:00Z",
  googleMapsUri: "https://www.google.com/maps/reviews/data=1",
};

describe("mapPlaceReview", () => {
  it("maps the documented fields onto the push-API shape, source google", () => {
    const mapped = mapPlaceReview(place, review);
    expect(mapped).toEqual({
      ok: true,
      review: {
        external_id: "places/ChIJx/reviews/abc",
        source: "google",
        rating: 5,
        text: "Great implant work.",
        author_name: "Marcus T.",
        author_avatar_url: "https://lh3.googleusercontent.com/a/x=s128",
        occurred_at: "2026-03-14T18:20:00Z",
        url: "https://www.google.com/maps/reviews/data=1",
        language: "en",
        metadata: { place_id: "ChIJx", place_name: "Cedar Ridge Dental" },
      },
    });
  });

  it("falls back to originalText and its language when there is no translated text", () => {
    const { text: _text, ...untranslated } = review;
    const mapped = mapPlaceReview(place, {
      ...untranslated,
      originalText: { text: "La limpieza fue rápida.", languageCode: "es" },
    });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.review.text).toBe("La limpieza fue rápida.");
    expect(mapped.review.language).toBe("es");
  });

  it("skips a rating-only review (no text at all) with a reason", () => {
    const { text: _t, originalText: _o, ...starsOnly } = review;
    expect(mapPlaceReview(place, starsOnly)).toEqual({
      ok: false,
      name: "places/ChIJx/reviews/abc",
      reason: "The review has a rating but no text.",
    });
    // Whitespace-only text is no text.
    expect(
      mapPlaceReview(place, { ...starsOnly, text: { text: "   " } }).ok,
    ).toBe(false);
  });

  it("links the attribution when there is no Maps link, and names anonymous authors", () => {
    const { googleMapsUri: _g, ...noMapsLink } = review;
    const mapped = mapPlaceReview(place, {
      ...noMapsLink,
      authorAttribution: { uri: "https://www.google.com/maps/contrib/1" },
    });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.review.url).toBe("https://www.google.com/maps/contrib/1");
    expect(mapped.review.author_name).toBe(PLACES_ANONYMOUS_AUTHOR);
    expect(mapped.review.author_avatar_url).toBeNull();

    const bare = mapPlaceReview(place, {
      ...noMapsLink,
      rating: undefined,
      authorAttribution: undefined,
    });
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.review.url).toBeNull();
    expect(bare.review.rating).toBeNull();
  });

  it("refuses what reviewInputSchema refuses (a bad publish time, a bad avatar url)", () => {
    const noDate = mapPlaceReview(place, {
      ...review,
      publishTime: "yesterday",
    });
    expect(noDate.ok).toBe(false);
    if (noDate.ok) return;
    expect(noDate.reason).toContain("occurred_at");

    const badAvatar = mapPlaceReview(place, {
      ...review,
      authorAttribution: { displayName: "X", photoUri: "not a url" },
    });
    expect(badAvatar.ok).toBe(true);
    if (!badAvatar.ok) return;
    expect(badAvatar.review.author_avatar_url).toBeNull();
  });
});

describe("mapPlaceReviews over the fixtures", () => {
  const byId = new Map(FAKE_PLACES.map((p) => [p.id, p]));

  it("maps all five Cedar Ridge reviews, including the originalText-only one", () => {
    const details = placeDetailsSchema.parse(byId.get(CEDAR_RIDGE_ID));
    const { place, reviews, skipped } = mapPlaceReviews(details);
    expect(place).toEqual({
      id: CEDAR_RIDGE_ID,
      name: "Cedar Ridge Dental",
      address: "1200 Cedar Ridge Rd, Boulder, CO 80302, USA",
      rating: 4.8,
      ratingCount: 212,
    });
    expect(reviews).toHaveLength(5);
    expect(skipped).toEqual([]);
    expect(new Set(reviews.map((r) => r.source))).toEqual(new Set(["google"]));
    expect(reviews.map((r) => r.language)).toEqual([
      "en",
      "en",
      "es",
      "en",
      "en",
    ]);
    expect(reviews[4]?.author_name).toBe(PLACES_ANONYMOUS_AUTHOR);
    for (const r of reviews) {
      expect(r.metadata).toEqual({
        place_id: CEDAR_RIDGE_ID,
        place_name: "Cedar Ridge Dental",
      });
    }
  });

  it("skips Harbor Light's rating-only review and names it", () => {
    const details = placeDetailsSchema.parse(byId.get(HARBOR_LIGHT_ID));
    const { reviews, skipped } = mapPlaceReviews(details);
    expect(reviews).toHaveLength(1);
    expect(skipped).toEqual([
      {
        name: `places/${HARBOR_LIGHT_ID}/reviews/r-stars-only-2`,
        reason: "The review has a rating but no text.",
      },
    ]);
  });

  it("handles a place with no reviews field", () => {
    const details = placeDetailsSchema.parse(byId.get(QUIET_CORNER_ID));
    expect(details.reviews).toBeUndefined();
    const mapped = mapPlaceReviews(details);
    expect(mapped.reviews).toEqual([]);
    expect(mapped.skipped).toEqual([]);
    expect(mapped.place.rating).toBeNull();
    expect(mapped.place.ratingCount).toBe(0);
  });
});

describe("response shapes and field masks", () => {
  it("accepts the empty search response and unknown extra fields", () => {
    expect(placesSearchResponseSchema.parse({}).places).toBeUndefined();
    const parsed = placesSearchResponseSchema.parse({
      places: [{ id: "a", displayName: { text: "A" }, somethingNew: 1 }],
      nextPageToken: "x",
    });
    expect(parsed.places?.[0]?.id).toBe("a");
    expect(toPlaceMatch({ id: "a" })).toEqual({
      id: "a",
      name: "Unnamed place",
      address: null,
      rating: null,
      ratingCount: null,
    });
  });

  it("asks only for the fields it reads; search fields nest under places.", () => {
    expect(PLACES_SEARCH_FIELD_MASK.split(",")).toEqual([
      "places.id",
      "places.displayName",
      "places.formattedAddress",
      "places.rating",
      "places.userRatingCount",
    ]);
    expect(PLACES_PLACE_FIELD_MASK.split(",")).toContain("reviews");
    expect(PLACES_PLACE_FIELD_MASK).not.toContain("places.");
  });
});

describe("keys", () => {
  it("round-trips the artifact key", () => {
    expect(placesArtifactKey("ChIJx")).toBe("places:ChIJx");
    expect(placeIdFromArtifactKey("places:ChIJx")).toBe("ChIJx");
    expect(placeIdFromArtifactKey("places:")).toBeNull();
    expect(placeIdFromArtifactKey("uploads/p/r.csv")).toBeNull();
    expect(placeCacheKey("ChIJx")).toBe("places:p:ChIJx");
  });

  it("normalizes a search query and hashes it into the cache key", async () => {
    expect(normalizeSearchQuery("  Cedar   Ridge\tDental ")).toBe(
      "cedar ridge dental",
    );
    const key = await searchCacheKey("BOULDER");
    expect(key.startsWith(PLACES_SEARCH_CACHE_PREFIX)).toBe(true);
    expect(key).toMatch(/^places:q:[0-9a-f]{64}$/);
    expect(await searchCacheKey("  boulder ")).toBe(key);
  });
});

// --- The client over the fake -----------------------------------------------

function fakeCache(): PlacesCache & {
  entries: Map<string, { value: string; ttl: number }>;
} {
  const entries = new Map<string, { value: string; ttl: number }>();
  return {
    entries,
    async get(key) {
      return entries.get(key)?.value ?? null;
    },
    async put(key, value, ttl) {
      entries.set(key, { value, ttl });
    },
  };
}

function harness(apiKey = "fake") {
  const api = fakePlacesApi();
  const cache = fakeCache();
  const places = createPlacesClient({ apiKey, fetch: api.fetch, cache });
  return { api, cache, places };
}

describe("createPlacesClient: search", () => {
  it("returns the fixtures with the narrow field mask, then serves the same query from the cache", async () => {
    const { api, cache, places } = harness();
    const first = await places.search("Boulder");
    expect(first.cached).toBe(false);
    expect(first.matches.map((m) => m.name)).toEqual([
      "Cedar Ridge Dental",
      "Harbor Light Bakery",
      "Quiet Corner Books",
    ]);
    expect(first.matches[0]).toEqual({
      id: CEDAR_RIDGE_ID,
      name: "Cedar Ridge Dental",
      address: "1200 Cedar Ridge Rd, Boulder, CO 80302, USA",
      rating: 4.8,
      ratingCount: 212,
    });
    expect(api.calls).toEqual([
      {
        method: "POST",
        path: "/v1/places:searchText",
        fieldMask: PLACES_SEARCH_FIELD_MASK,
      },
    ]);
    expect(places.requests).toBe(1);

    // Same words, different spacing and case: one cache entry, no call.
    const second = await places.search("  boulder ");
    expect(second.cached).toBe(true);
    expect(second.matches).toEqual(first.matches);
    expect(api.calls).toHaveLength(1);
    expect(places.requests).toBe(1);

    const key = await searchCacheKey("BOULDER");
    expect(cache.entries.get(key)?.ttl).toBe(24 * 60 * 60);
    expect([...cache.entries.keys()]).toEqual([key]);
  });

  it("answers an empty list for no match and surfaces Google's refusals", async () => {
    const { places } = harness();
    expect((await places.search("nothing here")).matches).toEqual([]);

    const refused = harness("bad");
    await expect(refused.places.search("dental")).rejects.toMatchObject({
      name: "PlacesError",
      status: 400,
      code: "INVALID_ARGUMENT",
    });

    const down = harness();
    down.api.failWith = new Response("<html>502</html>", { status: 502 });
    const error = await down.places.search("dental").catch((e) => e);
    expect(error).toBeInstanceOf(PlacesError);
    expect(error.status).toBe(502);
    expect(error.message).toBe("Google answered 502.");
  });
});

describe("createPlacesClient: place", () => {
  it("fetches the place with its reviews, caches it for a day, and serves it from the cache", async () => {
    const { api, cache, places } = harness();
    const first = await places.place(CEDAR_RIDGE_ID);
    expect(first.cached).toBe(false);
    expect(first.place.reviews).toHaveLength(5);
    expect(api.calls).toEqual([
      {
        method: "GET",
        path: `/v1/places/${CEDAR_RIDGE_ID}`,
        fieldMask: PLACES_PLACE_FIELD_MASK,
      },
    ]);
    const entry = cache.entries.get(placeCacheKey(CEDAR_RIDGE_ID));
    expect(entry?.ttl).toBe(24 * 60 * 60);
    expect(JSON.parse(entry?.value ?? "{}").reviews).toHaveLength(5);

    const second = await places.place(CEDAR_RIDGE_ID);
    expect(second.cached).toBe(true);
    expect(api.calls).toHaveLength(1);
  });

  it("`fresh` bypasses the cached copy and writes the answer through", async () => {
    const { api, cache, places } = harness();
    await places.place(HARBOR_LIGHT_ID);
    // Poison the cache: a stale copy with no reviews.
    await cache.put(
      placeCacheKey(HARBOR_LIGHT_ID),
      JSON.stringify({ id: HARBOR_LIGHT_ID }),
      1,
    );
    const stale = await places.place(HARBOR_LIGHT_ID);
    expect(stale.cached).toBe(true);
    expect(stale.place.reviews).toBeUndefined();

    const fresh = await places.place(HARBOR_LIGHT_ID, { fresh: true });
    expect(fresh.cached).toBe(false);
    expect(fresh.place.reviews).toHaveLength(2);
    expect(api.calls).toHaveLength(2);
    expect(
      JSON.parse(cache.entries.get(placeCacheKey(HARBOR_LIGHT_ID))?.value ?? "")
        .reviews,
    ).toHaveLength(2);
    expect(cache.entries.get(placeCacheKey(HARBOR_LIGHT_ID))?.ttl).toBe(
      24 * 60 * 60,
    );
  });

  it("surfaces an unknown place as a 404 PlacesError and works without a cache", async () => {
    const api = fakePlacesApi();
    const places = createPlacesClient({ apiKey: "fake", fetch: api.fetch });
    await expect(places.place("ChIJnope")).rejects.toMatchObject({
      name: "PlacesError",
      status: 404,
      code: "NOT_FOUND",
    });
    const { place } = await places.place(QUIET_CORNER_ID);
    expect(place.reviews).toBeUndefined();
    expect((await places.place(QUIET_CORNER_ID)).cached).toBe(false);
  });

  it("strips a trailing slash from the base url", async () => {
    const api = fakePlacesApi();
    const places = createPlacesClient({
      apiKey: "fake",
      baseUrl: "http://places.local/",
      fetch: api.fetch,
    });
    const { matches } = await places.search("bakery");
    expect(matches.map((m) => m.id)).toEqual([HARBOR_LIGHT_ID]);
    expect(api.calls[0]?.path).toBe("/v1/places:searchText");
  });
});

describe("kvPlacesCache and describePlacesError", () => {
  it("adapts a KV-shaped store with expirationTtl", async () => {
    const puts: unknown[] = [];
    const store = new Map<string, string>();
    const cache = kvPlacesCache({
      get: async (key) => store.get(key) ?? null,
      put: async (key, value, options) => {
        puts.push([key, value, options]);
        store.set(key, value);
      },
    });
    await cache.put("k", "v", 60);
    expect(puts).toEqual([["k", "v", { expirationTtl: 60 }]]);
    expect(await cache.get("k")).toBe("v");
    expect(await cache.get("missing")).toBeNull();
  });

  it("describes Google's refusals for a human without the raw body", () => {
    expect(describePlacesError(new PlacesError("x", 404))).toBe(
      "Google no longer lists this place.",
    );
    expect(describePlacesError(new PlacesError("x", 403))).toContain(
      "Places API key",
    );
    expect(describePlacesError(new PlacesError("x", 429))).toContain(
      "rate-limiting",
    );
    expect(describePlacesError(new PlacesError("<html>", 503))).toBe(
      "Google Places is unavailable right now.",
    );
    expect(describePlacesError(new PlacesError("bad mask", 400))).toBe(
      "Google refused the request: bad mask",
    );
  });
});
