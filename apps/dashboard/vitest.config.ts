import { configDefaults, defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts: the app's Vite config loads the
// react-router and cloudflare plugins, which expect a full dev-server/build
// pipeline and break under Vitest.
//
// Unit vs integration split, by file glob and nothing else (CONTRIBUTING
// "Tests"); same layout as workers/api/vitest.config.ts.
//
//   - unit:        `app/**/*.test.{ts,tsx}` minus `*.integration.test.ts` —
//                  loaders as plain functions, components via renderToString
//                  or createRoutesStub under happy-dom (opt in per file with
//                  `// @vitest-environment happy-dom`). No services.
//   - integration: `app/**/*.integration.test.ts` — the real schema via the
//                  @proofql/db harness (per-file database cloned from the
//                  migrated template). Requires DATABASE_URL; the harness
//                  throws, never skips, without it.
const alias = { "~": new URL("./app", import.meta.url).pathname };

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { alias },
  test: {
    projects: [
      {
        esbuild: { jsx: "automatic" },
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["app/**/*.test.{ts,tsx}"],
          exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
        },
      },
      {
        esbuild: { jsx: "automatic" },
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["app/**/*.integration.test.ts"],
          // Builds/refreshes the shared `proofql_template` database once per
          // run; `setupTestDb()` clones it per file.
          globalSetup: ["./test/globalSetup.ts"],
        },
      },
    ],
  },
});
