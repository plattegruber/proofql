import { configDefaults, defineConfig } from "vitest/config";

// Unit vs integration split, by file glob and nothing else (CONTRIBUTING
// "Tests"); same layout as packages/db/vitest.config.ts.
//
//   - unit:        `src/**/*.test.ts` minus `*.integration.test.ts` — drives
//                  the Hono app with `app.request()` under Node, no services.
//   - integration: `src/**/*.integration.test.ts` — the real schema via the
//                  @proofql/db harness (per-file database cloned from the
//                  migrated template), the db injected into `createApp()`,
//                  and a recording fake for the ingest queue. Requires
//                  DATABASE_URL; the harness throws, never skips, without it.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["src/**/*.integration.test.ts"],
          // Builds/refreshes the shared `proofql_template` database once per
          // run; `setupTestDb()` clones it per file.
          globalSetup: ["./test/globalSetup.ts"],
        },
      },
    ],
  },
});
