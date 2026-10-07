/**
 * WCAG AA contrast for every text/background pair the site uses, in light
 * and dark, read from the tokens in src/styles/global.css (axe cannot
 * measure contrast without a layout engine). Text needs 4.5:1; the focus
 * ring and other non-text indicators need 3:1. The demo's mock client page
 * is always light and uses fixed colours, listed at the end.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Not `new URL(…, import.meta.url)`: jsdom replaces the global URL.
const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/styles/global.css"),
  "utf8",
);

function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    out[m[1] ?? ""] = (m[2] ?? "").toLowerCase();
  }
  return out;
}

const light = vars(/^:root \{([\s\S]*?)^\}/m.exec(css)?.[1] ?? "");
const dark = {
  ...light,
  ...vars(
    /prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\}/.exec(
      css,
    )?.[1] ?? "",
  ),
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** [foreground, background, minimum] by token name. */
const PAIRS: [string, string, number][] = [
  ["fg", "bg", 4.5],
  ["fg", "bg-sunken", 4.5],
  ["fg-secondary", "bg", 4.5],
  ["fg-secondary", "bg-sunken", 4.5],
  ["link", "bg", 4.5],
  ["link", "bg-sunken", 4.5],
  ["fg", "accent-soft", 4.5],
  ["btn-fg", "btn-bg", 4.5],
  ["btn-fg", "btn-bg-hover", 4.5],
  ["band-fg", "band-bg", 4.5],
  ["band-fg-secondary", "band-bg", 4.5],
  ["band-bg", "band-fg", 4.5], // the inverse button
  ["band-bg", "band-fg-secondary", 4.5], // its hover
  ["accent", "bg", 3], // focus ring
  ["accent", "bg-sunken", 3],
];

describe.each([
  ["light", light],
  ["dark", dark],
])("%s theme", (_name, tokens) => {
  it.each(PAIRS)("%s on %s ≥ %s:1", (fg, bg, min) => {
    const a = tokens[fg];
    const b = tokens[bg];
    expect(a, `--${fg}`).toBeDefined();
    expect(b, `--${bg}`).toBeDefined();
    expect(ratio(a ?? "", b ?? "")).toBeGreaterThanOrEqual(min);
  });
});

describe("demo mock page (fixed light colours in Demo.astro)", () => {
  it.each([
    ["#1f2523", "#ffffff"], // page text, snippet text (inherits it)
    ["#575f5b", "#ffffff"], // business name
    ["#575f5b", "#f7f8f7"], // URL bar
  ])("%s on %s ≥ 4.5:1", (fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});
