/**
 * Ops: hard-delete workspaces deleted in Clerk more than 30 days ago (#169),
 * the same `purgeDeletedAccounts` the pipeline's daily cron (`15 4 * * *`)
 * runs. For catching up by hand or checking what the cron will do.
 *
 *     DATABASE_URL=postgres://... pnpm db:purge-accounts -- --dry-run
 *     DATABASE_URL=postgres://... pnpm db:purge-accounts -- [--limit 50] [--days 30]
 *
 * Database only: this script has no R2 binding, so the uploads of the
 * purged projects are left to the bucket's 7-day lifecycle rule (which has
 * normally removed them long before the 30 days are up). The cron, which
 * has the `UPLOADS` binding, also deletes the prefixes explicitly.
 */

import { fileURLToPath } from "node:url";
import { ACCOUNT_PURGE_AFTER_DAYS, ACCOUNT_PURGE_BATCH } from "@proofql/core";

import { createDb } from "../src/client.js";
import { purgeDeletedAccounts } from "../src/tenancy/purge.js";
import { parseScriptArgs } from "./args.js";

function usage(message: string): never {
  console.error(`db:purge-accounts: ${message}`);
  console.error(
    "usage: pnpm db:purge-accounts -- [--dry-run] [--limit <n>] [--days <n>]",
  );
  process.exit(1);
}

function positiveInt(name: string, raw: string | undefined, fallback: number) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) usage(`--${name} must be a whole number`);
  return n;
}

async function main(): Promise<void> {
  const { values } = parseScriptArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string" },
      days: { type: "string" },
    },
  });
  const url = process.env.DATABASE_URL;
  if (!url) usage("DATABASE_URL is not set");
  const limit = positiveInt("limit", values.limit, ACCOUNT_PURGE_BATCH);
  const afterDays = positiveInt("days", values.days, ACCOUNT_PURGE_AFTER_DAYS);
  const dryRun = values["dry-run"] === true;

  const { db, sql } = createDb(url, { max: 1 });
  try {
    const result = await purgeDeletedAccounts(
      { db },
      { limit, afterDays, dryRun },
    );
    const verb = dryRun ? "would purge" : "purged";
    console.log(
      `db:purge-accounts: ${verb} ${result.accounts.length} account(s) deleted before ${result.cutoff.toISOString()}${result.remaining ? " (more remain; run again)" : ""}.`,
    );
    for (const a of result.accounts) {
      console.log(
        `  ${a.accountId}  deleted ${a.deletedAt.toISOString()}  ${a.projects} project(s), ${a.reviews} review(s)`,
      );
    }
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
