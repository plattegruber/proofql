/**
 * Shared plumbing for the DB test harness — everything both
 * `globalSetup.ts` and `harness.ts` need, with **no vitest imports**
 * (globalSetup runs outside the test runner and must not pull in vitest's
 * test APIs).
 *
 * Isolation strategy: one fully migrated template database, cloned per test
 * file with `CREATE DATABASE ... TEMPLATE proofql_template`. A clone takes
 * milliseconds, carries the pgvector extension and the generated `tsv`
 * column exactly as the migration created them, and is dropped when the
 * file finishes, so test files never see each other's rows and never need
 * cleanup code.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MIGRATIONS_DIR } from "../scripts/migrate.js";

export { MIGRATIONS_DIR };

/** The fully migrated template every test database is cloned from. */
export const TEMPLATE_DB = "proofql_template";

/**
 * Maintenance database for CREATE/DROP DATABASE — never the template (a
 * connection to the template blocks cloning) and never a database we drop.
 * `postgres` always exists on the official images and on CI services.
 */
export const MAINTENANCE_DB = "postgres";

/** `55006` — "source database is being accessed by other users". */
export const OBJECT_IN_USE = "55006";

/**
 * DATABASE_URL, asserted loudly. Integration tests never skip — a missing
 * database is a failure, not zero tests executed (CONTRIBUTING "Tests").
 */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL must be set to run integration tests " +
        "(local compose default: postgres://proofql:proofql@localhost:54322/proofql). " +
        "Integration tests never skip — a missing database is a failure.",
    );
  }
  return url;
}

/** The same connection string pointed at a different database. */
export function withDatabase(connectionString: string, dbName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/**
 * Guard for identifiers interpolated into DDL that takes no bind parameters
 * (CREATE/DROP DATABASE). Every name we generate matches; anything else is
 * a bug, not input to escape.
 */
export function assertSafeIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe database identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Deterministic fingerprint of the migrations folder (every `*.sql` plus
 * the drizzle journal and snapshots). Stored as a COMMENT on the template
 * database; a mismatch means the template is stale and gets rebuilt.
 */
export function migrationsHash(): string {
  const hash = createHash("sha256");
  for (const relative of listFilesRecursively(MIGRATIONS_DIR).sort()) {
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(join(MIGRATIONS_DIR, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listFilesRecursively(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), {
    withFileTypes: true,
  })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(dir, relative));
    } else {
      files.push(relative);
    }
  }
  return files;
}

/**
 * Extract the Postgres error code and message from anything a query path
 * throws. drizzle-orm wraps driver errors in DrizzleQueryError with the
 * postgres-js PostgresError on `cause`, so both layers are checked.
 */
export function pgErrorInfo(error: unknown): { code: string; message: string } {
  const e = error as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  return {
    code: e.code ?? e.cause?.code ?? "",
    message: [e.message, e.cause?.message].filter(Boolean).join(" | "),
  };
}

/**
 * Await a promise expected to reject with a Postgres error; returns the
 * error code and message (or `code: "no error thrown"`). The idiom every
 * constraint test in this package asserts with.
 */
export async function pgError(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return pgErrorInfo(error);
  }
  return { code: "no error thrown", message: "" };
}

/** Postgres SQLSTATE codes the schema tests assert on. */
export const UNIQUE_VIOLATION = "23505";
export const FOREIGN_KEY_VIOLATION = "23503";
export const CHECK_VIOLATION = "23514";
export const INVALID_TEXT_REPRESENTATION = "22P02";
