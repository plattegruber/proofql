/**
 * Apply every pending migration in ../migrations to DATABASE_URL.
 *
 * Idempotent: drizzle's migrator records applied migrations (by hash) in
 * `drizzle.__drizzle_migrations` and skips them on the next run, so this is
 * safe to run on every deploy and every CI job. It is the only way
 * migrations reach a database — the test harness and the deploy pipeline
 * both call `runMigrations`.
 *
 *     DATABASE_URL=postgres://... pnpm db:migrate
 */

import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Absolute path to `packages/db/migrations`. */
export const MIGRATIONS_DIR = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

export async function runMigrations(connectionString: string): Promise<void> {
  // One connection, no prepared statements: the migrator runs a handful of
  // DDL statements in a transaction and nothing else.
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "db:migrate: DATABASE_URL is not set. Example: " +
        "postgres://proofql:proofql@localhost:54322/proofql",
    );
    process.exit(1);
  }
  await runMigrations(url);
  console.log(`db:migrate: migrations in ${MIGRATIONS_DIR} are applied.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
