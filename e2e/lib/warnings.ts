/**
 * Things a passing run must still shout about (configuration drift that
 * made the run test a different path than intended). Each warning goes
 * into the Playwright report as an annotation and into
 * `test-results/at-warnings.txt`, which the workflow turns into a GitHub
 * `::warning::` annotation and a job-summary line after the run.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "@playwright/test";

export const WARNINGS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-results",
  "at-warnings.txt",
);

export function recordWarning(message: string): void {
  console.warn(`[at] warning: ${message}`);
  test.info().annotations.push({ type: "warning", description: message });
  mkdirSync(dirname(WARNINGS_FILE), { recursive: true });
  appendFileSync(WARNINGS_FILE, `${message}\n`);
}
