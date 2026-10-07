#!/usr/bin/env node
/**
 * Site check for the built marketing site (`pnpm --filter @proofql/www
 * check`, part of `test`). Reads dist/ after `astro build` and fails on:
 *
 *   1. an internal `href`/`src` whose target is not in dist/, or a fragment
 *      with no matching `id` (same-page `#demo` included);
 *   2. any third-party script, stylesheet, or font: everything the page
 *      loads is self-hosted (fast, private, nothing to break);
 *   3. drift from the owner's copy: every line of it must appear verbatim
 *      in the page text;
 *   4. a CTA pointing anywhere but its target ("Get started free" and
 *      "Start building free" → sign-up, "See it in action" → #demo, the
 *      nav's Pricing and Sign in);
 *   5. a demo panel without the "Example reviews" label or a highlighted
 *      match, or a review block not marked as the snippet's markup.
 *
 * No dependencies. A regex over attributes is enough: Astro emits
 * well-formed, double-quoted HTML. Biome's noConsole covers apps/**, so
 * output goes through process.stdout / process.stderr.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(ROOT, "dist");

const SIGN_UP = "https://app.proofql.dev/sign-up";
const SIGN_IN = "https://app.proofql.dev/sign-in";
const PRICING = "https://docs.proofql.dev/limits";

/** The owner's copy, verbatim (headings, body, labels, table, FAQ). */
const COPY = [
  "ProofQL · Social proof, in context.",
  "The right Google reviews. On the right pages.",
  "Your clients have already earned the social proof. ProofQL matches their Google reviews to the service on each page, so visitors see customer experiences relevant to what they’re considering.",
  "Built for developers. Ready for client websites. Generous free tier.",
  "Get started free",
  "See it in action",
  "They’re looking for a roofer. Show them roofing reviews.",
  "Your client might do roofing, remodels, and repairs. Each service page deserves reviews about that service.",
  "ProofQL finds the relevant feedback in their existing Google reviews and puts it to work.",
  "On this page…",
  "Show reviews about…",
  "Roof replacement",
  "New roofs, shingle replacement, and cleanup",
  "Root canals",
  "Root canal treatment and the patient’s experience",
  "Kitchen remodeling",
  "Kitchen renovations and the finished result",
  "The visitor sees what other customers experienced with the work they’re considering.",
  "Every service page makes a promise. Give it some proof.",
  "A visitor on a service page has a specific question: Can you do this well?",
  "A review from someone who hired the business for that same work helps answer it.",
  "That’s social proof at its most useful: a real customer’s experience, relevant to the decision in front of you.",
  "Customers use their own words. ProofQL makes the connection.",
  "Someone writes about “replacing our shingles.” Your page says “roofing.”",
  "ProofQL matches meaning, so relevant feedback surfaces even when the wording is different.",
  "Less sorting for you. More relevant proof for your client.",
  "One less thing to handpick on every client site.",
  "Bring in the reviews.",
  "Use the Google reviews your client has already earned.",
  "Match them to the page.",
  "Surface customer experiences relevant to the service, topic, or project.",
  "Put them in front of visitors.",
  "Keep the original customer feedback at the center of the decision.",
  "A free tier you can actually ship with.",
  "Use ProofQL on a real client website, with core review matching included and generous limits for everyday use.",
  "Try it on one service page. Put it on the next project. Keep using the free tier for as long as it meets your needs.",
  "Start building free",
  "Can I use ProofQL for client websites?",
  "Yes. ProofQL is built for developers adding relevant Google reviews to the websites they build and maintain.",
  "Does it rewrite the reviews?",
  "The matching selects relevant reviews. The customer’s words remain their own.",
  "What happens when there aren’t relevant reviews?",
  "ProofQL falls back to general reviews, keeping useful social proof on the page when there isn’t a strong match.",
  "They earned the social proof. You put it in the right place.",
  "Make the reviews as relevant as the rest of the site.",
];

/** @param {string} dir @returns {string[]} */
function htmlFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...htmlFiles(full));
    else if (entry.endsWith(".html")) out.push(full);
  }
  return out;
}

/** @param {string} html @returns {Set<string>} */
function idsIn(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ""));
}

/** Decode the handful of entities Astro emits. @param {string} s */
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Visible text: no head, scripts, or styles; tags dropped, whitespace collapsed. */
function textOf(/** @type {string} */ html) {
  const body = html
    .replace(/<head>[\s\S]*?<\/head>/, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, " ");
  return decode(body.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/ ([.,:?…])/g, "$1");
}

/**
 * Anchors as { href, text }. @param {string} html
 * @returns {{ href: string, text: string }[]}
 */
function anchors(html) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: decode(/\shref="([^"]*)"/.exec(m[1] ?? "")?.[1] ?? ""),
    text: textOf(m[2] ?? "").trim(),
  }));
}

/** @param {string} urlPath @returns {string | null} */
function fileFor(urlPath) {
  const clean = decodeURIComponent(urlPath.replace(/\/+$/, "")) || "/";
  const candidates =
    clean === "/"
      ? ["index.html"]
      : [clean, `${clean}.html`, posix.join(clean, "index.html")];
  for (const candidate of candidates) {
    const full = join(DIST, candidate);
    try {
      if (statSync(full).isFile()) return full;
    } catch {
      // not this one
    }
  }
  return null;
}

/** @type {string[]} */
const failures = [];
const pages = htmlFiles(DIST);
if (pages.length === 0) failures.push(`no HTML in ${DIST}; run astro build`);

// 1 + 2: links, anchors, third-party assets.
let checked = 0;
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const pageUrl = `/${relative(DIST, page).split("\\").join("/")}`;

  for (const m of html.matchAll(/<(script|link)\b([^>]*)>/g)) {
    const attrs = m[2] ?? "";
    const url = /\s(?:src|href)="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const loads =
      m[1] === "script" ||
      /\srel="(?:stylesheet|preload|modulepreload|icon)"/.test(attrs);
    if (loads && /^(https?:)?\/\//i.test(url)) {
      failures.push(`${pageUrl}: third-party asset ${url}`);
    }
  }
  if (/url\(\s*["']?(https?:)?\/\//i.test(html)) {
    failures.push(`${pageUrl}: third-party url() in CSS`);
  }

  const ids = idsIn(html);
  for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    const raw = decode(m[1] ?? "");
    if (
      raw === "" ||
      /^(https?:|mailto:|tel:|data:)/i.test(raw) ||
      raw.startsWith("//")
    ) {
      continue;
    }
    checked += 1;
    const [withoutHash, ...hashParts] = raw.split("#");
    const hash = hashParts.join("#");
    const pathPart = (withoutHash ?? "").split("?")[0] ?? "";
    let target = page;
    if (pathPart !== "") {
      const urlPath = pathPart.startsWith("/")
        ? pathPart
        : posix.resolve(posix.dirname(pageUrl), pathPart);
      const found = fileFor(urlPath);
      if (found === null) {
        failures.push(`${pageUrl}: broken link ${raw}`);
        continue;
      }
      target = found;
    }
    if (hash !== "" && target.endsWith(".html")) {
      const targetIds =
        target === page ? ids : idsIn(readFileSync(target, "utf8"));
      if (!targetIds.has(decodeURIComponent(hash))) {
        failures.push(`${pageUrl}: missing anchor ${raw}`);
      }
    }
  }
}

// 3: the owner's copy, verbatim.
const indexFile = fileFor("/");
const index = indexFile === null ? "" : readFileSync(indexFile, "utf8");
const text = textOf(index);
for (const line of COPY) {
  if (!text.includes(line)) failures.push(`copy missing or changed: "${line}"`);
}

// 4: CTAs.
const links = anchors(index);
/** @param {string} label @param {string} href @param {number} min */
function expectCta(label, href, min) {
  const matching = links.filter((a) => a.text === label);
  if (matching.length < min) {
    failures.push(
      `expected ${min}+ "${label}" link(s), found ${matching.length}`,
    );
  }
  for (const a of matching) {
    if (a.href !== href) failures.push(`"${label}" → ${a.href}, want ${href}`);
  }
}
expectCta("Get started free", SIGN_UP, 3); // nav, hero, closing
expectCta("Start building free", SIGN_UP, 1);
expectCta("See it in action", "#demo", 1);
expectCta("Pricing", PRICING, 1);
expectCta("Sign in", SIGN_IN, 1);

// 5: the demo.
const panels = [
  ...index.matchAll(
    /<div\b[^>]*role="tabpanel"[^>]*>([\s\S]*?)<\/pre><\/div><\/div>/g,
  ),
];
const tabs = [...index.matchAll(/<button\b[^>]*role="tab"/g)];
if (tabs.length !== 3) failures.push(`demo: ${tabs.length} tabs, want 3`);
if (panels.length !== 3) failures.push(`demo: ${panels.length} panels, want 3`);
for (const [i, m] of panels.entries()) {
  const panel = m[1] ?? "";
  if (!/<p class="pq-heading">Example reviews<\/p>/.test(panel)) {
    failures.push(`demo panel ${i}: no "Example reviews" label`);
  }
  if (!/<ul class="pq-list" role="list">/.test(panel)) {
    failures.push(`demo panel ${i}: no snippet list markup`);
  }
  if (!/<mark class="pq-mark">[^<]+<\/mark>/.test(panel)) {
    failures.push(`demo panel ${i}: no highlighted match`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`check-site: ${failures.length} problem(s)\n`);
  for (const f of failures) process.stderr.write(`  ${f}\n`);
  process.exit(1);
}
process.stdout.write(
  `check-site: ${pages.length} pages, ${checked} internal links, ${COPY.length} copy lines, ${panels.length} demo panels — all good\n`,
);
