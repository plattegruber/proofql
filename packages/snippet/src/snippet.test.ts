import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SnippetConfig } from "./config.js";
import {
  findTargets,
  isQueryResponse,
  RENDERED_ATTR,
  renderElement,
} from "./snippet.js";
import { fixtureResponse, stubFetch } from "./test/fixture.js";

const config: SnippetConfig = {
  key: "pq_pk_test_abc",
  api: "https://api.proofql.com",
};

function host(attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-proofql", "");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.innerHTML = "<p>fallback</p>";
  document.body.append(el);
  return el;
}

let debugSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("renderElement", () => {
  it("fetches the mapped URL and renders", async () => {
    const fetchStub = stubFetch({ body: fixtureResponse() });
    vi.stubGlobal("fetch", fetchStub);
    const el = host({ "data-query": "implants", "data-limit": "2" });

    await renderElement(el, config);

    expect(fetchStub.calls).toEqual([
      "https://api.proofql.com/v1/query?key=pq_pk_test_abc&q=implants&limit=2",
    ]);
    expect(el.querySelectorAll(".pq-item")).toHaveLength(3);
    expect(el.querySelector(".pq-badge")).not.toBeNull();
    expect(el.getAttribute(RENDERED_ATTR)).toBe("");
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("passes data-fallback through and swaps the heading on a fallback response (#86)", async () => {
    const fetchStub = stubFetch({
      body: fixtureResponse({ match: "fallback" }),
    });
    vi.stubGlobal("fetch", fetchStub);
    const el = host({
      "data-query": "roofing",
      "data-fallback": "recent",
      "data-heading": "What patients say about roofing",
      "data-fallback-heading": "What patients say about working with us",
    });

    await renderElement(el, config);

    expect(fetchStub.calls[0]).toContain("&fallback=recent");
    expect(el.getAttribute("data-pq-match")).toBe("fallback");
    expect(el.classList.contains("pq-fallback")).toBe(true);
    expect(el.querySelector(".pq-heading")?.textContent).toBe(
      "What patients say about working with us",
    );
    expect(el.querySelectorAll(".pq-item")).toHaveLength(3);
  });

  const untouched = async (name: string, el: HTMLElement) => {
    const before = el.outerHTML;
    await expect(renderElement(el, config)).resolves.toBeUndefined();
    expect(el.outerHTML, name).toBe(before);
    expect(el.hasAttribute(RENDERED_ATTR), name).toBe(false);
    expect(debugSpy, name).toHaveBeenCalledTimes(1);
    expect(errorSpy, name).not.toHaveBeenCalled();
    expect(warnSpy, name).not.toHaveBeenCalled();
  };

  it("renders nothing on empty results", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({ body: fixtureResponse({ results: [] }) }),
    );
    await untouched("empty", host());
    expect(debugSpy.mock.calls[0]?.[0]).toContain("no results");
  });

  it("renders nothing on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({ status: 403, body: { error: { code: "forbidden" } } }),
    );
    await untouched("403", host());
    expect(debugSpy.mock.calls[0]?.[0]).toContain("HTTP 403");
  });

  it("renders nothing on 429 — quota or rate limit — and never retries on its own", async () => {
    // The api's two 429s (`rate_limited`, `query_quota_exceeded`) are what a
    // free-tier site at its limit sees. The snippet must degrade to an empty
    // widget, log at debug, and not hammer the endpoint.
    const fetchStub = stubFetch({
      status: 429,
      body: { error: { code: "query_quota_exceeded" } },
    });
    vi.stubGlobal("fetch", fetchStub);
    await untouched("429", host());
    expect(debugSpy.mock.calls[0]?.[0]).toContain("HTTP 429");
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("renders nothing on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({ throws: new TypeError("Failed to fetch") }),
    );
    await untouched("network", host());
    expect(debugSpy.mock.calls[0]?.[0]).toContain("network error");
  });

  it("renders nothing on malformed JSON", async () => {
    vi.stubGlobal("fetch", stubFetch({ text: "{not json" }));
    await untouched("json", host());
    expect(debugSpy.mock.calls[0]?.[0]).toContain("malformed JSON");
  });

  it("renders nothing on an unexpected shape", async () => {
    vi.stubGlobal("fetch", stubFetch({ body: { results: [{ nope: true }] } }));
    await untouched("shape", host());
    expect(debugSpy.mock.calls[0]?.[0]).toContain("unexpected response shape");
  });

  it("never throws, even when fetch is missing entirely", async () => {
    vi.stubGlobal("fetch", undefined);
    await untouched("no fetch", host());
  });

  it("is idempotent: a rendered element is not fetched again", async () => {
    const fetchStub = stubFetch({ body: fixtureResponse() });
    vi.stubGlobal("fetch", fetchStub);
    const el = host();
    await renderElement(el, config);
    await renderElement(el, config);
    expect(fetchStub.calls).toHaveLength(1);
    expect(el.querySelectorAll(".pq-list")).toHaveLength(1);
  });

  it("does not double-fetch while a request is in flight", async () => {
    const fetchStub = stubFetch({ body: fixtureResponse() });
    vi.stubGlobal("fetch", fetchStub);
    const el = host();
    await Promise.all([renderElement(el, config), renderElement(el, config)]);
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("retries an element whose first attempt failed", async () => {
    vi.stubGlobal("fetch", stubFetch({ status: 500 }));
    const el = host();
    await renderElement(el, config);
    vi.stubGlobal("fetch", stubFetch({ body: fixtureResponse() }));
    await renderElement(el, config);
    expect(el.querySelectorAll(".pq-item")).toHaveLength(3);
  });
});

describe("findTargets", () => {
  it("finds descendants and the root itself", () => {
    const root = host();
    const child = document.createElement("span");
    child.setAttribute("data-proofql", "");
    root.append(child);
    const other = document.createElement("div");
    document.body.append(other);
    expect(findTargets(root)).toEqual([root, child]);
    expect(findTargets(other)).toEqual([]);
    expect(findTargets(document)).toEqual([root, child]);
  });
});

describe("isQueryResponse", () => {
  it("accepts the contract and rejects everything else", () => {
    expect(isQueryResponse(fixtureResponse())).toBe(true);
    expect(isQueryResponse({ results: [] })).toBe(true);
    expect(isQueryResponse(null)).toBe(false);
    expect(isQueryResponse([])).toBe(false);
    expect(isQueryResponse({ results: "x" })).toBe(false);
    expect(isQueryResponse({ results: [{ excerpt: 1, review: {} }] })).toBe(
      false,
    );
    expect(isQueryResponse({ results: [{ excerpt: "x", review: null }] })).toBe(
      false,
    );
  });
});
