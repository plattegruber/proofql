/**
 * Cache for the resolved API key (#108, moved off KV in #158): the
 * `AuthContext` that `requireApiKey` builds from the `api_keys ⨝ projects ⨝
 * accounts` lookup, kept under the key's SHA-256 hash so a request whose
 * results are also cached opens **no** Postgres connection at all.
 *
 * ## Where entries live
 *
 * 1. **In the isolate** (`LruTtl`, up to `AUTH_LRU_MAX` keys). Free, and
 *    under steady traffic an isolate serves most requests for a key.
 * 2. **The Workers Cache API** on a custom domain (src/edge-cache.ts), so
 *    a fresh isolate in the same data center finds the entry too.
 *
 * Never KV. Until #158 the entry was written to KV once a minute per key,
 * and on the Workers Free plan (1,000 KV writes a day) that alone could
 * spend the day's writes. On `*.workers.dev`, where the Cache API is a
 * no-op, the isolate map is the whole cache: each isolate looks a busy key
 * up once a minute, a few Postgres statements an hour per isolate.
 *
 * ## Key and value
 *
 * ```
 * <origin>/__proofql_cache/auth/<sha256 hex of the plaintext key>
 *   →  { v, auth, lastUsedAt, generation, storedAt }
 * ```
 *
 * The hash is the same value as `api_keys.key_hash`; no plaintext is ever
 * stored, and the entry carries nothing the database row does not.
 *
 * ## Freshness and invalidation
 *
 * An entry is **fresh** for `AUTH_CACHE_TTL_SECONDS` (60 s) after the
 * lookup that produced it, and carries the project's cache generation
 * (`@proofql/core` cache-generation) as of that lookup. `requireApiKey`
 * trusts a fresh entry only while that generation is still current — the
 * read is shared with the query cache — so anything that bumps the
 * generation ends it: a key revocation, a policy or allowed-origins edit
 * (the dashboard bumps after each), index completion, review CRUD.
 *
 * The window that leaves: a revoked key keeps authenticating on
 * `/v1/query` until the bump is visible here (KV propagation, up to 60 s,
 * plus the api's 10 s generation memo) or the entry stops being fresh
 * (60 s), whichever is first — about a minute, never more than ~70 s.
 * When the generation cannot be read at all (KV fault or daily limit) a
 * fresh entry is trusted on its age alone, which is the same 60 s bound.
 * That is acceptable because the cache is used **only on `/v1/query`**
 * (`requireQueryKey`): a key that is stale here can read a project's
 * publishable reviews, which a publishable key publishes to every visitor
 * anyway, and never write. docs/security.md §6 records the window.
 *
 * ## Stale-if-error
 *
 * An entry is kept for `AUTH_STALE_SECONDS` (1 h) past its lookup. A
 * non-fresh entry is used **only** when the database lookup fails as
 * unavailable — a connection failure or Hyperdrive's daily query limit
 * (src/db.ts `isDatabaseFailure`) — and only when its generation is still
 * current (or unreadable). On the free plan that is what keeps cached
 * answers flowing for every tenant after Hyperdrive's 100,000 daily queries
 * are spent; a revocation cannot happen during such an outage anyway, since
 * the dashboard needs the same database to revoke.
 *
 * ## Failure
 *
 * A Cache API fault is logged (`auth.cache_error`) and treated as a miss.
 */

import { API_KEY_ENVIRONMENTS, API_KEY_KINDS, isPlan } from "@proofql/core";
import type { Context } from "hono";

import type { AppEnv, AuthContext } from "./bindings.js";
import { waitUntil } from "./db.js";
import { edgeCacheFor, edgeCacheUrl, LruTtl } from "./edge-cache.js";
import { logFor } from "./request-id.js";

/** How long a looked-up key is trusted without a lookup (module doc). */
export const AUTH_CACHE_TTL_SECONDS = 60;

/** How long an entry is kept for stale-if-error (module doc). */
export const AUTH_STALE_SECONDS = 60 * 60;

/** Keys kept per isolate. */
export const AUTH_LRU_MAX = 2_000;

/** Generation recorded when it could not be read at lookup time. */
export const UNKNOWN_GENERATION = -1;

export interface AuthCacheEntry {
  /** Shape version; an unknown version is a miss. */
  v: 1;
  auth: AuthContext;
  /** ISO 8601, or null: `api_keys.last_used_at` as of the lookup. */
  lastUsedAt: string | null;
  /** The project's cache generation when the lookup ran, or -1 (unknown). */
  generation: number;
  /** ISO 8601: when the lookup ran; freshness is measured from it. */
  storedAt: string;
}

/** The per-app (per-isolate) store; `createApp` makes one, tests may share one. */
export class AuthCache {
  readonly lru: LruTtl<AuthCacheEntry>;
  readonly now: () => number;

  constructor(options: { max?: number; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.lru = new LruTtl(options.max ?? AUTH_LRU_MAX, this.now);
  }

  /** Age of `entry` in ms against this cache's clock. */
  ageMs(entry: AuthCacheEntry): number {
    return this.now() - Date.parse(entry.storedAt);
  }

  /** Whether `entry` is still within `AUTH_CACHE_TTL_SECONDS`. */
  isFresh(entry: AuthCacheEntry): boolean {
    const age = this.ageMs(entry);
    return age >= 0 && age < AUTH_CACHE_TTL_SECONDS * 1000;
  }
}

/**
 * The cached entry for a key hash — isolate first, then the Cache API —
 * or null. An entry that does not parse as a current `AuthCacheEntry`, or
 * is past the stale window, is a miss.
 */
export async function getCachedAuth(
  c: Context<AppEnv>,
  keyHash: string,
): Promise<AuthCacheEntry | null> {
  const cache = c.get("authCache");
  const local = cache.lru.get(keyHash, AUTH_STALE_SECONDS * 1000);
  if (local !== undefined) return local.value;

  const edge = edgeCacheFor(c);
  if (edge === null) return null;
  try {
    const res = await edge.match(edgeCacheUrl(c.req.url, "auth", keyHash));
    if (res === undefined) return null;
    const parsed: unknown = await res.json();
    if (!isAuthCacheEntry(parsed)) return null;
    const age = cache.ageMs(parsed);
    if (!(age >= 0 && age < AUTH_STALE_SECONDS * 1000)) return null;
    cache.lru.set(keyHash, parsed, Date.parse(parsed.storedAt));
    return parsed;
  } catch (error) {
    logAuthCacheError(c, "get", error);
    return null;
  }
}

/**
 * Store a freshly looked-up key in the isolate and, on a custom domain,
 * in the Cache API (after the response, via `waitUntil`).
 */
export function putCachedAuth(
  c: Context<AppEnv>,
  keyHash: string,
  entry: Omit<AuthCacheEntry, "v" | "storedAt">,
): void {
  const cache = c.get("authCache");
  const now = cache.now();
  const stored: AuthCacheEntry = {
    v: 1,
    auth: entry.auth,
    lastUsedAt: entry.lastUsedAt,
    generation: entry.generation,
    storedAt: new Date(now).toISOString(),
  };
  cache.lru.set(keyHash, stored, now);

  const edge = edgeCacheFor(c);
  if (edge === null) return;
  waitUntil(
    c,
    edge
      .put(
        edgeCacheUrl(c.req.url, "auth", keyHash),
        new Response(JSON.stringify(stored), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `max-age=${AUTH_STALE_SECONDS}`,
          },
        }),
      )
      .catch((error: unknown) => logAuthCacheError(c, "put", error)),
  );
}

/** Forget a key in this isolate (an entry a generation bump retired). */
export function dropCachedAuth(c: Context<AppEnv>, keyHash: string): void {
  c.get("authCache").lru.delete(keyHash);
}

/** A Cache API fault on the auth cache is a database lookup, not a failure: warn. */
function logAuthCacheError(
  c: Context<AppEnv>,
  op: "get" | "put",
  error: unknown,
): void {
  logFor(c).log("auth.cache_error", { level: "warn", op, error });
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
    value.generation < UNKNOWN_GENERATION ||
    typeof value.storedAt !== "string" ||
    Number.isNaN(Date.parse(value.storedAt))
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
