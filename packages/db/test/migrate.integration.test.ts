/**
 * The DoD check for #15: the migration applies to a brand-new database, and
 * running it again is a no-op (drizzle records applied migrations by hash).
 * This bypasses the template on purpose — the template proves the warm
 * path, this proves `pnpm db:migrate` against an empty server.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../scripts/migrate.js";
import { withMaintenance } from "./harness.js";
import {
  assertSafeIdentifier,
  requireDatabaseUrl,
  withDatabase,
} from "./support.js";

describe("scripts/migrate.ts against a fresh database", () => {
  const databaseUrl = requireDatabaseUrl();
  const databaseName = assertSafeIdentifier(
    `test_${Math.floor(Date.now() / 1000)}_${process.pid}_fresh`,
  );
  const freshUrl = withDatabase(databaseUrl, databaseName);

  beforeAll(async () => {
    await withMaintenance(databaseUrl, async (m) => {
      await m.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await m.unsafe(`CREATE DATABASE "${databaseName}"`);
    });
  });

  afterAll(async () => {
    await withMaintenance(databaseUrl, async (m) => {
      await m.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    });
  });

  it("applies 0001 to an empty database and is idempotent on re-run", async () => {
    await runMigrations(freshUrl);
    await runMigrations(freshUrl); // second run: nothing to do, no error

    const sql = postgres(freshUrl, { max: 1, prepare: false });
    try {
      const [applied] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations
      `;
      expect(applied?.n).toBe(1);

      const [ext] = await sql`
        SELECT extname FROM pg_extension WHERE extname = 'vector'
      `;
      expect(ext?.extname).toBe("vector");

      const [col] = await sql<{ udt_name: string }[]>`
        SELECT udt_name FROM information_schema.columns
        WHERE table_name = 'review_chunks' AND column_name = 'embedding'
      `;
      expect(col?.udt_name).toBe("halfvec");

      const [gen] = await sql<{ is_generated: string }[]>`
        SELECT is_generated FROM information_schema.columns
        WHERE table_name = 'review_chunks' AND column_name = 'tsv'
      `;
      expect(gen?.is_generated).toBe("ALWAYS");
    } finally {
      await sql.end();
    }
  });
});
