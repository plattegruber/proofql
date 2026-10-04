#!/usr/bin/env node
/**
 * Limits check for the built docs site (`pnpm --filter @proofql/docs check`,
 * after check-links; issue #103).
 *
 * The Limits page renders its plan table, rate limits and badge rule from
 * `@proofql/core` at build time (src/components/PlanTable.astro and
 * siblings). This script re-reads the *built* `limits.html` against the
 * *current* core so a change to `PLANS` without a docs rebuild cannot ship
 * stale numbers. It fails on:
 *
 *   1. a `#plan-table` whose header and rows are not exactly core's
 *      `planTableRows()` (one column per plan, in `PLAN_NAMES` order);
 *   2. any number in `PLANS` (projects, reviews, queries, both rate limits)
 *      missing from its plan's column of `#plan-table`, for every plan;
 *   3. a `#rate-limit-table` whose plan columns do not carry each plan's
 *      secret and publishable limits over `RATE_LIMIT_PERIOD_SECONDS`;
 *   4. a `#badge-rule` item whose `badge: true|false` disagrees with `PLANS`;
 *   5. no link to `PRICING_URL`;
 *   6. a `#request-body-limits` table (#112) whose rows are not exactly core.s
 *      `requestBodyLimitRows()`, or with a limit cell that does not spell its
 *      `REQUEST_BODY_LIMITS` number as `formatBytes` does.
 *
 * Imports `@proofql/core` from its dist/ — the docs build itself already
 * needs it, so by the time this runs it exists. A regex over the HTML is
 * enough: Astro emits well-formed, double-quoted markup.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatBytes,
  PLAN_LABELS,
  PLAN_NAMES,
  PLANS,
  PRICING_URL,
  planTableRows,
  RATE_LIMIT_PERIOD_SECONDS,
  REQUEST_BODY_LIMITS,
  requestBodyLimitRows,
} from "@proofql/core";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PAGE = join(ROOT, "dist", "limits.html");

/** Same formatting as core's table renderer: en-US digit grouping. */
const fmt = (/** @type {number} */ n) => n.toLocaleString("en-US");

/** HTML entities Astro may emit in text content. @type {Record<string, string>} */
const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  "#x27": "'",
  nbsp: " ",
};

/** @param {string} html @returns {string} tags stripped, entities decoded, whitespace collapsed */
function text(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(
      /&(amp|lt|gt|quot|#39|#x27|nbsp);/g,
      (_, /** @type {string} */ e) => ENTITIES[e] ?? "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The element with this id, or null.
 * @param {string} html @param {string} tag @param {string} id
 */
function elementById(html, tag, id) {
  const m = html.match(
    new RegExp(`<${tag}[^>]*\\sid="${id}"[^>]*>([\\s\\S]*?)</${tag}>`),
  );
  return m?.[1] ?? null;
}

/** @param {string} tableHtml @returns {string[][]} rows of cell text, header first */
function cells(tableHtml) {
  return [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...(row[1] ?? "").matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) =>
      text(c[1] ?? ""),
    ),
  );
}

/**
 * Every digit group in a cell ("300 / min" → ["300"], "5,000" → ["5,000"]),
 * so a number is matched whole and "1" is not found inside "120".
 * @param {string} cell
 */
function numbersIn(cell) {
  const found = cell.match(/\d[\d,]*/g);
  return found === null ? [] : [...found];
}

/**
 * Column index per plan from a header row, by display label.
 * @param {string[]} header @param {string} table
 * @returns {Partial<Record<keyof typeof PLANS, number>>}
 */
function planColumns(header, table) {
  /** @type {Partial<Record<keyof typeof PLANS, number>>} */
  const out = {};
  for (const plan of PLAN_NAMES) {
    const i = header.indexOf(PLAN_LABELS[plan]);
    if (i === -1) failures.push(`${table}: no "${PLAN_LABELS[plan]}" column`);
    else out[plan] = i;
  }
  return out;
}

/** @type {string[]} */
const failures = [];

/** @type {string} */
let html;
try {
  html = readFileSync(PAGE, "utf8");
} catch {
  console.error(`check-limits: ${PAGE} is missing — run \`astro build\` first`);
  process.exit(1);
}

// 1 + 2. The plan table is exactly core's rows, and every PLANS number is in
// its plan's column.
const planTable = elementById(html, "table", "plan-table");
if (planTable === null) {
  failures.push("/limits: no #plan-table");
} else {
  const [header = [], ...rows] = cells(planTable);
  const expectedHeader = ["Limit", ...PLAN_NAMES.map((p) => PLAN_LABELS[p])];
  const expectedRows = planTableRows().map((r) => [
    r.limit,
    ...PLAN_NAMES.map((p) => r[p]),
  ]);
  if (JSON.stringify(header) !== JSON.stringify(expectedHeader)) {
    failures.push(
      `#plan-table header is ${JSON.stringify(header)}, core says ${JSON.stringify(expectedHeader)}`,
    );
  }
  if (JSON.stringify(rows) !== JSON.stringify(expectedRows)) {
    failures.push(
      `#plan-table rows differ from core planTableRows():\n    built: ${JSON.stringify(rows)}\n    core:  ${JSON.stringify(expectedRows)}`,
    );
  }
  const col = planColumns(header, "#plan-table");
  for (const plan of PLAN_NAMES) {
    const i = col[plan];
    if (i === undefined) continue;
    const column = rows.flatMap((r) => numbersIn(r[i] ?? ""));
    const { rateLimits, ...rest } = PLANS[plan];
    const numbers = [
      ...Object.values(rest),
      ...Object.values(rateLimits),
    ].filter((v) => typeof v === "number");
    for (const n of numbers) {
      if (!column.includes(fmt(n))) {
        failures.push(
          `#plan-table: ${fmt(n)} (PLANS.${plan}) is not in the ${PLAN_LABELS[plan]} column`,
        );
      }
    }
  }
}

// 3. Rate limits per plan over the shared period.
const rateTable = elementById(html, "table", "rate-limit-table");
if (rateTable === null) {
  failures.push("/limits: no #rate-limit-table");
} else {
  const [header = [], ...rows] = cells(rateTable);
  const col = planColumns(header, "#rate-limit-table");
  for (const plan of PLAN_NAMES) {
    const i = col[plan];
    if (i === undefined) continue;
    const column = rows.map((r) => r[i] ?? "");
    for (const kind of /** @type {const} */ (["secret", "publishable"])) {
      const n = PLANS[plan].rateLimits[kind];
      const cell = column.find((c) => numbersIn(c).includes(fmt(n)));
      if (cell === undefined) {
        failures.push(
          `#rate-limit-table: ${fmt(n)} (PLANS.${plan}.rateLimits.${kind}) is not in the ${PLAN_LABELS[plan]} column`,
        );
      } else if (!numbersIn(cell).includes(String(RATE_LIMIT_PERIOD_SECONDS))) {
        failures.push(
          `#rate-limit-table: "${cell}" does not name the ${RATE_LIMIT_PERIOD_SECONDS} s period`,
        );
      }
    }
  }
}

// 4. The badge rule per plan.
const badgeRule = elementById(html, "ul", "badge-rule");
if (badgeRule === null) {
  failures.push("/limits: no #badge-rule");
} else {
  for (const plan of PLAN_NAMES) {
    const item = badgeRule.match(
      new RegExp(`<li[^>]*\\sdata-plan="${plan}"[^>]*>([\\s\\S]*?)</li>`),
    );
    const expected = `badge: ${String(PLANS[plan].badge)}`;
    if (item === null) {
      failures.push(`#badge-rule: no item for the ${plan} plan`);
    } else if (!text(item[1] ?? "").includes(expected)) {
      failures.push(`#badge-rule: the ${plan} item does not say "${expected}"`);
    }
  }
}

// 5. The pricing link.
if (!html.includes(`href="${PRICING_URL}"`)) {
  failures.push(`/limits: no link to ${PRICING_URL}`);
}

// 6. The request-body table is exactly core's rows, each limit spelled as
// core formats the byte count.
const bodyTable = elementById(html, "table", "request-body-limits");
if (bodyTable === null) {
  failures.push("/limits: no #request-body-limits");
} else {
  const [, ...rows] = cells(bodyTable);
  const built = rows.map(([request, limit]) => [request, limit]);
  const expected = requestBodyLimitRows().map((r) => [r.request, r.limit]);
  if (JSON.stringify(built) !== JSON.stringify(expected)) {
    failures.push(
      `#request-body-limits rows differ from core requestBodyLimitRows():\n    built: ${JSON.stringify(built)}\n    core:  ${JSON.stringify(expected)}`,
    );
  }
  for (const [key, bytes] of Object.entries(REQUEST_BODY_LIMITS)) {
    const row = bodyTable.match(
      new RegExp(`<tr[^>]*\\sdata-limit="${key}"[^>]*>([\\s\\S]*?)</tr>`),
    );
    if (row === null) {
      failures.push(
        `#request-body-limits: no row for REQUEST_BODY_LIMITS.${key}`,
      );
    } else if (!text(row[1] ?? "").includes(formatBytes(bytes))) {
      failures.push(
        `#request-body-limits: the ${key} row does not say "${formatBytes(bytes)}"`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(
    `check-limits: ${failures.length} problem(s) — rebuild the docs after changing @proofql/core`,
  );
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `check-limits: /limits matches @proofql/core PLANS (${PLAN_NAMES.length} plans, ${planTableRows().length} rows, rate limits, badge rule, pricing link) and REQUEST_BODY_LIMITS (${requestBodyLimitRows().length} rows) — all good`,
);
