// The pure side of the Places bootstrap (#47): response shapes, the mapper
// onto reviewInputSchema (text fallback, missing text, missing reviews,
// attribution gaps), and the key conventions. No services.
import { describe, expect, it } from "vitest";

import {
  CEDAR_RIDGE_ID,
  FAKE_PLACES,
  HARBOR_LIGHT_ID,
  QUIET_CORNER_ID,
} from "../../test/fake-places";
import {
  mapPlaceReview,
  mapPlaceReviews,
  normalizeSearchQuery,
  PLACES_ANONYMOUS_AUTHOR,
  PLACES_PLACE_FIELD_MASK,
  PLACES_SEARCH_FIELD_MASK,
  placeCacheKey,
  placeDetailsSchema,
  placeIdFromArtifactKey,
  placesActionPath,
  placesArtifactKey,
  placesSearchQuerySchema,
  placesSearchResponseSchema,
  toPlaceMatch,
} from "./places";

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

describe("keys, queries and paths", () => {
  it("round-trips the artifact key", () => {
    expect(placesArtifactKey("ChIJx")).toBe("places:ChIJx");
    expect(placeIdFromArtifactKey("places:ChIJx")).toBe("ChIJx");
    expect(placeIdFromArtifactKey("places:")).toBeNull();
    expect(placeIdFromArtifactKey("uploads/p/r.csv")).toBeNull();
    expect(placeCacheKey("ChIJx")).toBe("places:p:ChIJx");
  });

  it("normalizes a search query and bounds its length", () => {
    expect(normalizeSearchQuery("  Cedar   Ridge\tDental ")).toBe(
      "cedar ridge dental",
    );
    expect(placesSearchQuerySchema.safeParse("ab").success).toBe(false);
    expect(placesSearchQuerySchema.safeParse("  Cedar ").data).toBe("Cedar");
    expect(placesSearchQuerySchema.safeParse("x".repeat(201)).success).toBe(
      false,
    );
  });

  it("builds the resource route path", () => {
    expect(placesActionPath("cedar")).toBe("/app/projects/cedar/places");
  });
});
