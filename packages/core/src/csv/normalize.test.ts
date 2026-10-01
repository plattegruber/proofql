import { describe, expect, it } from "vitest";
import { fixture } from "../../test/csv-fixtures.js";
import { detectMapping } from "./detect.js";
import { parseJsonTable } from "./json.js";
import type { CsvMapping } from "./mapping.js";
import { normalizeRow, normalizeSource, validateRows } from "./normalize.js";
import { parseCsv } from "./parse.js";
import { csvProfile } from "./profiles.js";
import { sha1Hex } from "./values.js";

const headers = [
  "id",
  "who",
  "stars",
  "when",
  "body",
  "site",
  "link",
  "lang",
  "loc",
];
const mapping: CsvMapping = {
  fields: {
    external_id: "id",
    author_name: "who",
    rating: "stars",
    occurred_at: "when",
    text: "body",
    source: "site",
    url: "link",
    language: "lang",
  },
  metadata: { loc: "location" },
};
const defaults = { source: "custom" as const };

describe("normalizeRow", () => {
  it("produces a validated ReviewInput", () => {
    const result = normalizeRow(
      [
        "r1",
        " Marcus T. ",
        "4/5",
        "Jan 5, 2026",
        " Great. ",
        "Google Maps",
        "https://g.page/r/1",
        "en",
        "north",
      ],
      headers,
      mapping,
      defaults,
    );
    expect(result).toEqual({
      ok: true,
      warnings: [],
      review: {
        external_id: "r1",
        source: "google",
        rating: 4,
        text: "Great.",
        author_name: "Marcus T.",
        author_avatar_url: null,
        occurred_at: "2026-01-05T00:00:00.000Z",
        url: "https://g.page/r/1",
        language: "en",
        metadata: { location: "north" },
      },
    });
  });

  it("falls back to the default source, Anonymous, and a sha1 external_id", () => {
    const result = normalizeRow(
      ["", "", "", "2026-01-05", "Some review text here.", "", "", "", ""],
      headers,
      mapping,
      defaults,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.review.source).toBe("custom");
    expect(result.review.rating).toBeNull();
    expect(result.review.author_name).toBe("Anonymous");
    expect(result.review.external_id).toBe(
      sha1Hex(
        "custom|Anonymous|2026-01-05T00:00:00.000Z|Some review text here.",
      ),
    );
    expect(result.review.metadata).toBeUndefined();
    expect(result.warnings).toEqual([
      '"who" is empty; the author is stored as Anonymous.',
    ]);
  });

  it("hashes only the first 64 characters of the text", () => {
    const long = "x".repeat(200);
    const a = normalizeRow(
      ["", "A", "", "2026-01-05", long, "", "", "", ""],
      headers,
      mapping,
      defaults,
    );
    const b = normalizeRow(
      ["", "A", "", "2026-01-05", `${"x".repeat(64)}different`, "", "", "", ""],
      headers,
      mapping,
      defaults,
    );
    expect(a.ok && b.ok && a.review.external_id === b.review.external_id).toBe(
      true,
    );
  });

  it("collects every error on the row with the column and value", () => {
    const result = normalizeRow(
      ["r2", "Dana", "excellent", "sometime", "", "", "", "", ""],
      headers,
      mapping,
      defaults,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => [e.field, e.column, e.value])).toEqual([
      ["text", "body", ""],
      ["rating", "stars", "excellent"],
      ["occurred_at", "when", "sometime"],
    ]);
    for (const e of result.errors) expect(e.message).toMatch(/[a-z]/);
  });

  it("reports unmapped required fields", () => {
    const result = normalizeRow(
      ["x"],
      ["only"],
      { fields: {}, metadata: {} },
      defaults,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field)).toEqual(["text", "occurred_at"]);
    expect(result.errors[0]?.column).toBeNull();
  });

  it("drops an invalid URL with a warning instead of failing the row", () => {
    const result = normalizeRow(
      ["r3", "Lee", "5", "2026-01-05", "Fine.", "", "not a url", "", ""],
      headers,
      mapping,
      defaults,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.review.url).toBeNull();
    expect(result.warnings).toEqual(['"link" is not a URL and was left out.']);
  });

  it("surfaces schema limits as row errors", () => {
    const result = normalizeRow(
      ["r4", "Lee", "5", "2026-01-05", "y".repeat(20_001), "", "", "", ""],
      headers,
      mapping,
      defaults,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ field: "text", column: "body" });
  });
});

describe("normalizeSource", () => {
  it.each([
    ["Google Maps", "google"],
    ["GOOGLE", "google"],
    ["Yelp", "yelp"],
    ["FB", "facebook"],
    ["Facebook Page", "facebook"],
    ["Trustpilot", "trustpilot"],
    ["Healthgrades", "custom"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeSource(raw)).toBe(expected);
  });
});

describe("profiles end to end", () => {
  function normalizeFixture(name: string) {
    const table = name.endsWith(".json")
      ? parseJsonTable(fixture(name))
      : parseCsv(fixture(name));
    const detected = detectMapping(table.headers, table.rows);
    const profile = csvProfile(detected.profile);
    return table.rows.map((row) =>
      normalizeRow(row, table.headers, detected.mapping, {
        source: profile.source,
      }),
    );
  }

  it("Google Takeout: word ratings, dotted author, fractional-second times, a review without text fails", () => {
    const [a, b, c] = normalizeFixture("google-takeout.json");
    expect(a?.ok && a.review).toMatchObject({
      external_id: "accounts/1/locations/2/reviews/AbC123",
      source: "google",
      rating: 5,
      author_name: "Marcus T.",
      author_avatar_url: "https://lh3.googleusercontent.com/a/photo1",
      occurred_at: "2026-01-05T18:20:00.123Z",
    });
    expect(b?.ok && b.review.rating).toBe(4);
    expect(c?.ok).toBe(false);
  });

  it("Yelp, Trustpilot, Birdeye, Podium and GBP all normalize every row", () => {
    for (const name of [
      "yelp.csv",
      "trustpilot.csv",
      "birdeye.csv",
      "podium.csv",
      "google-business-profile.csv",
    ]) {
      const results = normalizeFixture(name);
      expect(
        results.every((r) => r.ok),
        name,
      ).toBe(true);
    }
    const [tp] = normalizeFixture("trustpilot.csv");
    expect(tp?.ok && tp.review).toMatchObject({
      source: "trustpilot",
      language: "en",
      metadata: { title: "Great implant work", country: "US" },
    });
    const birdeye = normalizeFixture("birdeye.csv");
    expect(birdeye.map((r) => r.ok && r.review.source)).toEqual([
      "google",
      "facebook",
      "custom",
    ]);
    expect(birdeye[0]?.ok && birdeye[0].review.occurred_at).toBe(
      "2026-01-05T09:12:00.000Z",
    );
    const [podium] = normalizeFixture("podium.csv");
    expect(podium?.ok && podium.review.occurred_at).toBe(
      "2026-01-05T00:00:00.000Z",
    );
  });
});

describe("validateRows", () => {
  it("tallies the generic fixtures", () => {
    const good = parseCsv(fixture("generic-50.csv"));
    const detected = detectMapping(good.headers, good.rows);
    const ok = validateRows(
      good.rows,
      good.headers,
      detected.mapping,
      defaults,
    );
    expect(ok).toMatchObject({ total: 50, valid: 50, invalid: 0, errors: [] });

    const bad = parseCsv(fixture("generic-50-3-bad.csv"));
    const summary = validateRows(
      bad.rows,
      bad.headers,
      detected.mapping,
      defaults,
    );
    expect(summary).toMatchObject({ total: 50, valid: 47, invalid: 3 });
    expect(summary.errors.map((e) => e.rowNumber)).toEqual([5, 17, 33]);
    expect(summary.errors.map((e) => e.errors[0]?.field)).toEqual([
      "text",
      "rating",
      "occurred_at",
    ]);
  });
});
