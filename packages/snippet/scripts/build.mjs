// Bundle src/index.ts into a single minified IIFE, dist/v1.js (+ .map).
//
// esbuild is the only build tool: no runtime dependencies, no framework. The
// output is what cdn.proofql.dev/v1.js serves (scope.md §3 "Snippet"); its
// size is policed by scripts/size.mjs, which the `test` script runs.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build, transform } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

/**
 * `import css from "./styles.css?raw"` → the minified stylesheet as a string
 * (Vite gives vitest the same import for free; esbuild needs to be told).
 */
const rawCss = {
  name: "raw-css",
  setup(api) {
    api.onResolve({ filter: /\.css\?raw$/ }, (args) => ({
      path: new URL(
        args.path.replace(/\?raw$/, ""),
        `file://${args.resolveDir}/`,
      ).pathname,
      namespace: "raw-css",
    }));
    api.onLoad({ filter: /.*/, namespace: "raw-css" }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const { code } = await transform(source, { loader: "css", minify: true });
      return { contents: code.trim(), loader: "text" };
    });
  },
};

/** @returns {Promise<string>} the absolute path of the bundle. */
export async function buildSnippet() {
  await build({
    plugins: [rawCss],
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
