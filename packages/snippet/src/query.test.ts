import { describe, expect, it } from "vitest";

import { buildQueryUrl, readElementQuery } from "./query.js";

function el(attrs: Record<string, string>): Element {
  const div = document.createElement("div");
  div.setAttribute("data-proofql", "");
  for (const [k, v] of Object.entries(attrs)) div.setAttribute(k, v);
  return div;
}

const API = "https://api.proofql.com";
const KEY = "pq_pk_test_abc";

function params(attrs: Record<string, string>): URLSearchParams {
  const url = new URL(buildQueryUrl(API, KEY, readElementQuery(el(attrs))));
  expect(url.origin + url.pathname).toBe(`${API}/v1/query`);
  return url.searchParams;
}

describe("element attributes → query string", () => {
  it("sends only key and the default limit for a bare element", () => {
    const p = params({});
    expect([...p.keys()]).toEqual(["key", "limit"]);
    expect(p.get("key")).toBe(KEY);
    expect(p.get("limit")).toBe("3");
  });

  it("maps every supported attribute and nothing else", () => {
    const p = params({
      "data-query": "dental implants",
      "data-limit": "5",
      "data-mode": "reviews",
      "data-min-rating": "4",
      "data-source": "google, yelp",
      "data-since": "2025-01-01",
      "data-meta-location": "north",
      "data-meta-team": "hygiene",
      // Not part of the contract; must never reach the API (422 there).
      "data-foo": "bar",
      class: "reviews",
      id: "x",
    });
    expect(Object.fromEntries(p)).toEqual({
      key: KEY,
      q: "dental implants",
      limit: "5",
      mode: "reviews",
      min_rating: "4",
      source: "google, yelp",
      since: "2025-01-01",
      "metadata.location": "north",
      "metadata.team": "hygiene",
    });
  });

  it('data-highlight="true" asks for the text in excerpts mode only', () => {
    expect(
      Object.fromEntries(
        params({ "data-query": "x", "data-highlight": "true" }),
      ),
    ).toEqual({ key: KEY, q: "x", limit: "3", include: "text" });
    // reviews mode already carries review.text.
    expect(
      params({ "data-highlight": "true", "data-mode": "reviews" }).has(
        "include",
      ),
    ).toBe(false);
    for (const value of ["", "yes", "false", "TRUE"]) {
      expect(params({ "data-highlight": value }).has("include"), value).toBe(
        false,
      );
    }
    expect(readElementQuery(el({ "data-highlight": "true" })).highlight).toBe(
      true,
    );
    expect(readElementQuery(el({})).highlight).toBe(false);
  });

  it('data-fallback="recent" passes fallback=recent; other values are dropped', () => {
    expect(
      params({ "data-query": "x", "data-fallback": "recent" }).get("fallback"),
    ).toBe("recent");
    for (const value of ["", "none", "yes", "RECENT"]) {
      expect(params({ "data-fallback": value }).has("fallback"), value).toBe(
        false,
      );
    }
  });

  it("encodes the query text", () => {
    const url = buildQueryUrl(
      API,
      KEY,
      readElementQuery(el({ "data-query": "root canal & crowns?" })),
    );
    expect(url).toContain("q=root+canal+%26+crowns%3F");
  });

  it("clamps the limit to 1–20 and ignores garbage", () => {
    expect(params({ "data-limit": "0" }).get("limit")).toBe("1");
    expect(params({ "data-limit": "99" }).get("limit")).toBe("20");
    expect(params({ "data-limit": "abc" }).get("limit")).toBe("3");
    expect(params({ "data-limit": "2.5" }).get("limit")).toBe("3");
  });

  it("drops an unknown mode and an out-of-range min rating", () => {
    const p = params({ "data-mode": "whatever", "data-min-rating": "7" });
    expect(p.has("mode")).toBe(false);
    expect(p.has("min_rating")).toBe(false);
    expect(params({ "data-min-rating": "x" }).has("min_rating")).toBe(false);
  });

  it("omits blank attributes", () => {
    const p = params({ "data-query": "  ", "data-source": "" });
    expect(p.has("q")).toBe(false);
    expect(p.has("source")).toBe(false);
  });

  it("keeps a fixed parameter order so identical elements share a cache key", () => {
    const a = buildQueryUrl(
      API,
      KEY,
      readElementQuery(
        el({ "data-meta-b": "2", "data-meta-a": "1", "data-query": "x" }),
      ),
    );
    const b = buildQueryUrl(
      API,
      KEY,
      readElementQuery(
        el({ "data-query": "x", "data-meta-a": "1", "data-meta-b": "2" }),
      ),
    );
    expect(a).toBe(b);
    expect(a).toBe(
      `${API}/v1/query?key=${KEY}&q=x&limit=3&metadata.a=1&metadata.b=2`,
    );
  });

  it("uses the configured API origin", () => {
    const url = buildQueryUrl(
      "http://localhost:8797",
      KEY,
      readElementQuery(el({})),
    );
    expect(url.startsWith("http://localhost:8797/v1/query?")).toBe(true);
  });
});
