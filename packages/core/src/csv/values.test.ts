import { describe, expect, it } from "vitest";

import { parseDate, parseRating, sha1Hex } from "./values.js";

describe("parseRating", () => {
  it.each([
    ["5", 5],
    ["5.0", 5],
    ["4.5", 5],
    ["4,5", 5],
    ["3.2", 3],
    ["5/5", 5],
    ["4 / 5", 4],
    ["8/10", 4],
    ["4 out of 5", 4],
    ["★★★★★", 5],
    ["★★★☆☆", 3],
    ["⭐⭐⭐⭐", 4],
    ["5 stars", 5],
    ["1 star", 1],
    ["FIVE", 5],
    ["Four", 4],
    ["ONE", 1],
    ["Rated 4", 4],
    ["9", 5], // 10-point scale rescaled
    ["7", 4],
  ])("%s → %i", (raw, expected) => {
    expect(parseRating(raw)).toBe(expected);
  });

  it.each([
    "",
    "  ",
    "excellent",
    "0",
    "11",
    "-1",
    "4 stars out of 5 wow",
    "N/A",
  ])("rejects %j", (raw) => {
    expect(parseRating(raw)).toBeNull();
  });
});

describe("parseDate", () => {
  it.each([
    ["2026-03-14T18:20:00Z", "2026-03-14T18:20:00.000Z"],
    ["2026-03-14T18:20:00.123456Z", "2026-03-14T18:20:00.123Z"],
    ["2026-03-14T13:20:00-05:00", "2026-03-14T18:20:00.000Z"],
    ["2026-03-14T20:20:00+0200", "2026-03-14T18:20:00.000Z"],
    ["2026-03-14T18:20:00", "2026-03-14T18:20:00.000Z"],
    ["2026-03-14 18:20", "2026-03-14T18:20:00.000Z"],
    ["2026-03-14", "2026-03-14T00:00:00.000Z"],
    ["3/14/2026", "2026-03-14T00:00:00.000Z"],
    ["03/14/2026 06:20 PM", "2026-03-14T18:20:00.000Z"],
    ["3/14/26", "2026-03-14T00:00:00.000Z"],
    ["12/1/2025 12:05 AM", "2025-12-01T00:05:00.000Z"],
    ["14.03.2026", "2026-03-14T00:00:00.000Z"],
    ["Jan 5, 2026", "2026-01-05T00:00:00.000Z"],
    ["January 5th, 2026 at 3:04 PM", "2026-01-05T15:04:00.000Z"],
    ["Mar 1 2026", "2026-03-01T00:00:00.000Z"],
    ["Saturday, March 14, 2026", "2026-03-14T00:00:00.000Z"],
    ["5 Jan 2026", "2026-01-05T00:00:00.000Z"],
    ["1736035200", "2025-01-05T00:00:00.000Z"],
    ["1736035200000", "2025-01-05T00:00:00.000Z"],
  ])("%s → %s", (raw, expected) => {
    expect(parseDate(raw)).toBe(expected);
  });

  it.each([
    "",
    "sometime last spring",
    "2026-02-30",
    "13/14/2026",
    "2026-03-14T25:00:00Z",
    "12345",
    "Foo 5, 2026",
  ])("rejects %j", (raw) => {
    expect(parseDate(raw)).toBeNull();
  });
});

describe("sha1Hex", () => {
  it("matches the reference vectors", () => {
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(sha1Hex("The quick brown fox jumps over the lazy dog")).toBe(
      "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12",
    );
    // 64 bytes exactly: the padding has to spill into a second block.
    expect(sha1Hex("a".repeat(64))).toBe(
      "0098ba824b5c16427bd7a1122a5a442a25ec644d",
    );
    expect(sha1Hex("★ unicode ★")).toHaveLength(40);
  });
});
