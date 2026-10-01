/**
 * Fixed constants for the demo seed (#20).
 *
 * SEED CONTRACT: integration tests and the playground import the fixtures
 * and rely on exactly this dataset. Any change to what the seed produces —
 * review texts, counts, keys, metadata, the project's policy columns — is a
 * change to that contract. Bump {@link SEED_VERSION} with it and call the
 * bump out in the PR description.
 */

/**
 * Version of the demo dataset. Bump on ANY change to what the seed
 * produces. It is written into the demo account's name
 * (`"ProofQL Demo (seed v1)"`) so `SELECT name FROM accounts` on any local
 * database tells you which fixture set it holds without reading the code.
 *
 * v1 (#20): Cedar Ridge Dental — 80 live reviews (56 google, 14 yelp,
 * 10 custom; rating-skewed, 11 rated 1–3, 5 unrated of which 2 negative),
 * 10 test reviews, deterministic full + window chunks embedded with
 * `fakeEmbed`.
 */
export const SEED_VERSION = 1;

/**
 * Natural key of the demo account. The wipe step finds any previous seed
 * run through it, so it must stay stable across seed versions.
 */
export const DEMO_ACCOUNT_CLERK_ORG_ID = "org_demo_proofql";
export const DEMO_ACCOUNT_NAME = "ProofQL Demo";

/**
 * Fixed primary keys so the playground and tests can address the demo
 * tenant without a lookup. Well-formed v4-shaped UUIDs that no
 * `gen_random_uuid()` will ever collide with in practice.
 */
export const DEMO_ACCOUNT_ID = "de300000-0000-4000-8000-000000000001";
export const DEMO_PROJECT_ID = "de300000-0000-4000-8000-000000000002";

export const DEMO_PROJECT_NAME = "Cedar Ridge Dental";
export const DEMO_PROJECT_SLUG = "cedar-ridge-dental";

/** The local dashboard (8799) and a generic dev server (3000). */
export const DEMO_ALLOWED_ORIGINS = [
  "http://localhost:8799",
  "http://localhost:3000",
] as const;

/**
 * Every `occurred_at` is computed from this anchor minus the fixture's
 * `daysAgo` — never from `new Date()` — so the corpus is identical on every
 * machine and every run. Reviews span the 18 months before it.
 */
export const SEED_ANCHOR = new Date("2026-09-28T17:00:00Z");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Tiny deterministic string hash (FNV-1a) used only to scatter the
 * time-of-day of `occurred_at` so 80 reviews do not all land at 17:00.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * `SEED_ANCHOR` minus `daysAgo` whole days, shifted by a deterministic
 * number of minutes derived from `key` (within ±6 hours of the anchor's
 * time of day).
 */
export function occurredAtFor(key: string, daysAgo: number): Date {
  const minutes = (fnv1a(key) % (12 * 60)) - 6 * 60;
  return new Date(SEED_ANCHOR.getTime() - daysAgo * DAY_MS + minutes * 60_000);
}

/** Canonical local connection string — docker-compose.yml / scripts/setup.sh. */
export const LOCAL_DATABASE_URL =
  "postgres://proofql:proofql@localhost:54323/proofql";
