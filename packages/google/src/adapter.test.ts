import { reviewInputSchema } from "@proofql/core";
import { describe, expect, it } from "vitest";

import {
  ANONYMOUS_AUTHOR_NAME,
  adaptReview,
  adaptReviews,
  googleReviewsUrl,
} from "./adapter.js";
import { defaultFixtures } from "./fake/fixtures.js";

const location = {
  id: "201",
  title: "Cedar Ridge Dental — North",
  placeId: "ChIJnorth0000000000000001",
};

const base = {
  name: "accounts/100/locations/201/reviews/AbC123",
  reviewId: "AbC123",
  reviewer: {
    displayName: "Marcus T.",
    profilePhotoUrl: "https://lh3.googleusercontent.com/a/x=s120-c",
  },
  starRating: "FIVE",
  comment: "  Dr. Patel did my implant and I forgot it wasn't my own tooth.  ",
  createTime: "2026-03-14T18:20:00Z",
  updateTime: "2026-03-20T09:00:00Z",
};

describe("adaptReview", () => {
  it("maps a v4 review to a ReviewInput keyed on the resource name", () => {
    const outcome = adaptReview(base, location);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.updateTime).toBe("2026-03-20T09:00:00Z");
    expect(outcome.review).toEqual({
      external_id: "accounts/100/locations/201/reviews/AbC123",
      source: "google",
      rating: 5,
      text: "Dr. Patel did my implant and I forgot it wasn't my own tooth.",
      author_name: "Marcus T.",
      author_avatar_url: "https://lh3.googleusercontent.com/a/x=s120-c",
      // The experience happened at createTime; the edit only moved the text.
      occurred_at: "2026-03-14T18:20:00Z",
      url: "https://search.google.com/local/reviews?placeid=ChIJnorth0000000000000001",
      metadata: {
        location: "201",
        location_title: "Cedar Ridge Dental — North",
      },
    });
    // What the push API would accept is what we produce.
    expect(reviewInputSchema.safeParse(outcome.review).success).toBe(true);
  });

  it("tolerates unknown fields at every level", () => {
    const outcome = adaptReview(
      {
        ...base,
        reviewMediaItems: [{ foo: 1 }],
        policyViolation: "NONE",
        reviewer: { ...base.reviewer, newThing: true },
        reviewReply: {
          comment: "Thanks",
          reviewReplyState: "SOME_FUTURE_STATE",
          extra: {},
        },
      },
      location,
    );
    expect(outcome.status).toBe("ok");
  });

  it("maps every star value and rejects unknown vocabulary", () => {
    const stars = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 } as const;
    for (const [star, value] of Object.entries(stars)) {
      const o = adaptReview({ ...base, starRating: star }, location);
      expect(o.status === "ok" && o.review.rating).toBe(value);
    }
    const unspecified = adaptReview(
      { ...base, starRating: "STAR_RATING_UNSPECIFIED" },
      location,
    );
    expect(unspecified.status).toBe("invalid");
    if (unspecified.status === "invalid") {
      expect(unspecified.issues[0]?.path).toBe("starRating");
    }
  });

  it("skips star-only reviews (no comment, or whitespace) and reports their updateTime", () => {
    const { comment: _omit, ...starOnly } = base;
    expect(adaptReview(starOnly, location)).toEqual({
      status: "star_only",
      updateTime: base.updateTime,
    });
    expect(adaptReview({ ...base, comment: "   " }, location).status).toBe(
      "star_only",
    );
  });

  it("names anonymous and nameless reviewers, and drops bad avatar urls", () => {
    const anon = adaptReview(
      {
        ...base,
        reviewer: { isAnonymous: true, displayName: "A Google user" },
      },
      location,
    );
    expect(anon.status === "ok" && anon.review.author_name).toBe(
      ANONYMOUS_AUTHOR_NAME,
    );
    const { reviewer: _r, ...noReviewer } = base;
    const nameless = adaptReview(noReviewer, location);
    expect(nameless.status === "ok" && nameless.review.author_name).toBe(
      ANONYMOUS_AUTHOR_NAME,
    );
    expect(nameless.status === "ok" && nameless.review.author_avatar_url).toBe(
      null,
    );
    const badAvatar = adaptReview(
      { ...base, reviewer: { displayName: "X", profilePhotoUrl: "not a url" } },
      location,
    );
    expect(
      badAvatar.status === "ok" && badAvatar.review.author_avatar_url,
    ).toBe(null);
  });

  it("rejects a malformed name or time with the field path", () => {
    const badName = adaptReview({ ...base, name: "reviews/x" }, location);
    expect(badName.status).toBe("invalid");
    const badTime = adaptReview({ ...base, createTime: "yesterday" }, location);
    expect(badTime.status === "invalid" && badTime.issues[0]?.path).toBe(
      "createTime",
    );
  });

  it("has no url without a place id", () => {
    expect(googleReviewsUrl(undefined)).toBeNull();
    const o = adaptReview(base, { id: "1", title: "T" });
    expect(o.status === "ok" && o.review.url).toBeNull();
  });
});

describe("adaptReviews over the fake fixtures", () => {
  it("adapts every fixture review except the star-only ones", () => {
    const fixtures = defaultFixtures();
    const north = fixtures.reviews.filter((r) =>
      r.name.includes("/locations/201/"),
    );
    const page = adaptReviews(north, location);
    expect(north).toHaveLength(70);
    expect(page.invalid).toEqual([]);
    expect(page.starOnly).toBe(1);
    expect(page.reviews).toHaveLength(69);
    expect(new Set(page.reviews.map((r) => r.external_id)).size).toBe(69);
    for (const r of page.reviews) {
      expect(r.metadata).toEqual({
        location: "201",
        location_title: location.title,
      });
    }
  });
});
