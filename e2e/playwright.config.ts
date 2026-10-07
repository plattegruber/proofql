import { defineConfig, devices } from "@playwright/test";

import { target } from "./lib/target";

/**
 * One config for every target (`AT_TARGET=preview|prod`, lib/target.ts).
 * The suite is a single serial customer journey against a live deployment,
 * so: one worker, no retries (a retry would sign up a second user and
 * double the free-plan spend; a flaky stage should be fixed, not hidden).
 *
 * The repository is public, so CI artifacts are too. Traces, videos,
 * screenshots, the HTML report and error-context page snapshots hold what
 * the browser saw: API key plaintexts (the Keys tab reveals a fresh
 * pq_sk_live key), Clerk session tokens. On preview all of it is throwaway
 * (the run deletes its project and its user), so preview keeps it all for
 * failures. On prod none of it is captured and the workflow uploads no
 * artifact: a failure is debugged from the log, where the failing step's
 * name, the URL and the page's visible error text are printed with keys
 * redacted (tests/customer-journey.spec.ts `describeFailure`).
 */
const prod = target.name === "prod";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  // Sign-up, setup, indexing (bounded at 3 min) and both cleanups.
  timeout: 10 * 60 * 1000,
  expect: { timeout: 15_000 },
  reporter: prod
    ? [["list"], ["github"]]
    : process.env.CI
      ? [["list"], ["github"], ["html", { open: "never" }]]
      : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: target.dashboardUrl,
    trace: prod ? "off" : "retain-on-failure",
    screenshot: prod ? "off" : "only-on-failure",
    video: prod ? "off" : "retain-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
