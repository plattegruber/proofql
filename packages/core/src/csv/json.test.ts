import { describe, expect, it } from "vitest";

import { fixture } from "../../test/csv-fixtures.js";
import { flattenJsonToTable, JsonShapeError, parseJsonTable } from "./json.js";

describe("parseJsonTable", () => {
  it("flattens Google Takeout's Reviews.json to dotted headers in first-appearance order", () => {
    const { headers, rows } = parseJsonTable(fixture("google-takeout.json"));
    expect(headers).toEqual([
      "name",
      "reviewId",
      "reviewer.displayName",
      "reviewer.profilePhotoUrl",
      "starRating",
      "comment",
      "createTime",
      "updateTime",
      "reviewReply.comment",
      "reviewReply.updateTime",
      "reviewer.isAnonymous",
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.[2]).toBe("Marcus T.");
    expect(rows[0]?.[4]).toBe("FIVE");
    // Missing keys are empty cells, booleans stringify.
    expect(rows[2]?.[5]).toBe("");
    expect(rows[2]?.[10]).toBe("true");
  });

  it("accepts a bare array and picks a named collection among several arrays", () => {
    expect(flattenJsonToTable([{ a: 1 }, { a: 2, b: "x" }])).toEqual({
      headers: ["a", "b"],
      rows: [
        ["1", ""],
        ["2", "x"],
      ],
    });
    const table = flattenJsonToTable({
      meta: [1],
      reviews: [{ t: "hi", tags: ["a"] }],
    });
    expect(table.headers).toEqual(["t", "tags"]);
    expect(table.rows).toEqual([["hi", '["a"]']]);
  });

  it("rejects shapes that are not a list of records", () => {
    expect(() => parseJsonTable("{not json")).toThrow(JsonShapeError);
    expect(() => flattenJsonToTable({ a: 1 })).toThrow(JsonShapeError);
    expect(() => flattenJsonToTable([1, 2])).toThrow(JsonShapeError);
  });
});
