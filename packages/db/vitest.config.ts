import { configDefaults, defineConfig } from "vitest/config";

// Unit vs integration split, by file glob and nothing else (CONTRIBUTING
// "Tests"):
//
//   - unit:        `**/*.test.ts` minus `**/*.integration.test.ts`
//                  — no DB, no network, runs anywhere with zero services.
//                  Covers `src/` and the ops scripts' helpers in `scripts/`.
//   - integration: only `**/*.integration.test.ts`
//                  — requires a real Postgres via DATABASE_URL. The harness
//                  throws (never skips) when DATABASE_URL is unset, so a
//                  misconfigured CI job cannot silently pass.
//
// Tests run per workspace through turbo (`test` depends on `^build`), so
// the projects live here rather than in a repo-root config.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: [
            "src/**/*.integration.test.ts",
            "test/**/*.integration.test.ts",
          ],
          // globalSetup builds/refreshes the proofql_template database once
          // per run; each test file clones it via setupTestDb() in
          // test/harness.ts.
          globalSetup: ["./test/globalSetup.ts"],
        },
      },
    ],
  },
});
