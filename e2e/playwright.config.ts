import { defineConfig, devices } from "@playwright/test";

import { target } from "./lib/target";

/**
 * One config for every target (`AT_TARGET=preview|prod`, lib/target.ts).
 * The suite is a single serial customer journey against a live deployment,
 * so: one worker, no retries (a retry would sign up a second user and
 * double the free-plan spend; a flaky stage should be fixed, not hidden),
 * and traces/screenshots/video kept for failures only.
 */
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
  reporter: process.env.CI
    ? [["list"], ["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: target.dashboardUrl,
    // The repository is public, so CI artifacts are too. Traces and videos
    // hold everything the browser saw: API key plaintexts, Clerk session
    // tokens. On preview all of it is throwaway (the run deletes its
    // project and its user); on prod the user is long-lived, so prod keeps
    // failure screenshots only.
    trace: target.name === "prod" ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: target.name === "prod" ? "off" : "retain-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
