import { configDefaults, defineConfig } from "vitest/config";

// Unit vs integration split, by file glob and nothing else (CONTRIBUTING
// "Tests"); same layout as packages/db/vitest.config.ts.
//
//   - unit:        `src/**/*.test.ts` minus `**/*.integration.test.ts`
//                  — hand-built batches and fakes, no DB, no network.
//   - integration: only `**/*.integration.test.ts`
//                  — the real consumer against a real Postgres via
//                  DATABASE_URL, using the @proofql/db harness. globalSetup
//                  builds the migrated template database once per run.
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
          globalSetup: ["./test/globalSetup.ts"],
        },
      },
    ],
  },
});
