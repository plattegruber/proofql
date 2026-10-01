/**
 * API keys for the ProofQL public API (issue #18; scope.md §3 "Keys").
 *
 * Two kinds, both per project, both prefixed so they are greppable and so a
 * leaked key's blast radius is obvious from its first characters:
 *
 * | Prefix                        | Kind        | Can                        | Lives in |
 * |-------------------------------|-------------|----------------------------|----------|
 * | `pq_sk_live_` / `pq_sk_test_` | secret      | ingest, manage, query      | servers  |
 * | `pq_pk_live_` / `pq_pk_test_` | publishable | query only, CORS-restricted| browsers |
 *
 * What every key guarantees:
 *
 * - **Show once.** The plaintext exists only in the create-response. The
 *   database stores `hash` (SHA-256 hex, the lookup column) and `prefix` (a
 *   display hint). It is never stored, logged, or retrievable afterward.
 * - **Unforgeable.** 32 base62 characters drawn uniformly from
 *   `crypto.getRandomValues` — about 190 bits of entropy.
 * - **Self-describing.** `parseApiKey` recovers `kind` and `environment` from
 *   the prefix alone, so auth middleware can reject malformed keys, and
 *   wrong-kind keys (a publishable key on an ingest route), before spending a
 *   digest or a database round-trip.
 *
 * Why plain SHA-256 and not bcrypt/scrypt/HMAC: slow password hashes exist to
 * resist offline brute force of LOW-entropy secrets. These keys carry ~190
 * bits of entropy, so brute force is moot, and verification needs a
 * deterministic O(1) UNIQUE-index lookup on `api_keys.key_hash` — the hot
 * path for every query the snippet makes. A salted or keyed hash would break
 * that lookup for zero security gain. Do not "upgrade" this.
 *
 * Why no constant-time comparison: verification never compares a presented
 * key against a stored one. It hashes the presented key and looks the digest
 * up by index equality. A timing side channel on SHA-256 digest equality
 * leaks nothing useful about the preimage, so `timingSafeEqual` has no role.
 *
 * Pure WebCrypto (`crypto.getRandomValues`, `crypto.subtle.digest`): this
 * module must run unchanged in Cloudflare Workers, Node >= 22, and Vitest.
 * Never import `node:crypto` here.
 */

/** The two key kinds. Secret keys do everything; publishable keys only query. */
export const API_KEY_KINDS = ["secret", "publishable"] as const;

export type ApiKeyKind = (typeof API_KEY_KINDS)[number];

/**
 * The two key environments. Test keys hit the same database with
 * `environment = 'test'` on every row, so a project can wipe test data
 * without touching live.
 */
export const API_KEY_ENVIRONMENTS = ["live", "test"] as const;

export type ApiKeyEnvironment = (typeof API_KEY_ENVIRONMENTS)[number];

/** Number of random base62 characters after the prefix. */
export const API_KEY_RANDOM_LENGTH = 32;

/**
 * How many random characters `GeneratedApiKey.prefix` keeps after the scheme
 * prefix. Four base62 characters (~24 of ~190 bits) are enough to tell a
 * project's keys apart in a list and leak nothing that matters.
 */
const PREFIX_DISPLAY_CHARS = 4;

/** Scheme prefix (`pq_sk_live_`) is 11 characters for every kind/environment. */
const SCHEME_PREFIX_LENGTH = "pq_sk_live_".length;

const KIND_TAGS = {
  secret: "sk",
  publishable: "pk",
} as const satisfies Record<ApiKeyKind, string>;

const KINDS_BY_TAG: Readonly<Record<string, ApiKeyKind | undefined>> = {
  sk: "secret",
  pk: "publishable",
};

const ENVIRONMENT_SET: ReadonlySet<string> = new Set(API_KEY_ENVIRONMENTS);

/**
 * The exact shape of every key this module mints:
 * `pq_(sk|pk)_(live|test)_` + 32 base62 characters.
 *
 * Auth middleware tests input against this BEFORE hashing — a cheap filter
 * that keeps garbage traffic from costing a digest and a DB lookup.
 */
export const API_KEY_PATTERN = new RegExp(
  `^pq_(sk|pk)_(live|test)_[0-9A-Za-z]{${API_KEY_RANDOM_LENGTH}}$`,
);

export interface GeneratedApiKey {
  /**
   * The full plaintext key, e.g. `pq_sk_live_…`. **Show once**: return it in
   * the create-response and let go — it must never be stored or logged.
   */
  plaintext: string;
  /** SHA-256 hex of `plaintext` — the only form the database ever sees. */
  hash: string;
  /**
   * Display hint for key lists: the scheme prefix plus the first four random
   * characters, e.g. `pq_sk_live_Ab3x`. Stored in `api_keys.prefix` so the
   * dashboard can show which key is which without the plaintext.
   */
  prefix: string;
  kind: ApiKeyKind;
  environment: ApiKeyEnvironment;
}

export interface ParsedApiKey {
  kind: ApiKeyKind;
  environment: ApiKeyEnvironment;
}

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Largest multiple of 62 that fits in a byte (62 * 4). Random bytes at or
 * above it are discarded so `byte % 62` is uniform rather than biased toward
 * the first eight characters of the alphabet.
 */
const BASE62_REJECT_FROM = 248;

function randomBase62(length: number): string {
  let out = "";
  // Oversample: ~3% of bytes are rejected, so 2x almost always needs one pass.
  const buffer = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte >= BASE62_REJECT_FROM) continue;
      out += BASE62_ALPHABET.charAt(byte % BASE62_ALPHABET.length);
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * SHA-256 hex of the full plaintext key — deterministic, unsalted, unkeyed,
 * for the UNIQUE-index lookup on `api_keys.key_hash`. See the module doc
 * comment for why this is correct and must not become a salted hash.
 */
export async function hashApiKey(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Mint a new key: `pq_<sk|pk>_<environment>_` + 32 uniformly random base62
 * characters. Returns the plaintext exactly once, alongside the `hash` and
 * `prefix` the caller persists instead.
 */
export async function generateApiKey(options: {
  kind: ApiKeyKind;
  environment: ApiKeyEnvironment;
}): Promise<GeneratedApiKey> {
  const { kind, environment } = options;
  const plaintext = `pq_${KIND_TAGS[kind]}_${environment}_${randomBase62(API_KEY_RANDOM_LENGTH)}`;
  return {
    plaintext,
    hash: await hashApiKey(plaintext),
    prefix: plaintext.slice(0, SCHEME_PREFIX_LENGTH + PREFIX_DISPLAY_CHARS),
    kind,
    environment,
  };
}

/**
 * Recover `kind` and `environment` from a presented key without touching the
 * database. Returns `null` for anything that does not match
 * `API_KEY_PATTERN` exactly (no `Bearer ` prefix, no whitespace, no wrong
 * alphabet), so middleware can answer 401 before hashing or querying.
 */
export function parseApiKey(plaintext: string): ParsedApiKey | null {
  const match = API_KEY_PATTERN.exec(plaintext);
  if (match === null) return null;
  const tag = match[1];
  const environment = match[2];
  if (tag === undefined || environment === undefined) return null;
  const kind = KINDS_BY_TAG[tag];
  if (kind === undefined || !ENVIRONMENT_SET.has(environment)) return null;
  return { kind, environment: environment as ApiKeyEnvironment };
}
