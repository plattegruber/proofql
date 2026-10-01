import { afterEach, describe, expect, it } from "vitest";

import { ensureStyles, STYLE_ATTR, STYLESHEET } from "./styles.js";

afterEach(() => {
  document.head.innerHTML = "";
});

describe("ensureStyles", () => {
  it("injects the stylesheet once, into <head>", () => {
    ensureStyles(document);
    ensureStyles(document);
    const styles = document.head.querySelectorAll(`style[${STYLE_ATTR}]`);
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toBe(STYLESHEET);
    expect(STYLESHEET).toContain(".pq-list");
  });

  it("is scoped: every rule targets a pq- class", () => {
    const selectors = STYLESHEET.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .map((block) => block.split("{")[0]?.trim() ?? "")
      .filter((s) => s !== "" && !s.startsWith("@media"));
    expect(selectors.length).toBeGreaterThan(5);
    for (const selector of selectors) {
      for (const part of selector.split(",")) {
        expect(part.trim(), selector).toMatch(/^\.pq-/);
      }
    }
  });

  it("loads no fonts and animates nothing but a hairline colour", () => {
    const rules = STYLESHEET.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/@import|@font-face|url\(/);
    expect(rules).not.toMatch(/@keyframes|animation/);
    expect(rules).toContain("prefers-reduced-motion");
  });

  it("exposes the documented custom properties", () => {
    for (const prop of [
      "--pq-font",
      "--pq-color",
      "--pq-muted",
      "--pq-accent",
      "--pq-border",
      "--pq-radius",
      "--pq-gap",
    ]) {
      expect(STYLESHEET).toContain(`var(${prop}`);
    }
    expect(STYLESHEET).toContain("var(--pq-radius, 0)");
  });
});

/** WCAG relative luminance and contrast ratio for #rrggbb colours. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}
/** `color-mix(in srgb, fg P%, transparent)` composited over `bg`. */
function mix(fg: string, bg: string, p: number): string {
  const ch = (i: number) =>
    Math.round(
      Number.parseInt(fg.slice(i, i + 2), 16) * p +
        Number.parseInt(bg.slice(i, i + 2), 16) * (1 - p),
    )
      .toString(16)
      .padStart(2, "0");
  return `#${ch(1)}${ch(3)}${ch(5)}`;
}

describe("default colours meet WCAG AA (4.5:1) on light and dark hosts", () => {
  // The muted text is `currentColor` at 72% (the stylesheet's default); the
  // ink is whatever the host uses. These are the demo page's two hosts.
  const hosts = [
    { name: "white", ink: "#1a1a1a", bg: "#ffffff" },
    { name: "dark", ink: "#f5f7f6", bg: "#0c0f0e" },
  ];
  for (const { name, ink, bg } of hosts) {
    it(`${name} host: body and muted text`, () => {
      expect(STYLESHEET).toContain("currentColor 72%");
      expect(contrast(ink, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(mix(ink, bg, 0.72), bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("the accent is a graphic (stars, focus ring, marker): ≥ 3:1 on both, never text", () => {
    expect(contrast("#00915a", "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(contrast("#00915a", "#0c0f0e")).toBeGreaterThanOrEqual(3);
    // No text rule sets the accent as its colour.
    const textRules =
      STYLESHEET.match(
        /^\.pq-(excerpt|author|meta|badge|source)[^{]*\{[^}]*\}/gm,
      ) ?? [];
    expect(textRules.length).toBeGreaterThan(0);
    for (const rule of textRules) {
      expect(rule).not.toMatch(/\n\s*color:\s*var\(--pq-accent/);
    }
  });
});
