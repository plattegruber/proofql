import { describe, expect, it } from "vitest";

import {
  BADGE_HREF,
  formatDate,
  renderInto,
  safeHref,
  sourceName,
  starCount,
  textNodes,
} from "./render.js";
import { fixtureResponse } from "./test/fixture.js";
import type { QueryResponse, QueryResult } from "./types.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-proofql", "");
  document.body.append(el);
  return el;
}

describe("renderInto", () => {
  it("renders one list item per result with the documented structure", () => {
    const el = host();
    renderInto(el, fixtureResponse(), { mode: "excerpts" });

    const list = el.querySelector(".pq-list");
    expect(list?.tagName).toBe("UL");
    expect(list?.getAttribute("role")).toBe("list");
    const items = el.querySelectorAll(".pq-list > .pq-item");
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.tagName).toBe("LI");
    }

    const first = items[0] as HTMLElement;
    const stars = first.querySelector(".pq-stars");
    expect(stars?.getAttribute("role")).toBe("img");
    expect(stars?.getAttribute("aria-label")).toBe("5 out of 5 stars");
    expect(stars?.querySelector(".pq-stars-on")?.textContent).toBe("★★★★★");
    expect(
      stars?.querySelector(".pq-stars-on")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(stars?.querySelector(".pq-stars-off")).toBeNull();

    expect(first.querySelector(".pq-excerpt")?.tagName).toBe("BLOCKQUOTE");
    expect(first.querySelector(".pq-meta .pq-author")?.textContent).toBe(
      "Maria <b>G.</b>",
    );
    const source = first.querySelector<HTMLAnchorElement>(
      ".pq-meta .pq-source",
    );
    expect(source?.textContent).toBe("Google");
    expect(source?.tagName).toBe("A");
    expect(source?.href).toBe("https://maps.google.com/?cid=123");
    expect(source?.rel).toBe("noopener");
    expect(source?.target).toBe("_blank");
    const time = first.querySelector<HTMLTimeElement>(".pq-meta .pq-date");
    expect(time?.tagName).toBe("TIME");
    expect(time?.dateTime).toBe("2026-01-15T10:30:00.000Z");
    expect(time?.textContent).toMatch(/2026/);
  });

  it("escapes everything from the API — no markup is ever parsed", () => {
    const el = host();
    renderInto(el, fixtureResponse(), { mode: "excerpts" });
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
    const excerpt = el.querySelector(".pq-excerpt");
    expect(excerpt?.textContent).toContain("<script>alert(1)</script> &");
    expect(excerpt?.childNodes).toHaveLength(1);
    expect(excerpt?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(el.innerHTML).toContain("&lt;script&gt;");
  });

  it("omits what a result does not have, and never links to non-http URLs", () => {
    const el = host();
    renderInto(el, fixtureResponse(), { mode: "excerpts" });
    const items = el.querySelectorAll(".pq-item");

    const second = items[1] as HTMLElement; // custom source, no author, no date, javascript: url
    expect(second.querySelector(".pq-stars")?.getAttribute("aria-label")).toBe(
      "4 out of 5 stars",
    );
    expect(second.querySelector(".pq-stars-on")?.textContent).toBe("★★★★");
    expect(second.querySelector(".pq-stars-off")?.textContent).toBe("☆");
    expect(second.querySelector(".pq-author")).toBeNull();
    expect(second.querySelector(".pq-source")).toBeNull();
    expect(second.querySelector(".pq-date")).toBeNull();
    expect(second.querySelector(".pq-meta")).toBeNull();
    expect(second.querySelector("a")).toBeNull();

    const third = items[2] as HTMLElement; // unrated, yelp without url
    expect(third.querySelector(".pq-stars")).toBeNull();
    const source = third.querySelector(".pq-source");
    expect(source?.tagName).toBe("SPAN");
    expect(source?.textContent).toBe("Yelp");
  });

  it("appends the badge when badge is true, after the list", () => {
    const el = host();
    renderInto(el, fixtureResponse({ badge: true }), { mode: "excerpts" });
    const badge = el.querySelector<HTMLAnchorElement>(":scope > .pq-badge");
    expect(badge?.textContent).toBe("Reviews by ProofQL");
    expect(badge?.href).toBe(BADGE_HREF);
    expect(badge?.rel).toBe("noopener");
    expect(badge?.target).toBe("_blank");
    expect(badge?.previousElementSibling?.className).toBe("pq-list");
    // A role=list may only own list items: the badge is outside it.
    expect(el.querySelector(".pq-list .pq-badge")).toBeNull();
  });

  it("renders no badge when badge is false", () => {
    const el = host();
    renderInto(el, fixtureResponse({ badge: false }), { mode: "excerpts" });
    expect(el.querySelector(".pq-badge")).toBeNull();
    expect(el.children).toHaveLength(1);
  });

  it("replaces fallback content", () => {
    const el = host();
    el.textContent = "Loading reviews…";
    renderInto(el, fixtureResponse(), { mode: "excerpts" });
    expect(el.textContent).not.toContain("Loading");
  });

  it("shows the whole review in reviews mode when the API sent it", () => {
    const el = host();
    renderInto(el, fixtureResponse(), { mode: "reviews" });
    const excerpts = el.querySelectorAll(".pq-excerpt");
    expect(excerpts[0]?.textContent).toMatch(/^Full review text for r1\./);
    // No `text` on the second result: falls back to the excerpt.
    expect(excerpts[1]?.textContent).toBe(
      "Quick, painless, and the front desk was lovely.",
    );
  });
});

describe("helpers", () => {
  it("maps sources to display names; custom renders none", () => {
    expect(sourceName("google")).toBe("Google");
    expect(sourceName("Yelp")).toBe("Yelp");
    expect(sourceName("facebook")).toBe("Facebook");
    expect(sourceName("trustpilot")).toBe("Trustpilot");
    expect(sourceName("custom")).toBeNull();
    expect(sourceName("")).toBeNull();
    expect(sourceName("healthgrades")).toBe("Healthgrades");
  });

  it("accepts only http(s) hrefs", () => {
    expect(safeHref("https://a.example/x")).toBe("https://a.example/x");
    expect(safeHref("http://a.example")).toBe("http://a.example/");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });

  it("rounds and clamps star counts", () => {
    expect(starCount(5)).toBe(5);
    expect(starCount(4.4)).toBe(4);
    expect(starCount(7)).toBe(5);
    expect(starCount(-1)).toBe(0);
    expect(starCount(null)).toBeNull();
    expect(starCount(Number.NaN)).toBeNull();
  });

  it("formats valid dates and rejects the rest", () => {
    expect(formatDate("2026-01-15T10:30:00.000Z")?.iso).toBe(
      "2026-01-15T10:30:00.000Z",
    );
    expect(formatDate("2026-01-15T10:30:00.000Z")?.text).toMatch(/2026/);
    expect(formatDate("nope")).toBeNull();
    expect(formatDate(null)).toBeNull();
  });
});

describe("data-highlight (#85)", () => {
  const r1 = () => fixtureResponse().results[0] as QueryResult;

  it('splits the whole review into text, <mark class="pq-mark">, text — three nodes, no innerHTML', () => {
    const el = host();
    renderInto(el, fixtureResponse(), { mode: "excerpts", highlight: true });
    const quote = el.querySelector(".pq-excerpt") as HTMLElement;
    const text = r1().review.text as string;
    expect(quote.childNodes).toHaveLength(3);
    const [before, mark, after] = Array.from(quote.childNodes);
    expect(before?.nodeType).toBe(Node.TEXT_NODE);
    expect(before?.textContent).toBe(text.slice(0, 25));
    expect((mark as HTMLElement).tagName).toBe("MARK");
    expect((mark as HTMLElement).className).toBe("pq-mark");
    expect(mark?.textContent).toBe(r1().excerpt);
    expect(after?.nodeType).toBe(Node.TEXT_NODE);
    expect(after?.textContent).toBe(text.slice(116));
    expect(quote.textContent).toBe(text);
    // Hostile markup inside the span stays text.
    expect(quote.querySelector("script")).toBeNull();
    expect(mark?.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders the plain text in one node when highlight is null, and the excerpt when there is no text", () => {
    const el = host();
    renderInto(el, fixtureResponse(), { mode: "excerpts", highlight: true });
    const quotes = el.querySelectorAll(".pq-excerpt");
    // r2: no text in the response (older build / include missing) → excerpt.
    expect(quotes[1]?.childNodes).toHaveLength(1);
    expect(quotes[1]?.textContent).toBe(
      "Quick, painless, and the front desk was lovely.",
    );
    expect(el.querySelectorAll(".pq-mark")).toHaveLength(1);

    const response = fixtureResponse();
    const first = response.results[0] as QueryResult;
    first.highlight = null;
    const el2 = host();
    renderInto(el2, response, { mode: "excerpts", highlight: true });
    const quote = el2.querySelector(".pq-excerpt") as HTMLElement;
    expect(quote.childNodes).toHaveLength(1);
    expect(quote.textContent).toBe(first.review.text);
    expect(el2.querySelector(".pq-mark")).toBeNull();
  });

  it("is off by default: today's output, excerpt only, no <mark>", () => {
    const el = host();
    renderInto(el, fixtureResponse(), { mode: "excerpts" });
    expect(el.querySelector(".pq-mark")).toBeNull();
    expect(el.querySelector(".pq-excerpt")?.childNodes).toHaveLength(1);
    expect(el.querySelector(".pq-excerpt")?.textContent).toBe(r1().excerpt);
  });

  it("refuses a span that does not slice to the excerpt, or is out of range", () => {
    const doc = document;
    for (const highlight of [
      { start: 0, end: 10 }, // wrong text
      { start: 25, end: 25 }, // empty
      { start: -1, end: 116 },
      { start: 25, end: 10_000 },
    ]) {
      const nodes = textNodes(
        doc,
        { ...r1(), highlight },
        { mode: "excerpts", highlight: true },
      );
      expect(nodes, JSON.stringify(highlight)).toHaveLength(1);
      expect(nodes[0]?.textContent).toBe(r1().review.text);
    }
  });

  it("works in reviews mode too, where the text is always present", () => {
    const el = host();
    renderInto(el, fixtureResponse(), { mode: "reviews", highlight: true });
    expect(el.querySelector(".pq-mark")?.textContent).toBe(r1().excerpt);
  });
});

describe("honest fallback (#86): match on the host, heading swap", () => {
  it("marks the host with data-pq-match and pq-fallback only on a fallback", () => {
    const el = host();
    renderInto(el, fixtureResponse({ match: "query" }), { mode: "excerpts" });
    expect(el.getAttribute("data-pq-match")).toBe("query");
    expect(el.classList.contains("pq-fallback")).toBe(false);

    renderInto(el, fixtureResponse({ match: "fallback" }), {
      mode: "excerpts",
    });
    expect(el.getAttribute("data-pq-match")).toBe("fallback");
    expect(el.classList.contains("pq-fallback")).toBe(true);

    // A later real answer clears the class again.
    renderInto(el, fixtureResponse({ match: "recent" }), { mode: "excerpts" });
    expect(el.getAttribute("data-pq-match")).toBe("recent");
    expect(el.classList.contains("pq-fallback")).toBe(false);

    // An older build without `match` is a query answer.
    const { match: _m, ...legacy } = fixtureResponse();
    renderInto(el, legacy as QueryResponse, { mode: "excerpts" });
    expect(el.getAttribute("data-pq-match")).toBe("query");
  });

  it("renders the heading above the list, swapping to the fallback heading on a fallback", () => {
    const options = {
      mode: "excerpts" as const,
      heading: "What patients say about insurance",
      fallbackHeading: "What patients say about working with us",
    };
    const el = host();
    renderInto(el, fixtureResponse({ match: "query" }), options);
    expect(el.firstElementChild?.className).toBe("pq-heading");
    expect(el.firstElementChild?.tagName).toBe("P");
    expect(el.firstElementChild?.textContent).toBe(
      "What patients say about insurance",
    );
    expect(el.firstElementChild?.nextElementSibling?.className).toBe("pq-list");

    renderInto(el, fixtureResponse({ match: "fallback" }), options);
    expect(el.querySelector(".pq-heading")?.textContent).toBe(
      "What patients say about working with us",
    );

    // Only one heading given: it is used in both cases.
    renderInto(el, fixtureResponse({ match: "fallback" }), {
      mode: "excerpts",
      heading: "Reviews",
    });
    expect(el.querySelector(".pq-heading")?.textContent).toBe("Reviews");
    renderInto(el, fixtureResponse({ match: "query" }), {
      mode: "excerpts",
      fallbackHeading: "Only on fallback",
    });
    expect(el.querySelector(".pq-heading")).toBeNull();

    // Nothing given: nothing rendered.
    renderInto(el, fixtureResponse(), { mode: "excerpts" });
    expect(el.querySelector(".pq-heading")).toBeNull();
    expect(el.firstElementChild?.className).toBe("pq-list");
  });
});
