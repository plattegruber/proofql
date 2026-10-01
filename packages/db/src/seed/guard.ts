/**
 * Safety guard for the seed CLI (#20): the seed deletes and recreates the
 * demo account, so it must be impossible to point it at a shared database
 * by accident. A `DATABASE_URL` whose host is not loopback is refused
 * unless `--force` is passed (a preview database is sometimes legitimately
 * reseeded, but only deliberately).
 *
 * Pure and synchronous so the unit suite covers every branch without a
 * database (`guard.test.ts`).
 */

/** Thrown when the guard refuses; the CLI prints `message` and exits 1. */
export class SeedGuardError extends Error {
  override readonly name = "SeedGuardError";
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface SeedGuardInput {
  databaseUrl: string;
  /** `--force` was passed. */
  force: boolean;
}

/** Throws {@link SeedGuardError} unless seeding this target is allowed. */
export function assertSeedTargetAllowed(input: SeedGuardInput): void {
  let host: string;
  try {
    host = new URL(input.databaseUrl).hostname;
  } catch {
    throw new SeedGuardError(
      "Refusing to seed: DATABASE_URL is not a parseable URL, so the " +
        "target cannot be verified as local.",
    );
  }

  if (!LOOPBACK_HOSTS.has(host) && !input.force) {
    throw new SeedGuardError(
      `Refusing to seed: DATABASE_URL points at "${host}", which is not ` +
        "a local database. The seed deletes and recreates the demo account. " +
        "Pass --force only if you are certain this target (e.g. a preview " +
        "database) should be reseeded.",
    );
  }
}
