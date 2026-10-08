/**
 * Fixed constants for the demo seed (#20).
 *
 * SEED CONTRACT: integration tests and the playground import the fixtures
 * and rely on exactly this dataset. Any change to what the seed produces —
 * review texts, counts, keys, metadata, the project's policy columns — is a
 * change to that contract. Bump {@link SEED_VERSION} with it and call the
 * bump out in the PR description.
 */

import type { BusinessCategory } from "@proofql/core";

/**
 * Version of the demo dataset. Bump on ANY change to what the seed
 * produces. It is written into the demo account's name
 * (`"ProofQL Demo (seed v3)"`) so `SELECT name FROM accounts` on any local
 * database tells you which fixture set it holds without reading the code.
 *
 * v1 (#20): Cedar Ridge Dental — 80 live reviews (56 google, 14 yelp,
 * 10 custom; rating-skewed, 11 rated 1–3, 5 unrated of which 2 negative),
 * 10 test reviews, deterministic full + window chunks embedded with
 * `fakeEmbed`.
 *
 * v2 (#69): same reviews, chunked with the pipeline's `chunkReview` from
 * `@proofql/core` instead of the seed-only splitter. That chunker did not
 * yet merge honorifics ("Dr." is a sentence to UAX #29), so more reviews
 * crossed the four-sentence threshold: 49 window chunks over 19 reviews,
 * up from 30 over 11.
 *
 * v3 (#77): same reviews; `chunkReview` now rejoins abbreviations ("Dr.",
 * "St.", "e.g.") and initials with the sentence that follows, so the
 * chunker's sentence count matches a reader's again: 30 window chunks over
 * 11 reviews (10 live, 1 test), none ending in a bare "Dr.".
 *
 * v4 (#35): same reviews; `http://localhost:8800` (the local cdn worker,
 * which serves the hosted demo page at `/demo/`) added to the project's
 * allowed origins.
 *
 * v5 (#127): same reviews; `chunkReview` now also emits one `sentence`
 * chunk per sentence for reviews of two or more sentences, so highlights
 * are sentence-precise: 90 full + 30 window + 236 sentence chunks (live:
 * 80 / 28 / 218; test: 10 / 2 / 18), sentence chunks on 87 of the 90
 * reviews (the other three are single sentences).
 *
 * v6 (#138): same reviews and chunks; the demo project's
 * `similarity_floor` is now 0.66 (it takes the column default, which
 * migration 0009 moved from 0.55 with `DEFAULT_SIMILARITY_FLOOR`), and the
 * search holds full-text matches to the lower word-match tier (0.53). The
 * fake-embedded local corpus answers fewer loosely worded queries than at
 * v5; the cdn demo page's three queries still clear (0.754 / 0.798 / 0.775).
 *
 * v7 (#151): same reviews and chunks; the demo project's `category` is
 * `dental` ({@link DEMO_PROJECT_CATEGORY}), so its generic query words
 * keep "dental", "dentist" and "teeth" now that they come from the
 * category instead of a constant (migration 0010 sets the same value on
 * an already-seeded database).
 */
export const SEED_VERSION = 7;

/** The demo project's business category (#151); a `CATEGORY_TABLE` key. */
export const DEMO_PROJECT_CATEGORY: BusinessCategory = "dental";

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

/**
 * The local dashboard (8799), the local cdn worker whose `/demo/` page is
 * the hosted demo (8800, #35), and a generic dev server (3000).
 */
export const DEMO_ALLOWED_ORIGINS = [
  "http://localhost:8799",
  "http://localhost:8800",
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
