// Build the cdn worker's static assets directory (#34):
//
//   public/v1.js              the snippet bundle from packages/snippet
//   public/v1.js.map
//   public/v1.<hash>.js       the same bytes, content-addressed (sha256, 8 hex)
//   public/v1.<hash>.js.map   (its sourceMappingURL comment points here)
//   public/version.json       { version, hash, builtAt }
//
// `pnpm --filter @proofql/cdn build`. Runs the snippet's own esbuild step
// (`buildSnippet` from @proofql/snippet) so the cdn always ships the source
// in the tree, then copies. Stale hashed copies from earlier local builds
// are removed so `wrangler deploy` uploads exactly one build; public/demo/
// (the committed demo site) is never touched.
//
// `buildCdn` is exported for the unit test (src/build.test.ts), which builds
// into a temp directory and asserts the file set and the manifest.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSnippet } from "@proofql/snippet/scripts/build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
/** Default output: workers/cdn/public. */
export const PUBLIC_DIR = resolve(here, "..", "public");

/** First 8 hex characters of the SHA-256 of `bytes`. */
export function contentHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/** Point the bundle's sourceMappingURL comment at `mapName`. */
export function retargetSourceMap(source, mapName) {
  return source.replace(
    /^\/\/# sourceMappingURL=.*$/m,
    `//# sourceMappingURL=${mapName}`,
  );
}

/** Files a previous build left in `dir` that this build replaces. */
export function isBuildOutput(name) {
  return (
    /^v1(\.[0-9a-f]{8})?\.js(\.map)?$/.test(name) || name === "version.json"
  );
}

/**
 * @param {{ outDir?: string, now?: Date }} [options]
 * @returns {Promise<{ outDir: string, hash: string, version: string, files: string[] }>}
 */
export async function buildCdn({ outDir = PUBLIC_DIR, now = new Date() } = {}) {
  const bundlePath = await buildSnippet();
  const bundle = await readFile(bundlePath);
  const map = await readFile(`${bundlePath}.map`);
  // The snippet's version is the bundle's `window.ProofQL.version`; /health
  // and version.json report that, not this worker's own package version.
  const snippetPkg = JSON.parse(
    await readFile(
      createRequire(import.meta.url).resolve("@proofql/snippet/package.json"),
      "utf8",
    ),
  );

  const hash = contentHash(bundle);
  await mkdir(outDir, { recursive: true });
  for (const name of await readdir(outDir)) {
    if (isBuildOutput(name)) await rm(join(outDir, name));
  }

  const hashedName = `v1.${hash}.js`;
  const files = {
    "v1.js": bundle,
    "v1.js.map": map,
    [hashedName]: retargetSourceMap(
      bundle.toString("utf8"),
      `${hashedName}.map`,
    ),
    [`${hashedName}.map`]: map,
    "version.json": `${JSON.stringify(
      { version: snippetPkg.version, hash, builtAt: now.toISOString() },
      null,
      2,
    )}\n`,
  };
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(outDir, name), contents);
  }
  return {
    outDir,
    hash,
    version: snippetPkg.version,
    files: Object.keys(files).sort(),
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const result = await buildCdn();
  process.stdout.write(
    `built ${result.outDir}: ${result.files.join(", ")} (snippet ${result.version}, hash ${result.hash})\n`,
  );
}
