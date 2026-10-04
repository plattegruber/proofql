/**
 * KV cache for the resolved API key (#108): the `AuthContext` that
 * `requireApiKey` builds from the `api_keys ⨝ projects ⨝ accounts` lookup,
 * stored for `AUTH_CACHE_TTL_SECONDS` under the key's SHA-256 hash, so a
 * request whose results are also in the query cache opens **no** Postgres
 * connection at all. Before this, a cache HIT still cost one connection and
 * two transactions (the key lookup and the usage upsert), which is what made
 * the query path's ceiling a connection ceiling (docs/performance.md §3, §5).
 *
 * ## Key and value
 *
 * ```
 * auth:<sha256 hex of the plaintext key>  →  { v, auth, lastUsedAt, generation, storedAt }
 * ```
 *
 * The hash is the same value as `api_keys.key_hash`; no plaintext ever
 * reaches KV, and the entry carries nothing the database row does not. KV's
 * minimum `expirationTtl` is 60 s, which is also the TTL — the entry is
 * meant to be short-lived, not a second source of truth.
 *
 * ## Invalidation
 *
 * The entry stores the project's cache generation (`@proofql/core`
 * cache-generation) at the time of the lookup; `requireApiKey` compares it
 * with the current `gen:<projectId>` — which the query route needs anyway
 * for its own cache key, so the read is shared, not added — and treats a
 * mismatch as a miss. Anything that bumps the generation therefore also
 * refreshes the cached auth: a policy change (`min_rating`,
 * `similarity_floor`), a key revocation and an allowed-origins edit (the
 * dashboard bumps after each, #108), index completion, review CRUD.
 *
 * What that leaves is the window: a revoked key keeps authenticating on
 * `/v1/query` until the bump is visible in the serving colo (KV is
 * eventually consistent, up to 60 s) or the entry expires (60 s), whichever
 * comes first — call it a minute, never more than two. That is acceptable
 * because the cache is used **only on `/v1/query`** (`requireQueryKey`):
 * a key that is stale here can read a project's publishable reviews, which
 * a publishable key publishes to every visitor of the customer's site
 * anyway, and never write. Write routes resolve the key from the database
 * on every request, so a revoked secret key cannot ingest, edit or delete
 * one second longer than before. Plan changes lag the same minute (the
 * badge flips with the next lookup). docs/security.md §6 records the window.
 *
 * ## Failure
 *
 * A KV read or write that throws is logged (`auth.cache_error`) and the
 * request falls through to the database lookup: the cache can slow auth
 * down, never take it down — the same rule the query cache follows.
 */

import { API_KEY_ENVIRONMENTS, API_KEY_KINDS, isPlan } from "@proofql/core";

import type { AuthContext } from "./bindings.js";

/** KV's minimum TTL, and the revocation window the module doc describes. */
export const AUTH_CACHE_TTL_SECONDS = 60;

/** The slice of `KVNamespace` this module uses; tests pass a Map-backed fake. */
export interface AuthCacheStore {
  get(key: string, type: "text"): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

export interface AuthCacheEntry {
  /** Shape version; an unknown version is a miss. */
  v: 1;
  auth: AuthContext;
  /** ISO 8601, or null: `api_keys.last_used_at` as of the lookup. */
  lastUsedAt: string | null;
  /** The project's cache generation when the lookup ran (module doc). */
  generation: number;
  /** ISO 8601; diagnostic. */
  storedAt: string;
}

/** `auth:<key hash>` — the hash is `api_keys.key_hash`, never the plaintext. */
export function authCacheKey(keyHash: string): string {
  return `auth:${keyHash}`;
}

/**
 * The cached entry for a key hash, or null for a miss or an entry that does
 * not parse as a current `AuthCacheEntry` (a stale shape is a miss, never
 * trusted).
 */
export async function getCachedAuth(
  kv: AuthCacheStore,
  keyHash: string,
): Promise<AuthCacheEntry | null> {
  const raw = await kv.get(authCacheKey(keyHash), "text");
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isAuthCacheEntry(parsed) ? parsed : null;
}

/** Store a freshly looked-up key for `AUTH_CACHE_TTL_SECONDS`. */
export async function putCachedAuth(
  kv: AuthCacheStore,
  keyHash: string,
  entry: Omit<AuthCacheEntry, "v" | "storedAt">,
  options: { now?: Date; ttlSeconds?: number } = {},
): Promise<void> {
  const stored: AuthCacheEntry = {
    v: 1,
    auth: entry.auth,
    lastUsedAt: entry.lastUsedAt,
    generation: entry.generation,
    storedAt: (options.now ?? new Date()).toISOString(),
  };
  await kv.put(authCacheKey(keyHash), JSON.stringify(stored), {
    expirationTtl: options.ttlSeconds ?? AUTH_CACHE_TTL_SECONDS,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Structural check of a stored entry — every field the request will trust. */
export function isAuthCacheEntry(value: unknown): value is AuthCacheEntry {
  if (!isRecord(value) || value.v !== 1) return false;
  if (
    !(typeof value.lastUsedAt === "string" || value.lastUsedAt === null) ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    typeof value.storedAt !== "string"
  ) {
    return false;
  }
  const auth = value.auth;
  if (!isRecord(auth) || !isRecord(auth.project)) return false;
  const { project } = auth;
  return (
    typeof auth.apiKeyId === "string" &&
    typeof auth.projectId === "string" &&
    typeof auth.environment === "string" &&
    (API_KEY_ENVIRONMENTS as readonly string[]).includes(auth.environment) &&
    typeof auth.kind === "string" &&
    (API_KEY_KINDS as readonly string[]).includes(auth.kind) &&
    typeof auth.plan === "string" &&
    isPlan(auth.plan) &&
    isStringArray(project.allowedOrigins) &&
    typeof project.minRating === "number" &&
    typeof project.similarityFloor === "number"
  );
}
