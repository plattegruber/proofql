// The Takeout reader against a fabricated export laid out like the real
// thing (packages/core/test/fixtures/takeout): one business with two
// locations, the main one paged across two files and repeated under a
// second account folder, star-only, edited, translated, anonymous and
// replied reviews, unknown keys, and a Maps Reviews.json beside it. Every
// name and review in the fixture is invented.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildTakeoutPayload,
  exportAsOf,
  groupTakeoutFiles,
  isTakeoutEntryOfInterest,
  locationIdOf,
  MAPS_REVIEWS_FILE,
  mapTakeoutReview,
  normalizeTakeoutPayload,
  ratingFromStars,
  readTakeoutJson,
  reviewSuffix,
  reviewText,
  TAKEOUT_ANONYMOUS_AUTHOR,
  TAKEOUT_REVIEWS_FILE,
  type TakeoutFile,
  TakeoutShapeError,
  takeoutPayloadSchema,
} from "./takeout.js";

const ROOT = new URL("../../test/fixtures/takeout/", import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** The fixture as the browser hands it over: archive paths and file text. */
function fixtureFiles(): TakeoutFile[] {
  return walk(ROOT)
    .map((path) => ({
      path: relative(ROOT, path),
      text: readFileSync(path, "utf8"),
    }))
    .filter((f) => isTakeoutEntryOfInterest(f.path));
}

describe("archive paths", () => {
  it("matches review pages, not the other files", () => {
    const base = "Takeout/Google Business Profile/account-1/location-2";
    expect(TAKEOUT_REVIEWS_FILE.test(`${base}/reviews.json`)).toBe(true);
    expect(TAKEOUT_REVIEWS_FILE.test(`${base}/reviews-ABHRLX_x-y.json`)).toBe(
      true,
    );
    expect(TAKEOUT_REVIEWS_FILE.test(`${base}/additionalData.json`)).toBe(
      false,
    );
    expect(TAKEOUT_REVIEWS_FILE.test(`${base}/photos/reviews.json`)).toBe(
      false,
    );
    expect(isTakeoutEntryOfInterest(`${base}/photo-1.jpg`)).toBe(false);
    expect(
      MAPS_REVIEWS_FILE.test("Takeout/Maps (your places)/Reviews.json"),
    ).toBe(true);
  });

  it("finds the account-independent suffix and the location", () => {
    expect(reviewSuffix("accounts/1/locations/2/reviews/abc")).toBe(
      "locations/2/reviews/abc",
    );
    expect(reviewSuffix("locations/2/reviews/abc")).toBe(
      "locations/2/reviews/abc",
    );
    expect(reviewSuffix("places/x/reviews/abc")).toBeNull();
    expect(locationIdOf("accounts/1/locations/2/reviews/abc")).toBe("2");
  });
});

describe("readTakeoutJson", () => {
  it("recognises Maps' Reviews.json by content", () => {
    expect(
      readTakeoutJson('{"type":"FeatureCollection","features":[]}').kind,
    ).toBe("maps-reviews");
  });

  it("reads the listing name", () => {
    const file = fixtureFiles().find((f) =>
      f.path.endsWith("location-2002/additionalData.json"),
    ) as TakeoutFile;
    expect(readTakeoutJson(file.text)).toEqual({
      kind: "location-data",
      title: "Harbor Light Bakery — Pearl Street",
    });
  });

  it("keeps only the keys it reads", () => {
    const content = readTakeoutJson(
      JSON.stringify({
        reviews: [
          {
            name: "accounts/1/locations/2/reviews/r",
            createTime: "2025-01-01T00:00:00Z",
            reviewer: { displayName: "A", isAnonymous: false },
            reviewMediaItems: [{}],
          },
        ],
      }),
    );
    expect(content).toEqual({
      kind: "reviews",
      invalid: 0,
      reviews: [
        {
          name: "accounts/1/locations/2/reviews/r",
          createTime: "2025-01-01T00:00:00Z",
          reviewer: { displayName: "A" },
        },
      ],
    });
  });

  it("refuses a reviews list with no reviews in it, and broken JSON", () => {
    expect(() =>
      readTakeoutJson('{"reviews":[{"comment":"no name or date"}]}'),
    ).toThrow(TakeoutShapeError);
    expect(() => readTakeoutJson("{nope")).toThrow("not valid JSON");
  });

  it("tolerates a byte-order mark and unrelated JSON", () => {
    expect(readTakeoutJson('﻿{"reviews":[]}')).toEqual({
      kind: "reviews",
      reviews: [],
      invalid: 0,
    });
    expect(readTakeoutJson('{"name":"accounts/1"}').kind).toBe("other");
    expect(readTakeoutJson("[1,2]").kind).toBe("other");
  });
});

describe("groupTakeoutFiles on the fixture export", () => {
  const exported = groupTakeoutFiles(fixtureFiles());

  it("finds both locations with their titles", () => {
    expect(
      exported.locations.map((l) => [l.locationId, l.title, l.reviews.length]),
    ).toEqual([
      ["2001", "Harbor Light Bakery", 23],
      ["2002", "Harbor Light Bakery — Pearl Street", 4],
    ]);
  });

  it("merges pages and collapses the second account folder's repeats", () => {
    expect(exported.duplicates).toBe(2);
    const main = exported.locations[0];
    const edited = main?.reviews.find((r) => r.name.endsWith("/AbFvOq001Tk"));
    // The copy under account-77 was edited later, so it wins.
    expect(edited?.comment).toContain("Edited:");
  });

  it("counts star-only reviews and notices the Maps file", () => {
    expect(exported.locations[0]?.starOnly).toBe(2);
    expect(exported.mapsReviews).toBe(true);
    expect(exported.invalid).toBe(0);
  });

  it("orders reviews by creation time", () => {
    const times = exported.locations[0]?.reviews.map((r) => r.createTime);
    expect(times).toEqual([...(times ?? [])].sort());
  });
});

describe("mapTakeoutReview", () => {
  const exported = groupTakeoutFiles(fixtureFiles());
  const main = exported.locations[0] as (typeof exported.locations)[number];
  const byId = (id: string) =>
    main.reviews.find((r) => r.name.endsWith(`/${id}`)) as NonNullable<
      (typeof main.reviews)[number]
    >;

  it("maps a replied review onto the review shape, reply in metadata", () => {
    const result = mapTakeoutReview(byId("AbFvOq000Tk"), main);
    expect(result).toEqual({
      ok: true,
      editedAt: Date.parse("2025-01-01T10:15:30.123456Z"),
      review: {
        external_id: "accounts/1009/locations/2001/reviews/AbFvOq000Tk",
        source: "google",
        rating: 5,
        text: "The sourdough has a crackly crust and an open crumb. Worth the early line.",
        author_name: "Avery Lin",
        author_avatar_url: null,
        occurred_at: "2025-01-01T10:15:30.123Z",
        url: null,
        metadata: {
          location: "2001",
          location_title: "Harbor Light Bakery",
          import_source: "takeout",
          google_update_time: "2025-01-01T10:15:30.123Z",
          owner_reply: "Thank you, Avery! We hope to see you again soon.",
          owner_reply_updated_at: "2025-01-02T10:15:30.123Z",
        },
      },
    });
  });

  it("skips star-only reviews", () => {
    expect(mapTakeoutReview(byId("AbFvOq006Tk"), main)).toEqual({
      ok: false,
      reason: "star_only",
    });
  });

  it("keeps the original of a translated review", () => {
    const result = mapTakeoutReview(byId("AbFvOq009Tk"), main);
    expect(result.ok && result.review.text).toBe(
      "El latte con leche de avena es excelente.",
    );
  });

  it("names an anonymous reviewer and uses updateTime for edits", () => {
    const anonymous = mapTakeoutReview(byId("AbFvOq011Tk"), main);
    expect(anonymous.ok && anonymous.review.author_name).toBe(
      TAKEOUT_ANONYMOUS_AUTHOR,
    );
    const edited = mapTakeoutReview(byId("AbFvOq004Tk"), main);
    expect(edited.ok && edited.review.metadata?.google_update_time).toBe(
      "2025-03-11T10:15:30.654Z",
    );
    expect(edited.ok && edited.review.occurred_at).toBe(
      "2025-02-09T10:15:30.123Z",
    );
  });

  it("truncates a long reply to the metadata limit, never into text", () => {
    const result = mapTakeoutReview(byId("AbFvOq003Tk"), main);
    const reply = result.ok ? result.review.metadata?.owner_reply : "";
    expect(reply).toHaveLength(512);
    expect(reply?.endsWith("…")).toBe(true);
    expect(result.ok && result.review.text).not.toContain("Thank you");
  });

  it("rejects an unreadable date and an over-long text with a reason", () => {
    expect(
      mapTakeoutReview(
        {
          name: "accounts/1/locations/2/reviews/r",
          createTime: "soon",
          comment: "x",
        },
        { locationId: "2", title: null },
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      mapTakeoutReview(
        {
          name: "accounts/1/locations/2/reviews/r",
          createTime: "2025-01-01T00:00:00Z",
          comment: "x".repeat(20_001),
        },
        { locationId: "2", title: null },
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("reads star ratings", () => {
    expect(
      ["ONE", "TWO", "THREE", "FOUR", "FIVE"].map(ratingFromStars),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(ratingFromStars("STAR_RATING_UNSPECIFIED")).toBeNull();
    expect(ratingFromStars(undefined)).toBeNull();
  });

  it("leaves untranslated text alone", () => {
    expect(reviewText("  (Original) is a fine word  ")).toBe(
      "(Original) is a fine word",
    );
    expect(reviewText(undefined)).toBe("");
  });
});

describe("the payload", () => {
  const exported = groupTakeoutFiles(fixtureFiles());

  it("round-trips through the schema and normalizes to the same locations", () => {
    const payload = takeoutPayloadSchema.parse(
      JSON.parse(JSON.stringify(buildTakeoutPayload(exported.locations, true))),
    );
    const normalized = normalizeTakeoutPayload(payload);
    expect(normalized.complete).toBe(true);
    expect(normalized.duplicates).toBe(0);
    expect(normalized.misfiled).toBe(0);
    expect(normalized.locations.map((l) => l.reviews.length)).toEqual([23, 4]);
  });

  it("drops reviews filed under the wrong location and repeats", () => {
    const [main] = exported.locations;
    const first = main?.reviews[0] as NonNullable<
      NonNullable<typeof main>["reviews"][number]
    >;
    const normalized = normalizeTakeoutPayload({
      format: "proofql.takeout.v1",
      complete: false,
      locations: [
        { location_id: "2001", title: null, reviews: [first, first] },
        { location_id: "9999", title: null, reviews: [first] },
      ],
    });
    expect(normalized.duplicates).toBe(1);
    expect(normalized.misfiled).toBe(1);
    expect(normalized.locations).toHaveLength(1);
  });

  it("refuses unknown keys and an empty location list", () => {
    expect(
      takeoutPayloadSchema.safeParse({
        format: "proofql.takeout.v1",
        complete: true,
        locations: [],
      }).success,
    ).toBe(false);
    expect(
      takeoutPayloadSchema.safeParse({
        format: "proofql.takeout.v1",
        complete: true,
        locations: [
          {
            location_id: "1",
            title: null,
            reviews: [
              {
                name: "accounts/1/locations/1/reviews/r",
                createTime: "2025-01-01T00:00:00Z",
                photo: "x",
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("knows how recent a location's export is", () => {
    expect(exportAsOf(exported.locations[0]?.reviews ?? [])).toBe(
      Date.parse("2025-08-05T10:15:30.999Z"),
    );
    expect(exportAsOf([])).toBeNull();
  });
});
