import { describe, expect, it } from "vitest";
import { fixture } from "../../test/csv-fixtures.js";
import { detectMapping } from "./detect.js";
import { parseJsonTable } from "./json.js";
import { parseCsv } from "./parse.js";

function detectFixture(name: string) {
  const table = name.endsWith(".json")
    ? parseJsonTable(fixture(name))
    : parseCsv(fixture(name));
  return { table, detected: detectMapping(table.headers, table.rows) };
}

describe("detectMapping — built-in profiles", () => {
  it("Google Takeout Reviews.json", () => {
    const { detected } = detectFixture("google-takeout.json");
    expect(detected.profile).toBe("google-takeout");
    expect(detected.confidence).toBe(1);
    expect(detected.mapping.fields).toEqual({
      external_id: "name",
      author_name: "reviewer.displayName",
      author_avatar_url: "reviewer.profilePhotoUrl",
      rating: "starRating",
      text: "comment",
      occurred_at: "createTime",
    });
  });

  it("Google Business Profile export", () => {
    const { detected } = detectFixture("google-business-profile.csv");
    expect(detected.profile).toBe("google-business-profile");
    expect(detected.mapping.fields).toEqual({
      external_id: "Review ID",
      author_name: "Reviewer Name",
      author_avatar_url: "Reviewer Photo",
      rating: "Star Rating",
      text: "Review Text",
      occurred_at: "Review Date",
      url: "Review URL",
    });
    expect(detected.mapping.metadata).toEqual({ "Location Name": "location" });
  });

  it("Yelp", () => {
    const { detected } = detectFixture("yelp.csv");
    expect(detected.profile).toBe("yelp");
    expect(detected.mapping.fields).toEqual({
      external_id: "Review ID",
      author_name: "Reviewer",
      rating: "Rating",
      text: "Review",
      occurred_at: "Review Date",
      url: "Review URL",
    });
    expect(detected.mapping.metadata).toEqual({ "Business Name": "business" });
  });

  it("Trustpilot (semicolon-delimited)", () => {
    const { detected } = detectFixture("trustpilot.csv");
    expect(detected.profile).toBe("trustpilot");
    expect(detected.mapping.fields).toEqual({
      external_id: "Review Id",
      author_name: "Reviewer Name",
      rating: "Review Stars",
      text: "Review Content",
      occurred_at: "Review Date",
      url: "Review Link",
      language: "Language",
    });
    expect(detected.mapping.metadata).toEqual({
      "Review Title": "title",
      "Reviewer Country": "country",
    });
  });

  it("Birdeye", () => {
    const { detected } = detectFixture("birdeye.csv");
    expect(detected.profile).toBe("birdeye");
    expect(detected.mapping.fields).toMatchObject({
      external_id: "Review ID",
      source: "Source",
      author_name: "Reviewer Name",
      rating: "Rating",
      text: "Review",
      occurred_at: "Review Date",
      url: "Review URL",
    });
    expect(detected.mapping.metadata).toEqual({
      Location: "location",
      "Business Name": "business",
    });
  });

  it("Podium", () => {
    const { detected } = detectFixture("podium.csv");
    expect(detected.profile).toBe("podium");
    expect(detected.mapping.fields).toEqual({
      external_id: "Review Id",
      source: "Site",
      author_name: "Customer Name",
      rating: "Stars",
      text: "Comment",
      occurred_at: "Date Posted",
      url: "Link",
    });
    expect(detected.mapping.metadata).toEqual({ "Location Name": "location" });
  });
});

describe("detectMapping — generic heuristics", () => {
  it("maps a generic export by header names and leaves extras unmapped", () => {
    const { detected } = detectFixture("generic-50.csv");
    expect(detected.profile).toBe("generic");
    expect(detected.mapping.fields).toEqual({
      external_id: "Review ID",
      author_name: "Author",
      rating: "Rating",
      occurred_at: "Date",
      text: "Review Text",
    });
    expect(detected.mapping.metadata).toEqual({});
  });

  it("falls back to sample values when headers say nothing", () => {
    const headers = ["col_1", "col_2", "col_3", "col_4"];
    const rows = [
      [
        "x1",
        "2026-01-05",
        "5",
        "A long enough sentence about the visit to count as text.",
      ],
      [
        "x2",
        "1/14/2026",
        "★★★★☆",
        "Another review body with several words in it, clearly prose.",
      ],
    ];
    const { mapping } = detectMapping(headers, rows);
    expect(mapping.fields).toEqual({
      occurred_at: "col_2",
      rating: "col_3",
      text: "col_4",
    });
  });

  it("does not trust a 'rating' header whose cells are not ratings", () => {
    const { mapping } = detectMapping(
      ["rating", "date", "text"],
      [
        ["excellent", "2026-01-01", "Good enough review text to be text."],
        ["poor", "2026-01-02", "Another sufficiently long review text."],
      ],
    );
    expect(mapping.fields.rating).toBeUndefined();
    expect(mapping.fields.occurred_at).toBe("date");
  });

  it("honours a forced profile", () => {
    const { table } = detectFixture("yelp.csv");
    const forced = detectMapping(table.headers, table.rows, {
      profile: "generic",
    });
    expect(forced.profile).toBe("generic");
    expect(forced.confidence).toBe(1);
    expect(forced.mapping.fields.text).toBe("Review");
  });
});
