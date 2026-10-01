/**
 * Vitest globalSetup for the integration project.
 *
 * Builds (or reuses) `proofql_template`: a database with every migration
 * applied, from which each test file clones its own throwaway database via
 * `setupTestDb()` in `./harness.ts`. Cloning is milliseconds; migrations
 * run at most once per change to the migrations folder.
 *
 * Warm path (template exists and its stored fingerprint matches the current
 * migrations folder): two catalog queries plus the orphan sweep. Cold path:
 * drop and recreate the template and run all migrations into it once.
 *
 * The migration connection is closed before this function returns —
 * `CREATE DATABASE ... TEMPLATE` requires no other connections to the
 * template, and test files start only after globalSetup resolves.
 */

import postgres from "postgres";

import { runMigrations } from "../scripts/migrate.js";
import {
  assertSafeIdentifier,
  MAINTENANCE_DB,
  migrationsHash,
  OBJECT_IN_USE,
  requireDatabaseUrl,
  TEMPLATE_DB,
  withDatabase,
} from "./support.js";

/**
 * Advisory lock key serializing template builds — two integration runs
 * against the same server (turbo running several workspaces' suites in
 * parallel) must not race the drop/create/migrate sequence.
 */
const TEMPLATE_BUILD_LOCK = 772_015; // arbitrary; unique to this harness

export default async function globalSetup(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const maintenance = postgres(withDatabase(databaseUrl, MAINTENANCE_DB), {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });

  try {
    await maintenance`SELECT pg_advisory_lock(${TEMPLATE_BUILD_LOCK})`;

    const expectedFingerprint = `migrations sha256:${migrationsHash()}`;
    const [existing] = await maintenance`
      SELECT shobj_description(oid, 'pg_database') AS fingerprint
      FROM pg_database WHERE datname = ${TEMPLATE_DB}
    `;

    if (existing?.fingerprint !== expectedFingerprint) {
      await buildTemplate(maintenance, databaseUrl, expectedFingerprint);
    }

    await sweepOrphans(maintenance);
    await maintenance`SELECT pg_advisory_unlock(${TEMPLATE_BUILD_LOCK})`;
  } finally {
    await maintenance.end();
  }
}

type Maintenance = postgres.Sql;

async function buildTemplate(
  maintenance: Maintenance,
  databaseUrl: string,
  fingerprint: string,
): Promise<void> {
  assertSafeIdentifier(TEMPLATE_DB);
  // WITH (FORCE): a crashed previous run may have left a connection open to
  // the template; nothing is ever legitimately connected to it while we
  // hold the build lock.
  await maintenance.unsafe(
    `DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`,
  );
  await maintenance.unsafe(`CREATE DATABASE "${TEMPLATE_DB}"`);

  // The same code path as `pnpm db:migrate`; it closes its connection
  // before returning, which cloning requires.
  await runMigrations(withDatabase(databaseUrl, TEMPLATE_DB));

  // Fingerprint lives in the database COMMENT so the warm-path check never
  // has to connect to the template itself. Hex hash — safe to inline.
  await maintenance.unsafe(
    `COMMENT ON DATABASE "${TEMPLATE_DB}" IS '${fingerprint}'`,
  );
}

/**
 * Minimum age before a `test_%` database counts as a crashed run's orphan.
 * A whole integration run finishes in minutes; an hour is a wide margin.
 */
const ORPHAN_MIN_AGE_SECONDS = 60 * 60;

/**
 * Drop leftover `test_%` databases from crashed runs so they never
 * accumulate. Two guards, both required:
 *
 * - **Age**: only databases whose name-embedded creation epoch
 *   (`test_<created-epoch>_<pid>_<n>`, stamped by `setupTestDb()`) is at
 *   least {@link ORPHAN_MIN_AGE_SECONDS} old are touched. "Not currently
 *   connected" proves nothing — postgres-js connects lazily, so a concurrent
 *   run's fresh clone sits connection-less between its CREATE and its
 *   file's first query, and must never be reaped.
 * - **In-use skip**: plain DROP (no FORCE) — a database that does have a
 *   connection fails with 55006 and is skipped, never killed.
 */
async function sweepOrphans(maintenance: Maintenance): Promise<void> {
  const orphans = await maintenance`
    SELECT datname FROM pg_database WHERE datname LIKE ${"test\\_%"}
  `;
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const { datname } of orphans) {
    const createdEpoch = parseCreatedEpoch(datname);
    if (
      createdEpoch !== null &&
      nowSeconds - createdEpoch < ORPHAN_MIN_AGE_SECONDS
    ) {
      continue; // Plausibly a live concurrent run's database — leave it.
    }
    try {
      await maintenance.unsafe(
        `DROP DATABASE IF EXISTS "${assertSafeIdentifier(datname)}"`,
      );
    } catch (error) {
      if ((error as { code?: string }).code !== OBJECT_IN_USE) throw error;
    }
  }
}

/**
 * The creation epoch a harness database name carries; null when the name
 * does not follow the scheme (treated as old — droppable). The tail is any
 * identifier, not just the per-file counter: the fresh-database migration
 * test names its database `test_<epoch>_<pid>_fresh`, and several
 * workspaces' integration suites run their globalSetup concurrently under
 * turbo, so a sweep that misparsed that name would drop a sibling run's
 * database between its CREATE and its first (lazy) connection.
 */
function parseCreatedEpoch(datname: string): number | null {
  const match = /^test_(\d{10,})_\d+_[a-z0-9]+$/.exec(datname);
  if (!match?.[1]) return null;
  const epoch = Number(match[1]);
  return Number.isFinite(epoch) ? epoch : null;
}
