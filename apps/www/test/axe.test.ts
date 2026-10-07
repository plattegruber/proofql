/**
 * axe-core over the built pages (dist/, written by `astro build`, which the
 * `test` script runs first). Zero violations, with the JavaScript-enabled
 * state (the `js` class) and the scripts' initial tab state as shipped.
 * Colour contrast is checked numerically in contrast.test.ts: jsdom has no
 * layout, so axe can only report that rule as incomplete.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

function load(page: string): void {
  // Not `new URL(…, import.meta.url)`: jsdom replaces the global URL.
  const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
  const html = readFileSync(join(dist, page), "utf8");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.replaceChild(
    document.importNode(parsed.documentElement, true),
    document.documentElement,
  );
  document.documentElement.classList.add("js");
}

async function violations(): Promise<string[]> {
  const result = await axe.run(document, {
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
}

describe("axe", () => {
  it("the landing page has no violations", async () => {
    load("index.html");
    expect(await violations()).toEqual([]);
  });

  it("the 404 page has no violations", async () => {
    load("404.html");
    expect(await violations()).toEqual([]);
  });
});

describe("landing page structure", () => {
  it("has one h1, a skip link to main, and a labelled demo", () => {
    load("index.html");
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    const skip = document.querySelector<HTMLAnchorElement>("a.skip-link");
    expect(skip?.getAttribute("href")).toBe("#main");
    expect(document.getElementById("main")?.tagName).toBe("MAIN");
    expect(document.documentElement.lang).toBe("en");
    // The creature is decorative; the home link keeps its name.
    for (const creature of document.querySelectorAll(".creature")) {
      expect(creature.getAttribute("aria-hidden")).toBe("true");
    }
    expect(
      document.querySelector('[data-creature="alive"]')?.closest(".hero"),
    ).not.toBeNull();
    expect(document.querySelector("a.home")?.getAttribute("aria-label")).toBe(
      "ProofQL home",
    );
    // Every demo panel says its reviews are examples.
    const panels = document.querySelectorAll('[role="tabpanel"]');
    expect(panels).toHaveLength(3);
    for (const panel of panels) {
      expect(panel.querySelector(".pq-heading")?.textContent).toBe(
        "Example reviews",
      );
    }
    // Only the first panel shows until a tab is chosen.
    expect(Array.from(panels).map((p) => (p as HTMLElement).hidden)).toEqual([
      false,
      true,
      true,
    ]);
  });
});
