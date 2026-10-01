#!/usr/bin/env node
/**
 * Link check for the built docs site (`pnpm --filter @proofql/docs check`).
 *
 * Reads dist/ after `astro build` and fails on:
 *
 *   1. any internal `href`/`src` whose target file does not exist in dist/
 *      (pages are files: `/errors` → `errors.html`, `/` → `index.html`);
 *   2. any internal link with a fragment whose target page has no element
 *      with that id (same-page `#…` links included);
 *   3. any value of the spec's `ErrorCode` enum (docs/api/openapi.yaml) with
 *      no `id="<code>"` on the errors page — the api worker emits
 *      `doc_url: https://docs.proofql.com/errors#<code>` for every error,
 *      so each anchor is a public contract (workers/api/src/errors.ts);
 *   4. the `#relevance` anchor on the relevance page, which the product
 *      copy links to.
 *
 * No dependencies beyond `yaml` (already a workspace devDependency). A regex
 * over attributes is enough: Astro emits well-formed, double-quoted HTML.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(ROOT, "dist");
const SPEC = join(ROOT, "..", "api", "openapi.yaml");

/** @param {string} dir @returns {string[]} absolute paths of every .html under dir */
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
  /** @type {Set<string>} */
  const ids = new Set();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1] ?? "");
  return ids;
}

/** @param {string} html @returns {string[]} */
function linksIn(html) {
  return [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1] ?? "");
}

/**
 * Map a URL path (no fragment, no query) to the dist file that serves it, or
 * null. Mirrors Workers Static Assets with `html_handling:
 * auto-trailing-slash` over Astro's `build.format: "file"` output.
 * @param {string} urlPath
 * @returns {string | null}
 */
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
if (pages.length === 0) {
  failures.push(`no HTML in ${DIST} — run \`astro build\` first`);
}

/** @type {Map<string, Set<string>>} file → ids, filled lazily */
const idCache = new Map();
/** @param {string} file */
function idsOf(file) {
  let ids = idCache.get(file);
  if (ids === undefined) {
    ids = idsIn(readFileSync(file, "utf8"));
    idCache.set(file, ids);
  }
  return ids;
}

let checked = 0;
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const pageUrl = `/${relative(DIST, page).split("\\").join("/")}`;
  for (const raw of linksIn(html)) {
    if (
      raw === "" ||
      /^(https?:|mailto:|tel:|data:|javascript:)/i.test(raw) ||
      raw.startsWith("//")
    ) {
      continue;
    }
    checked += 1;
    const [withoutHash, ...hashParts] = raw.split("#");
    const hash = hashParts.join("#");
    const pathPart = (withoutHash ?? "").split("?")[0] ?? "";
    let target;
    if (pathPart === "") {
      target = page;
    } else {
      const urlPath = pathPart.startsWith("/")
        ? pathPart
        : posix.resolve(posix.dirname(pageUrl), pathPart);
      target = fileFor(urlPath);
      if (target === null) {
        failures.push(`${pageUrl}: broken link ${raw}`);
        continue;
      }
    }
    if (hash !== "" && target.endsWith(".html")) {
      if (!idsOf(target).has(decodeURIComponent(hash))) {
        failures.push(`${pageUrl}: missing anchor ${raw}`);
      }
    }
  }
}

// 3. Every error code has its anchor on /errors.
const spec =
  /** @type {{ components: { schemas: { ErrorCode: { enum: string[] } } } }} */ (
    parseYaml(readFileSync(SPEC, "utf8"))
  );
const codes = spec.components.schemas.ErrorCode.enum;
const errorsPage = fileFor("/errors");
if (errorsPage === null) {
  failures.push("/errors is missing — every doc_url points at it");
} else {
  const ids = idsOf(errorsPage);
  for (const code of codes) {
    if (!ids.has(code)) failures.push(`/errors: no anchor #${code}`);
  }
}

// 4. The relevance anchor.
const relevancePage = fileFor("/relevance");
if (relevancePage === null || !idsOf(relevancePage).has("relevance")) {
  failures.push("/relevance#relevance is missing");
}

if (failures.length > 0) {
  console.error(`check-links: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `check-links: ${pages.length} pages, ${checked} internal links, ${codes.length} error-code anchors — all good`,
);
