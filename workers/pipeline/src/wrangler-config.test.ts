/**
 * Bindings are not inherited across wrangler environments, so the cron and
 * the `UPLOADS` binding (#169) must appear in the local block and in both
 * env blocks. The Workers Free plan allows five cron triggers per account
 * (#174), so each block declares exactly one: src/schedule.ts picks the
 * jobs due on each tick.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8",
);

const occurrences = (needle: string) => config.split(needle).length - 1;

describe("wrangler.jsonc", () => {
  it("declares exactly one five-minute cron in each of the three blocks", () => {
    // Comments are whole lines; drop them and trailing commas to get JSON.
    const json = config
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1");
    const parsed = JSON.parse(json) as {
      triggers?: { crons?: string[] };
      env: Record<string, { triggers?: { crons?: string[] } }>;
    };
    const blocks = {
      local: parsed,
      preview: parsed.env.preview,
      prod: parsed.env.prod,
    };
    for (const [name, block] of Object.entries(blocks)) {
      expect(block?.triggers?.crons, name).toEqual(["*/5 * * * *"]);
    }
  });

  it("binds UPLOADS to the right bucket in all three blocks", () => {
    expect(config).toContain('"bucket_name": "proofql-uploads" }');
    expect(config).toContain('"bucket_name": "proofql-uploads-preview" }');
    expect(config).toContain('"bucket_name": "proofql-uploads-prod" }');
    expect(occurrences('"binding": "UPLOADS"')).toBe(3);
  });
});
