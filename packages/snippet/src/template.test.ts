import { afterEach, describe, expect, it, vi } from "vitest";

import type { SnippetConfig } from "./config.js";
import { renderElement } from "./snippet.js";
import { findTemplate, renderTemplate } from "./template.js";
import { fixtureResponse, stubFetch } from "./test/fixture.js";

const TEMPLATE = `
  <figure class="card">
    <span data-pq="stars"></span>
    <blockquote data-pq="excerpt">placeholder</blockquote>
    <figcaption>
      <b data-pq="author"></b>
      <a data-pq="url" target="_blank"><span data-pq="source"></span></a>
      <time data-pq="date"></time>
      <i data-pq="rating"></i>
      <u data-pq="unknown">kept</u>
    </figcaption>
  </figure>`;

function install(html = TEMPLATE, id = "tpl"): HTMLTemplateElement {
  const template = document.createElement("template");
  template.id = id;
  template.innerHTML = html;
  document.body.append(template);
  return template;
}

function host(attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-proofql", "");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("findTemplate", () => {
  it("resolves data-template to a <template>", () => {
    const template = install();
    expect(findTemplate(host({ "data-template": "#tpl" }))).toBe(template);
  });

  it("is null without the attribute, for a missing target, a non-template, or a bad selector", () => {
    install();
    const div = document.createElement("div");
    div.id = "not-a-template";
    document.body.append(div);
    expect(findTemplate(host())).toBeNull();
    expect(findTemplate(host({ "data-template": "#nope" }))).toBeNull();
    expect(
      findTemplate(host({ "data-template": "#not-a-template" })),
    ).toBeNull();
    expect(findTemplate(host({ "data-template": "#(" }))).toBeNull();
    expect(findTemplate(host({ "data-template": "  " }))).toBeNull();
  });
});

describe("renderTemplate", () => {
  it("clones the template per result and fills every slot as text", () => {
    const template = install();
    const el = host();
    renderTemplate(el, template, fixtureResponse(), "excerpts");

    const cards = el.querySelectorAll(":scope > .card");
    expect(cards).toHaveLength(3);
    expect(el.querySelector(".pq-list")).toBeNull();

    const first = cards[0] as HTMLElement;
    const stars = first.querySelector("[data-pq=stars]");
    expect(stars?.textContent).toBe("★★★★★");
    expect(stars?.getAttribute("role")).toBe("img");
    expect(stars?.getAttribute("aria-label")).toBe("5 out of 5 stars");
    expect(first.querySelector("[data-pq=excerpt]")?.textContent).toContain(
      "<script>alert(1)</script>",
    );
    expect(first.querySelector("script")).toBeNull();
    expect(first.querySelector("[data-pq=author]")?.textContent).toBe(
      "Maria <b>G.</b>",
    );
    const link = first.querySelector<HTMLAnchorElement>("[data-pq=url]");
    expect(link?.href).toBe("https://maps.google.com/?cid=123");
    expect(link?.rel).toBe("noopener");
    expect(link?.target).toBe("_blank");
    expect(link?.querySelector("[data-pq=source]")?.textContent).toBe("Google");
    const time = first.querySelector<HTMLTimeElement>("[data-pq=date]");
    expect(time?.dateTime).toBe("2026-01-15T10:30:00.000Z");
    expect(time?.textContent).toMatch(/2026/);
    expect(first.querySelector("[data-pq=rating]")?.textContent).toBe("5");
    expect(first.querySelector("[data-pq=unknown]")?.textContent).toBe("kept");
  });

  it("removes slots the review cannot fill and never emits unsafe hrefs", () => {
    const template = install();
    const el = host();
    renderTemplate(el, template, fixtureResponse(), "excerpts");
    const cards = el.querySelectorAll(":scope > .card");

    const second = cards[1] as HTMLElement; // custom, no author/date, javascript: url
    expect(second.querySelector("[data-pq=author]")).toBeNull();
    expect(second.querySelector("[data-pq=source]")).toBeNull();
    expect(second.querySelector("[data-pq=url]")).toBeNull();
    expect(second.querySelector("[data-pq=date]")).toBeNull();
    expect(second.querySelector("[data-pq=stars]")?.textContent).toBe("★★★★☆");
    expect(second.querySelector("[data-pq=rating]")?.textContent).toBe("4");

    const third = cards[2] as HTMLElement; // unrated, yelp, no url
    expect(third.querySelector("[data-pq=stars]")).toBeNull();
    expect(third.querySelector("[data-pq=rating]")).toBeNull();
    expect(third.querySelector("[data-pq=url]")).toBeNull();
  });

  it("puts the URL in text form on a non-link slot", () => {
    const template = install(`<p><span data-pq="url"></span></p>`);
    const el = host();
    renderTemplate(el, template, fixtureResponse(), "excerpts");
    expect(el.querySelector("[data-pq=url]")?.textContent).toBe(
      "https://maps.google.com/?cid=123",
    );
  });

  it("uses the whole review in reviews mode", () => {
    const template = install();
    const el = host();
    renderTemplate(el, template, fixtureResponse(), "reviews");
    expect(el.querySelector("[data-pq=excerpt]")?.textContent).toMatch(
      /^Full review text/,
    );
  });

  it("appends the badge unless the project is paid", () => {
    const template = install();
    const free = host();
    renderTemplate(
      free,
      template,
      fixtureResponse({ badge: true }),
      "excerpts",
    );
    expect(free.lastElementChild?.className).toBe("pq-badge");
    const paid = host();
    renderTemplate(
      paid,
      template,
      fixtureResponse({ badge: false }),
      "excerpts",
    );
    expect(paid.querySelector(".pq-badge")).toBeNull();
  });
});

describe("renderElement with data-template", () => {
  const config: SnippetConfig = {
    key: "pq_pk_test_abc",
    api: "https://api.proofql.com",
  };

  it("uses the template and still injects the stylesheet (for the badge)", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.stubGlobal("fetch", stubFetch({ body: fixtureResponse() }));
    install();
    const el = host({ "data-template": "#tpl" });
    await renderElement(el, config);
    expect(el.querySelectorAll(".card")).toHaveLength(3);
    expect(el.querySelector(".pq-item")).toBeNull();
    expect(
      document.head.querySelector("style[data-proofql-styles]"),
    ).not.toBeNull();
  });

  it("falls back to the default render when the template cannot be found", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.stubGlobal("fetch", stubFetch({ body: fixtureResponse() }));
    const el = host({ "data-template": "#missing" });
    await renderElement(el, config);
    expect(el.querySelectorAll(".pq-item")).toHaveLength(3);
  });

  it("does not touch <head> when nothing renders", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      stubFetch({ body: fixtureResponse({ results: [] }) }),
    );
    await renderElement(host(), config);
    expect(document.head.querySelector("style")).toBeNull();
  });
});
