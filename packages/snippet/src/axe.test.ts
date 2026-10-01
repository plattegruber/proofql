/**
 * axe-core over the rendered fixture (#33 DoD "axe clean"): the default
 * structure with and without the badge, and the template path. Zero
 * violations. Colour contrast is covered numerically in styles.test.ts —
 * jsdom has no layout, so axe reports that rule as incomplete, not as a
 * result either way.
 */
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import { renderInto } from "./render.js";
import { ensureStyles } from "./styles.js";
import { renderTemplate } from "./template.js";
import { fixtureResponse } from "./test/fixture.js";

function page(): HTMLElement {
  document.body.innerHTML = `
    <main>
      <h1>Host page</h1>
      <div id="host" data-proofql></div>
    </main>`;
  ensureStyles(document);
  return document.getElementById("host") as HTMLElement;
}

async function violations(): Promise<string[]> {
  const result = await axe.run(document.body, {
    // Rules that need a real layout engine or a whole document are not
    // about the snippet; everything else runs.
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
}

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("axe", () => {
  it("default render with the badge has no violations", async () => {
    renderInto(page(), fixtureResponse({ badge: true }), "excerpts");
    expect(await violations()).toEqual([]);
  });

  it("default render without the badge has no violations", async () => {
    renderInto(page(), fixtureResponse({ badge: false }), "reviews");
    expect(await violations()).toEqual([]);
  });

  it("template render has no violations", async () => {
    const host = page();
    const template = document.createElement("template");
    template.innerHTML = `
      <figure>
        <span data-pq="stars"></span>
        <blockquote data-pq="excerpt"></blockquote>
        <figcaption>
          <b data-pq="author"></b>
          <a data-pq="url"><span data-pq="source"></span></a>
          <time data-pq="date"></time>
        </figcaption>
      </figure>`;
    document.body.append(template);
    renderTemplate(host, template, fixtureResponse(), "excerpts");
    expect(await violations()).toEqual([]);
  });
});
