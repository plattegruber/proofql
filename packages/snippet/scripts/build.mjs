// Bundle src/index.ts into a single minified IIFE, dist/v1.js (+ .map).
//
// esbuild is the only build tool: no runtime dependencies, no framework. The
// output is what cdn.proofql.com/v1.js serves (scope.md §3 "Snippet"); its
// size is policed by scripts/size.mjs, which the `test` script runs.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

/** @returns {Promise<string>} the absolute path of the bundle. */
export async function buildSnippet() {
  await build({
    absWorkingDir: root,
    entryPoints: ["src/index.ts"],
    outfile: "dist/v1.js",
    bundle: true,
    minify: true,
    format: "iife",
    platform: "browser",
    // Every browser that has `fetch`; nothing older is a target.
    target: ["es2018", "chrome70", "firefox65", "safari12", "edge79"],
    sourcemap: true,
    legalComments: "none",
    charset: "utf8",
    define: { __VERSION__: JSON.stringify(pkg.version) },
    logLevel: "warning",
  });
  return `${root}dist/v1.js`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = await buildSnippet();
  console.log(`built ${out}`);
}
