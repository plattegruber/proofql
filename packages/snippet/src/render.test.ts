import { describe, expect, it } from "vitest";

import {
  BADGE_HREF,
  formatDate,
  renderInto,
  safeHref,
  sourceName,
  starCount,
} from "./render.js";
import { fixtureResponse } from "./test/fixture.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-proofql", "");
  document.body.append(el);
  return el;
}

describe("renderInto", () => {
  it("renders one list item per result with the documented structure", () => {
    const el = host();
    renderInto(el, fixtureResponse(), "excerpts");

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
    renderInto(el, fixtureResponse(), "excerpts");
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
    renderInto(el, fixtureResponse(), "excerpts");
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
    renderInto(el, fixtureResponse({ badge: true }), "excerpts");
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
    renderInto(el, fixtureResponse({ badge: false }), "excerpts");
    expect(el.querySelector(".pq-badge")).toBeNull();
    expect(el.children).toHaveLength(1);
  });

  it("replaces fallback content", () => {
    const el = host();
    el.textContent = "Loading reviews…";
    renderInto(el, fixtureResponse(), "excerpts");
    expect(el.textContent).not.toContain("Loading");
  });

  it("shows the whole review in reviews mode when the API sent it", () => {
    const el = host();
    renderInto(el, fixtureResponse(), "reviews");
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
