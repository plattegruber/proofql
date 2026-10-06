/**
 * Bindings are not inherited across wrangler environments, so the account
 * purge's cron and its `UPLOADS` binding (#169) must appear in the local
 * block and in both env blocks. A text check, not a parse: enough to catch
 * an env block that was forgotten.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ACCOUNT_PURGE_CRON } from "./account-purge.js";

const config = readFileSync(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8",
);

const occurrences = (needle: string) => config.split(needle).length - 1;

describe("wrangler.jsonc", () => {
  it("schedules the account purge in all three blocks", () => {
    expect(occurrences(`"${ACCOUNT_PURGE_CRON}"]`)).toBe(3);
  });

  it("binds UPLOADS to the right bucket in all three blocks", () => {
    expect(config).toContain('"bucket_name": "proofql-uploads" }');
    expect(config).toContain('"bucket_name": "proofql-uploads-preview" }');
    expect(config).toContain('"bucket_name": "proofql-uploads-prod" }');
    expect(occurrences('"binding": "UPLOADS"')).toBe(3);
  });
});
