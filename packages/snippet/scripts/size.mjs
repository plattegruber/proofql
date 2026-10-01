// Size budget for dist/v1.js: 5 KB gzipped (scope.md §3 "Snippet", #32).
//
// `pnpm --filter @proofql/snippet size` rebuilds the bundle and exits non-zero
// when it is over budget; the package `test` script runs it, so CI's unit-test
// job is the gate. The pure helpers are unit-tested in src/size.test.ts.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** The budget, in bytes of gzip output (gzip -9, the CDN's worst case is better). */
export const BUDGET_BYTES = 5 * 1024;

/** Bytes of `source` after gzip at the highest level. */
export function gzippedSize(source) {
  return gzipSync(source, { level: 9 }).length;
}

/**
 * Compare a size against a budget.
 * @param {number} bytes
 * @param {number} [budget]
 * @returns {{ ok: boolean, bytes: number, budget: number, message: string }}
 */
export function checkBudget(bytes, budget = BUDGET_BYTES) {
  const ok = bytes <= budget;
  const pct = ((bytes / budget) * 100).toFixed(1);
  const message = ok
    ? `dist/v1.js: ${bytes.toLocaleString("en-US")} B gzipped, ${pct}% of the ${budget.toLocaleString("en-US")} B budget`
    : `dist/v1.js is ${bytes.toLocaleString("en-US")} B gzipped, over the ${budget.toLocaleString("en-US")} B budget by ${(bytes - budget).toLocaleString("en-US")} B`;
  return { ok, bytes, budget, message };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { buildSnippet } = await import("./build.mjs");
  const out = await buildSnippet();
  const result = checkBudget(gzippedSize(await readFile(out)));
  console.log(result.message);
  if (!result.ok) process.exit(1);
}
