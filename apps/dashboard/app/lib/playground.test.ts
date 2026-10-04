// Pure side of the playground: form parsing with the api's bounds, and the
// curl / snippet a developer copies out.
import { describe, expect, it } from "vitest";

import {
  curlFor,
  parsePlaygroundParams,
  parseSince,
  queryBody,
  snippetFor,
} from "./playground";

describe("parsePlaygroundParams", () => {
  it("defaults to no query, excerpts, limit 5, live", () => {
    const { request, fieldErrors } = parsePlaygroundParams(
      new URLSearchParams(),
    );
    expect(fieldErrors).toEqual({});
    expect(request).toEqual({
      environment: "live",
      q: undefined,
      mode: "excerpts",
      limit: 5,
      fallback: "none",
      minRating: undefined,
      source: undefined,
      since: undefined,
      sinceRaw: undefined,
      metadata: {},
    });
  });

  it("reads every field, trims, and folds metadata pairs", () => {
    const { request, fieldErrors } = parsePlaygroundParams(
      new URLSearchParams(
        "env=test&q=+parking+&mode=reviews&limit=20&fallback=recent&min_rating=5&source=google&since=2025-01-01&mk=location&mv=north&mk=&mv=&mk=tier&mv=vip",
      ),
    );
    expect(fieldErrors).toEqual({});
    expect(request).toMatchObject({
      environment: "test",
      q: "parking",
      mode: "reviews",
      limit: 20,
      fallback: "recent",
      minRating: 5,
      source: "google",
      sinceRaw: "2025-01-01",
      metadata: { location: "north", tier: "vip" },
    });
    expect(request.since?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });

  it("reports one error per bad field and falls back to the default", () => {
    const { request, fieldErrors } = parsePlaygroundParams(
      new URLSearchParams(
        `q=${"x".repeat(501)}&mode=both&limit=0&fallback=always&min_rating=6&since=soon&mk=&mv=orphan`,
      ),
    );
    expect(Object.keys(fieldErrors).sort()).toEqual([
      "fallback",
      "limit",
      "metadata",
      "min_rating",
      "mode",
      "q",
      "since",
    ]);
    expect(request.mode).toBe("excerpts");
    expect(request.limit).toBe(5);
    expect(request.minRating).toBeUndefined();
    expect(request.since).toBeUndefined();
  });

  it("accepts an ISO timestamp as well as a date", () => {
    expect(parseSince("2025-01-01T12:00:00Z")?.toISOString()).toBe(
      "2025-01-01T12:00:00.000Z",
    );
    expect(parseSince("2025-13-01")).toBeNull();
    expect(parseSince("Jan 1")).toBeNull();
  });
});

describe("fallback (#86)", () => {
  it("rides in the body and the snippet only when recent", () => {
    const { request } = parsePlaygroundParams(
      new URLSearchParams("q=roofing&fallback=recent"),
    );
    expect(queryBody(request)).toEqual({
      q: "roofing",
      limit: 5,
      mode: "excerpts",
      fallback: "recent",
    });
    expect(snippetFor(request)).toContain('data-fallback="recent"');
    const { request: none } = parsePlaygroundParams(
      new URLSearchParams("q=roofing"),
    );
    expect(queryBody(none)).not.toHaveProperty("fallback");
    expect(snippetFor(none)).not.toContain("data-fallback");
  });
});

describe("queryBody / curlFor", () => {
  it("builds the /v1/query body the api accepts, filters only when set", () => {
    const { request } = parsePlaygroundParams(new URLSearchParams("q=parking"));
    expect(queryBody(request)).toEqual({
      q: "parking",
      limit: 5,
      mode: "excerpts",
    });
    const { request: filtered } = parsePlaygroundParams(
      new URLSearchParams(
        "q=parking&min_rating=5&source=yelp&since=2025-01-01&mk=location&mv=north",
      ),
    );
    expect(queryBody(filtered)).toEqual({
      q: "parking",
      limit: 5,
      mode: "excerpts",
      filters: {
        min_rating: 5,
        source: ["yelp"],
        since: "2025-01-01",
        metadata: { location: "north" },
      },
    });
  });

  it("writes a secret-key curl with a placeholder for the environment", () => {
    const { request } = parsePlaygroundParams(
      new URLSearchParams("env=test&q=it's+parking"),
    );
    const curl = curlFor(request, "http://localhost:8797/");
    expect(curl).toContain("curl -s -X POST 'http://localhost:8797/v1/query'");
    expect(curl).toContain("'Authorization: Bearer pq_sk_test_…'");
    expect(curl).toContain(
      `-d '{"q":"it'\\''s parking","limit":5,"mode":"excerpts"}'`,
    );
    expect(curl).not.toMatch(/pq_sk_test_[A-Za-z0-9]{10}/);
  });
});

describe("snippetFor", () => {
  it("is the one-tag embed from scope §3 with data-query filled", () => {
    const { request } = parsePlaygroundParams(
      new URLSearchParams('q=dental+"implants"&limit=3'),
    );
    expect(snippetFor(request)).toBe(
      [
        '<div data-proofql data-query="dental &quot;implants&quot;" data-limit="3"></div>',
        '<script async src="https://cdn.proofql.com/v1.js" data-key="pq_pk_live_…"></script>',
      ].join("\n"),
    );
  });

  it("carries the filters as data attributes and uses the test key placeholder", () => {
    const { request } = parsePlaygroundParams(
      new URLSearchParams(
        "env=test&mode=reviews&min_rating=5&source=google&since=2025-01-01&mk=location&mv=north",
      ),
    );
    const snippet = snippetFor(request);
    expect(snippet).toContain('data-mode="reviews"');
    expect(snippet).toContain('data-min-rating="5"');
    expect(snippet).toContain('data-source="google"');
    expect(snippet).toContain('data-since="2025-01-01"');
    expect(snippet).toContain('data-meta-location="north"');
    expect(snippet).not.toContain("data-api");
    expect(snippet).toContain('data-key="pq_pk_test_…"');
    expect(snippet).not.toContain("data-query");
  });

  it("points the script at a non-default api origin with data-api (local dev)", () => {
    const { request } = parsePlaygroundParams(new URLSearchParams("q=parking"));
    expect(snippetFor(request, "http://localhost:8797/")).toContain(
      '<script async src="https://cdn.proofql.com/v1.js" data-key="pq_pk_live_…" data-api="http://localhost:8797"></script>',
    );
    expect(snippetFor(request, "https://api.proofql.com")).not.toContain(
      "data-api",
    );
  });
});
