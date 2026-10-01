import { describe, expect, it } from "vitest";

import { fixture, fixtureBytes } from "../../test/csv-fixtures.js";
import {
  CsvParser,
  detectDelimiter,
  parseCsv,
  parseCsvStream,
} from "./parse.js";

describe("parseCsv", () => {
  it("handles BOM, CRLF, quoted newlines, escaped quotes, blank lines and a missing final newline", () => {
    const { headers, rows } = parseCsv(fixture("tricky.csv"));
    expect(headers).toEqual([
      "review_id",
      "reviewer",
      "stars",
      "posted",
      "comment",
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual([
      "a-1",
      "Kim, Jo",
      "★★★★☆",
      "2026-01-05",
      'Said "wow" twice.\r\nSecond line of the same review.',
    ]);
    expect(rows[1]).toEqual(["a-2", "", "5 stars", "05.02.2026", "Plain row"]);
    expect(rows[2]).toEqual([
      "a-3",
      "Lee",
      "4/5",
      "1736035200000",
      "Trailing row without newline",
    ]);
  });

  it("auto-detects semicolon and tab delimiters, and prefers comma on a tie", () => {
    expect(detectDelimiter("a;b;c")).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter('a,"b;c;d",e')).toBe(",");
    expect(detectDelimiter("single")).toBe(",");
    const { headers, rows } = parseCsv("x;y\n1;2\n");
    expect(headers).toEqual(["x", "y"]);
    expect(rows).toEqual([["1", "2"]]);
  });

  it("keeps empty trailing fields and bare CR line endings", () => {
    const { rows } = parseCsv("a,b,c\r1,,\r2,x,\r");
    expect(rows).toEqual([
      ["1", "", ""],
      ["2", "x", ""],
    ]);
  });

  it("is lenient with a stray quote inside an unquoted field", () => {
    const { rows } = parseCsv('h\n5" tall\n');
    expect(rows).toEqual([['5" tall']]);
  });

  it("produces identical records regardless of chunk boundaries", () => {
    const text = fixture("generic-50.csv");
    const whole = parseCsv(text);
    for (const size of [1, 7, 64, 1000]) {
      const parser = new CsvParser();
      const records: string[][] = [];
      for (let i = 0; i < text.length; i += size) {
        records.push(...parser.write(text.slice(i, i + size)));
      }
      records.push(...parser.end());
      expect(records[0]).toEqual(whole.headers);
      expect(records.slice(1)).toEqual(whole.rows);
    }
  });
});

describe("parseCsvStream", () => {
  it("yields the header then numbered rows from a byte stream split mid-character", async () => {
    const bytes = fixtureBytes("tricky.csv");
    // Split inside the multi-byte "★" glyphs so the decoder has to carry state.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 5)
          controller.enqueue(bytes.slice(i, i + 5));
        controller.close();
      },
    });
    const events = [];
    for await (const event of parseCsvStream(stream)) events.push(event);
    expect(events[0]).toEqual({
      kind: "header",
      headers: ["review_id", "reviewer", "stars", "posted", "comment"],
    });
    expect(
      events.slice(1).map((e) => (e.kind === "row" ? e.rowNumber : -1)),
    ).toEqual([1, 2, 3]);
    const first = events[1];
    expect(first?.kind === "row" && first.row[2]).toBe("★★★★☆");
  });
});
