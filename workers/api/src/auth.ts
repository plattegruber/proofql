/**
 * Bearer auth for the public API (scope.md §3 "Keys").
 *
 *   Authorization: Bearer pq_sk_live_…
 *
 * Order of checks, cheapest first:
 *
 *   1. header present and shaped `Bearer <key>`      → else 401
 *      (`keyParam` routes also take a publishable key from `?key=`)
 *   2. key matches API_KEY_PATTERN (`parseApiKey`)   → else 401, no DB work
 *   3. route needs a secret key and this is `pq_pk_` → 403, still no DB work
 *   4. SHA-256 → `api_keys.key_hash`, not revoked    → else 401
 *
 * The resolved key's `environment` is attached to the context and scopes
 * every row the request touches; a test key can never read or write live
 * rows. Steps 1–3 need no database, which keeps garbage and misconfigured
 * traffic from costing a digest or a round-trip.
 *
 * Step 4 joins `projects` and `accounts`, so the context also carries the
 * project's publication policy and CORS allowlist (`ProjectPolicy`) and the
 * account's plan: the query route reads policy exactly once per request, in
 * the same statement as the key, and never again downstream, and every
 * plan-driven decision (badge, rate limit, quota) starts from `auth.plan`.
 *
 * `?key=` (the query route only): a `GET /v1/query?key=pq_pk_…&q=…` with no
 * custom headers is a CORS "simple request", so the snippet's browser sends
 * it with no preflight at all — and when a preflight does happen, browsers
 * strip `Authorization` from it, so the URL is the only place a key can
 * ride. Secret keys are never accepted from the URL: URLs land in logs and
 * referrers. The Authorization header wins when both are present.
 *
 * `?key=` is accepted on **GET only** (#91). The snippet never POSTs, a
 * POST already needs a request body and so can carry a header, and a key in
 * a POST URL is surface with no caller — so a `POST /v1/query?key=…` is a
 * 401 that points at the Authorization header, before any lookup. The CORS
 * preflight (`OPTIONS`) reads `?key=` through `presentedToken` because the
 * snippet's URL is the only place a preflight can see a key.
 *
 * Once the key is known the request is counted against its per-key rate
 * limit (`enforceRateLimit`, src/rate-limit.ts) — here rather than per
 * route, so no route can forget it.
 *
 * `last_used_at` is refreshed at most once per key per minute, after the
 * response, via `waitUntil` — a dashboard hint, never on the hot path.
 *
 * **Auth cache (#108, #158).** With `{ cache: true }` — `/v1/query` and its
 * preflight only — step 4 is answered from the auth cache when it can be
 * (src/auth-cache.ts): the resolved context is kept in the isolate and, on a
 * custom domain, in the Workers Cache API, under the key hash, together
 * with the project's cache generation. An entry is trusted for 60 s and
 * only while that generation is still current, so a revocation, a policy
 * or allowlist change (each bumps the generation) or the TTL ends it. When
 * the database cannot be reached (or Hyperdrive's daily quota is spent) an
 * entry up to an hour old stands in — "stale-if-error" — so cached answers
 * keep flowing. A request answered from the auth cache *and* the query
 * cache opens no database connection at all (docs/performance.md §6). The
 * generation read is shared with the query cache through
 * `c.get("projectGeneration")`. Write routes never use it: a revoked secret
 * key cannot write for one second longer than before. The `last_used_at`
 * refresh runs only on a database lookup, which under steady traffic is
 * once a minute per isolate.
 */

import {
  type ApiKeyKind,
  hashApiKey,
  normalizePlan,
  type ParsedApiKey,
  parseApiKey,
} from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import {
  type AuthCacheEntry,
  dropCachedAuth,
  getCachedAuth,
  putCachedAuth,
  UNKNOWN_GENERATION,
} from "./auth-cache.js";
import type { AppEnv, AuthContext } from "./bindings.js";
import { isDatabaseFailure, waitUntil } from "./db.js";
import { readGeneration } from "./edge-cache.js";
import { ApiError } from "./errors.js";
import { enforceRateLimit } from "./rate-limit.js";
import { logFor } from "./request-id.js";

/** How stale `last_used_at` may be before a request refreshes it. */
export const LAST_USED_REFRESH_MS = 60_000;

export interface RequireApiKeyOptions {
  /** Require this kind; publishable keys get 403 on `secret` routes. */
  kind?: ApiKeyKind;
  /**
   * Also accept a *publishable* key from `?key=` on a GET with no
   * Authorization header (module doc). Only `/v1/query` turns this on; on
   * any other method a `?key=` is refused with 401.
   */
  keyParam?: boolean;
  /**
   * Resolve the key through the auth cache (module doc "Auth cache").
   * Read-only routes only: a cached entry can outlive a revocation by up to
   * a minute, which is acceptable for reading publishable reviews and for
   * nothing else.
   */
  cache?: boolean;
}

const USAGE_HINT = "Send `Authorization: Bearer <api key>`.";
const KEY_PARAM_HINT =
  "Send `Authorization: Bearer <api key>`, or a publishable key as `?key=pq_pk_…`.";
const KEY_PARAM_GET_ONLY =
  "`?key=` is accepted on GET /v1/query only. Send `Authorization: Bearer <api key>` instead.";

/** Pull the key out of the header, or null when the header is not Bearer. */
export function extractBearerToken(
  authorization: string | undefined,
): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  return match?.[1] ?? null;
}

/** The plaintext key a request presents and where it came from, or null. */
export interface PresentedToken {
  token: string;
  fromUrl: boolean;
}

/**
 * Non-throwing lookup of the presented key for callers that must not fail
 * on a bad credential (the CORS preflight): the Authorization header if
 * present (null when it is not Bearer), else `?key=`.
 */
export function presentedToken(c: Context<AppEnv>): PresentedToken | null {
  const header = c.req.header("authorization");
  if (header !== undefined) {
    const token = extractBearerToken(header);
    return token === null ? null : { token, fromUrl: false };
  }
  const param = c.req.query("key");
  return param ? { token: param, fromUrl: true } : null;
}

export interface LookedUpKey {
  auth: AuthContext;
  lastUsedAt: Date | null;
}

/**
 * Hash and look up a plaintext key with its project's policy. Null for a
 * malformed, unknown, or revoked key — callers do not learn which.
 */
export async function lookupApiKey(
  db: Db,
  token: string,
): Promise<LookedUpKey | null> {
  const parsed = parseApiKey(token);
  if (parsed === null) return null;
  return lookupApiKeyByHash(db, parsed, await hashApiKey(token));
}

/** The database half of `lookupApiKey`, for a key already parsed and hashed. */
async function lookupApiKeyByHash(
  db: Db,
  parsed: ParsedApiKey,
  keyHash: string,
): Promise<LookedUpKey | null> {
  const { apiKeys, projects, accounts } = schema;
  const [row] = await db
    .select({
      id: apiKeys.id,
      projectId: apiKeys.projectId,
      kind: apiKeys.kind,
      environment: apiKeys.environment,
      lastUsedAt: apiKeys.lastUsedAt,
      allowedOrigins: projects.allowedOrigins,
      minRating: projects.minRating,
      similarityFloor: projects.similarityFloor,
      category: projects.category,
      plan: accounts.plan,
    })
    .from(apiKeys)
    .innerJoin(projects, eq(projects.id, apiKeys.projectId))
    .innerJoin(accounts, eq(accounts.id, projects.accountId))
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);

  // A stored row whose kind/environment disagree with its own prefix is
  // corrupt; treat it as unknown rather than trust either side.
  if (
    row === undefined ||
    row.kind !== parsed.kind ||
    row.environment !== parsed.environment
  ) {
    return null;
  }
  return {
    auth: {
      apiKeyId: row.id,
      projectId: row.projectId,
      environment: row.environment,
      kind: row.kind,
      plan: normalizePlan(row.plan),
      project: {
        allowedOrigins: row.allowedOrigins,
        minRating: row.minRating,
        similarityFloor: row.similarityFloor,
        category: row.category,
      },
    },
    lastUsedAt: row.lastUsedAt,
  };
}

/** What `resolveApiKey` found, and where. */
export interface ResolvedKey extends LookedUpKey {
  /**
   * `cache` when the auth cache answered with a fresh entry, `stale` when
   * the database was down and a stale entry stood in (src/auth-cache.ts
   * "Stale-if-error"), `db` after a lookup.
   */
  source: "cache" | "stale" | "db";
}

/**
 * Resolve a well-formed plaintext key: through the auth cache when
 * `options.cache` is set and the entry is fresh and current (module doc
 * "Auth cache"), else from the database, storing the result for the next
 * request. Null for an unknown or revoked key. Sets
 * `c.get("projectGeneration")` whenever the generation was read, so the
 * query cache need not read it again; leaves it unset when KV could not be
 * read, which makes the query uncachable for this request.
 */
export async function resolveApiKey(
  c: Context<AppEnv>,
  parsed: ParsedApiKey,
  token: string,
  options: { cache?: boolean } = {},
): Promise<ResolvedKey | null> {
  const keyHash = await hashApiKey(token);
  if (!options.cache) {
    const found = await lookupApiKeyByHash(c.get("getDb")(), parsed, keyHash);
    return found === null ? null : { ...found, source: "db" };
  }

  const cache = c.get("authCache");
  let stale: AuthCacheEntry | null = null;
  let generation: number | null | undefined;
  const cached = await getCachedAuth(c, keyHash);
  if (
    cached !== null &&
    cached.auth.kind === parsed.kind &&
    cached.auth.environment === parsed.environment
  ) {
    generation = await readGeneration(c, cached.auth.projectId);
    if (generation !== null) c.set("projectGeneration", generation);
    // A bump since the lookup retires the entry, fresh or not. An
    // unreadable generation leaves only the entry's age as the bound.
    const current = generation === null || generation === cached.generation;
    if (current && cache.isFresh(cached)) {
      return fromEntry(cached, "cache");
    }
    if (current) stale = cached;
    else dropCachedAuth(c, keyHash);
  }

  let found: LookedUpKey | null;
  try {
    found = await lookupApiKeyByHash(c.get("getDb")(), parsed, keyHash);
  } catch (error) {
    if (stale !== null && isDatabaseFailure(error)) {
      logFor(c).log("auth.stale_served", {
        level: "warn",
        project_id: stale.auth.projectId,
        age_s: Math.round(cache.ageMs(stale) / 1000),
        error,
      });
      return fromEntry(stale, "stale");
    }
    throw error;
  }
  if (found === null) {
    dropCachedAuth(c, keyHash);
    return null;
  }

  if (
    generation === undefined ||
    cached?.auth.projectId !== found.auth.projectId
  ) {
    generation = await readGeneration(c, found.auth.projectId);
    if (generation !== null) c.set("projectGeneration", generation);
  }
  putCachedAuth(c, keyHash, {
    auth: found.auth,
    lastUsedAt: found.lastUsedAt?.toISOString() ?? null,
    generation: generation ?? UNKNOWN_GENERATION,
  });
  return { ...found, source: "db" };
}

function fromEntry(
  entry: AuthCacheEntry,
  source: "cache" | "stale",
): ResolvedKey {
  return {
    auth: entry.auth,
    lastUsedAt: entry.lastUsedAt === null ? null : new Date(entry.lastUsedAt),
    source,
  };
}

/**
 * Authenticate the request and set `c.get("auth")`. With `{ kind: "secret" }`
 * a publishable key is refused with 403 before the database is consulted.
 */
export function requireApiKey(options: RequireApiKeyOptions = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("authorization");
    // A key in the URL of anything but a GET is refused outright — even
    // beside a valid header — so the pattern never takes root (module doc).
    const keyParam = options.keyParam ? c.req.query("key") : undefined;
    const keyParamAllowed = options.keyParam && c.req.method === "GET";
    if (keyParam !== undefined && keyParam !== "" && !keyParamAllowed) {
      throw new ApiError("unauthorized", KEY_PARAM_GET_ONLY);
    }
    let token: string;
    let fromUrl = false;
    if (header !== undefined) {
      const bearer = extractBearerToken(header);
      if (bearer === null) {
        throw new ApiError(
          "unauthorized",
          `Authorization header is not a Bearer token. ${USAGE_HINT}`,
        );
      }
      token = bearer;
    } else {
      if (keyParam === undefined || keyParam === "") {
        throw new ApiError(
          "unauthorized",
          `Missing Authorization header. ${keyParamAllowed ? KEY_PARAM_HINT : USAGE_HINT}`,
        );
      }
      token = keyParam;
      fromUrl = true;
    }
    const parsed = parseApiKey(token);
    if (parsed === null) {
      throw new ApiError(
        "unauthorized",
        "Malformed API key. Keys look like pq_sk_live_… or pq_pk_live_….",
      );
    }
    if (fromUrl && parsed.kind === "secret") {
      throw new ApiError(
        "unauthorized",
        "Secret keys (pq_sk_…) must be sent in the Authorization header, never in the URL — URLs end up in logs and referrers. Only publishable keys (pq_pk_…) may use `?key=`.",
      );
    }
    if (options.kind !== undefined && parsed.kind !== options.kind) {
      throw new ApiError(
        "forbidden",
        `This endpoint requires a ${options.kind} key (${
          options.kind === "secret" ? "pq_sk_…" : "pq_pk_…"
        }); a ${parsed.kind} key was sent.`,
      );
    }

    const found = await resolveApiKey(c, parsed, token, {
      cache: options.cache === true,
    });
    if (found === null) {
      throw new ApiError("unauthorized", "Unknown or revoked API key.");
    }
    c.set("auth", found.auth);
    await enforceRateLimit(c);

    const now = Date.now();
    if (
      found.source === "db" &&
      (found.lastUsedAt === null ||
        now - found.lastUsedAt.getTime() >= LAST_USED_REFRESH_MS)
    ) {
      // Only after a lookup: a cache hit has no connection to ride on, and
      // under steady traffic a lookup happens once a minute anyway.
      waitUntil(
        c,
        c
          .get("getDb")()
          .update(schema.apiKeys)
          .set({ lastUsedAt: new Date(now) })
          .where(eq(schema.apiKeys.id, found.auth.apiKeyId)),
      );
    }

    await next();
  });
}

/** Write routes: secret keys only (403 for publishable, before any DB work). */
export const requireSecretKey = requireApiKey({ kind: "secret" });

/** Read routes: either kind. */
export const requireAnyKey = requireApiKey();

/**
 * `/v1/query`: either kind, on GET a publishable key may ride in `?key=`,
 * and the key is resolved through the auth cache (module doc).
 */
export const requireQueryKey = requireApiKey({ keyParam: true, cache: true });
