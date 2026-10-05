/**
 * Seed CLI (#20) — `pnpm seed` from the repo root, or
 * `pnpm --filter @proofql/db seed`.
 *
 * Connects via `DATABASE_URL` (defaulting to the canonical local compose
 * string), refuses non-loopback targets unless `--force` (see ./guard.ts),
 * runs the wipe-and-recreate seed in one transaction, and prints the demo
 * project's freshly minted API keys. The plaintexts exist only in this
 * output: the database stores hashes, and the next run replaces them.
 */

import { createDb } from "../client.js";
import { LOCAL_DATABASE_URL } from "./constants.js";
import { assertSeedTargetAllowed, SeedGuardError } from "./guard.js";
import { runSeed } from "./run.js";

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;

  assertSeedTargetAllowed({ databaseUrl, force });

  const { db, sql } = createDb(databaseUrl, { max: 1 });
  try {
    const summary = await runSeed(db);
    const host = new URL(databaseUrl).hostname;
    console.log(
      `Seeded demo project "Cedar Ridge Dental" (seed v${summary.seedVersion}) on ${host}:`,
    );
    console.log(`  account  ${summary.accountId}`);
    console.log(`  project  ${summary.projectId}`);
    console.log(
      `  reviews  ${summary.reviews.live} live, ${summary.reviews.test} test`,
    );
    console.log(
      `  chunks   ${summary.chunks.full} full, ${summary.chunks.window} window, ` +
        `${summary.chunks.sentence} sentence (all embedded with the fake provider)`,
    );
    console.log(`  generic  ${summary.genericTerms.join(" ") || "(none)"}`);
    console.log("");
    console.log(
      "API keys — LOCAL DEMO ONLY. Shown once; reseeding replaces them.",
    );
    for (const key of summary.keys) {
      const label = `${key.environment} ${key.kind}`.padEnd(17);
      console.log(`  ${label} ${key.plaintext}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof SeedGuardError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
