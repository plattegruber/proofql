import { describe, expect, it } from "vitest";

import { ApiError } from "../errors.js";
import {
  DEFAULT_LIMIT,
  parseQueryRequest,
  queryParamsToRequest,
} from "./request.js";

function fromGet(qs: string) {
  return parseQueryRequest(queryParamsToRequest(new URLSearchParams(qs)));
}

function issuesOf(fn: () => unknown): {
  status: number;
  code: string;
  paths: string[];
} {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) {
      return {
        status: e.status,
        code: e.code,
        paths: (e.issues ?? []).map((i) => i.path),
      };
    }
    throw e;
  }
  throw new Error("expected an ApiError");
}

describe("POST body shape", () => {
  it("applies defaults to an empty body", () => {
    expect(parseQueryRequest({})).toEqual({
      limit: DEFAULT_LIMIT,
      mode: "excerpts",
      filters: {},
    });
  });

  it("accepts the full documented shape", () => {
    const parsed = parseQueryRequest({
      q: "  dental implants ",
      limit: 3,
      mode: "reviews",
      filters: {
        min_rating: 5,
        source: ["google", "yelp"],
        since: "2025-01-01",
        metadata: { location: "north" },
      },
    });
    expect(parsed).toEqual({
      q: "dental implants",
      limit: 3,
      mode: "reviews",
      filters: {
        min_rating: 5,
        source: ["google", "yelp"],
        since: new Date("2025-01-01T00:00:00Z"),
        metadata: { location: "north" },
      },
    });
  });

  it("folds the scope doc's flat `metadata.<key>` filter spelling into `metadata`", () => {
    const parsed = parseQueryRequest({
      filters: { "metadata.location": "north", metadata: { tier: "gold" } },
    });
    expect(parsed.filters.metadata).toEqual({
      location: "north",
      tier: "gold",
    });
  });

  it("accepts a single source string and a full ISO timestamp", () => {
    const parsed = parseQueryRequest({
      filters: { source: "google", since: "2025-06-01T12:30:00+02:00" },
    });
    expect(parsed.filters.source).toEqual(["google"]);
    expect(parsed.filters.since?.toISOString()).toBe(
      "2025-06-01T10:30:00.000Z",
    );
  });

  it("422s unknown fields at the top level and inside filters, naming them", () => {
    expect(issuesOf(() => parseQueryRequest({ limt: 3 }))).toEqual({
      status: 422,
      code: "validation_failed",
      paths: ["limt"],
    });
    expect(
      issuesOf(() => parseQueryRequest({ filters: { rating: 4 } })).paths,
    ).toEqual(["filters.rating"]);
  });

  it("422s a blank or over-long q, a limit out of 1..20, and a bad mode", () => {
    expect(issuesOf(() => parseQueryRequest({ q: "   " })).paths).toEqual([
      "q",
    ]);
    expect(
      issuesOf(() => parseQueryRequest({ q: "x".repeat(501) })).paths,
    ).toEqual(["q"]);
    expect(issuesOf(() => parseQueryRequest({ limit: 0 })).paths).toEqual([
      "limit",
    ]);
    expect(issuesOf(() => parseQueryRequest({ limit: 21 })).paths).toEqual([
      "limit",
    ]);
    expect(issuesOf(() => parseQueryRequest({ limit: 2.5 })).paths).toEqual([
      "limit",
    ]);
    expect(issuesOf(() => parseQueryRequest({ limit: "5" })).paths).toEqual([
      "limit",
    ]);
    expect(
      issuesOf(() => parseQueryRequest({ mode: "summary" })).paths,
    ).toEqual(["mode"]);
  });

  it("422s bad filters: rating range, date format, nested metadata, too many sources", () => {
    expect(
      issuesOf(() => parseQueryRequest({ filters: { min_rating: 6 } })).paths,
    ).toEqual(["filters.min_rating"]);
    expect(
      issuesOf(() => parseQueryRequest({ filters: { since: "yesterday" } }))
        .paths,
    ).toEqual(["filters.since"]);
    expect(
      issuesOf(() => parseQueryRequest({ filters: { since: "2025-13-45" } }))
        .paths,
    ).toEqual(["filters.since"]);
    expect(
      issuesOf(() =>
        parseQueryRequest({ filters: { metadata: { a: { b: "c" } } } }),
      ).paths,
    ).toEqual(["filters.metadata.a"]);
    expect(
      issuesOf(() =>
        parseQueryRequest({
          filters: { source: Array.from({ length: 21 }, () => "g") },
        }),
      ).paths,
    ).toEqual(["filters.source"]);
  });

  it("reports every issue, and the message names the first", () => {
    try {
      parseQueryRequest({ q: "", limit: 99, bogus: 1 });
    } catch (e) {
      const err = e as ApiError;
      expect(err.issues?.map((i) => i.path).sort()).toEqual([
        "bogus",
        "limit",
        "q",
      ]);
      expect(err.message).toMatch(/Invalid request: .* \(and 2 more\)\./);
    }
  });
});

describe("GET query-param mapping", () => {
  it("maps every documented parameter onto the body shape", () => {
    expect(
      fromGet(
        "q=dental+implants&limit=3&mode=reviews&min_rating=5&source=google&source=yelp&since=2025-01-01&metadata.location=north&key=pq_pk_live_x",
      ),
    ).toEqual({
      q: "dental implants",
      limit: 3,
      mode: "reviews",
      filters: {
        min_rating: 5,
        source: ["google", "yelp"],
        since: new Date("2025-01-01T00:00:00Z"),
        metadata: { location: "north" },
      },
    });
  });

  it("accepts comma-separated sources, mixed with repeats", () => {
    expect(
      fromGet("source=google,yelp&source=facebook").filters.source,
    ).toEqual(["google", "yelp", "facebook"]);
  });

  it("applies defaults with no parameters at all", () => {
    expect(fromGet("")).toEqual({
      limit: DEFAULT_LIMIT,
      mode: "excerpts",
      filters: {},
    });
  });

  it("ignores `key` (authentication) but 422s any other unknown parameter", () => {
    expect(fromGet("key=pq_pk_live_x")).toEqual({
      limit: DEFAULT_LIMIT,
      mode: "excerpts",
      filters: {},
    });
    expect(issuesOf(() => fromGet("limt=3")).paths).toEqual(["limt"]);
    expect(issuesOf(() => fromGet("_=1696000000")).paths).toEqual(["_"]);
  });

  it("422s non-integer numeric parameters with the schema's own path", () => {
    expect(issuesOf(() => fromGet("limit=abc")).paths).toEqual(["limit"]);
    expect(issuesOf(() => fromGet("limit=2.5")).paths).toEqual(["limit"]);
    expect(issuesOf(() => fromGet("min_rating=five")).paths).toEqual([
      "filters.min_rating",
    ]);
    expect(issuesOf(() => fromGet("limit=0")).paths).toEqual(["limit"]);
  });

  it("422s a scalar parameter given twice", () => {
    expect(issuesOf(() => fromGet("q=a&q=b"))).toEqual({
      status: 422,
      code: "validation_failed",
      paths: ["q"],
    });
  });
});
