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
 * Step 4 joins `projects`, so the context also carries the project's
 * publication policy, CORS allowlist, and badge flag (`ProjectPolicy`): the
 * query route reads policy exactly once per request, in the same statement
 * as the key, and never again downstream.
 *
 * `?key=` (the query route only): a `GET /v1/query?key=pq_pk_…&q=…` with no
 * custom headers is a CORS "simple request", so the snippet's browser sends
 * it with no preflight at all — and when a preflight does happen, browsers
 * strip `Authorization` from it, so the URL is the only place a key can
 * ride. Secret keys are never accepted from the URL: URLs land in logs and
 * referrers. The Authorization header wins when both are present.
 *
 * Once the key is known the request is counted against its per-key rate
 * limit (`enforceRateLimit`, src/rate-limit.ts) — here rather than per
 * route, so no route can forget it.
 *
 * `last_used_at` is refreshed at most once per key per minute, after the
 * response, via `waitUntil` — a dashboard hint, never on the hot path.
 */

import { type ApiKeyKind, hashApiKey, parseApiKey } from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { AppEnv, AuthContext } from "./bindings.js";
import { waitUntil } from "./db.js";
import { ApiError } from "./errors.js";
import { enforceRateLimit } from "./rate-limit.js";

/** How stale `last_used_at` may be before a request refreshes it. */
export const LAST_USED_REFRESH_MS = 60_000;

export interface RequireApiKeyOptions {
  /** Require this kind; publishable keys get 403 on `secret` routes. */
  kind?: ApiKeyKind;
  /**
   * Also accept a *publishable* key from `?key=` when there is no
   * Authorization header (module doc). Only `/v1/query` turns this on.
   */
  keyParam?: boolean;
}

const USAGE_HINT = "Send `Authorization: Bearer <api key>`.";
const KEY_PARAM_HINT =
  "Send `Authorization: Bearer <api key>`, or a publishable key as `?key=pq_pk_…`.";

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
  const keyHash = await hashApiKey(token);
  const { apiKeys, projects } = schema;
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
      showBadge: projects.showBadge,
    })
    .from(apiKeys)
    .innerJoin(projects, eq(projects.id, apiKeys.projectId))
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
      project: {
        allowedOrigins: row.allowedOrigins,
        minRating: row.minRating,
        similarityFloor: row.similarityFloor,
        showBadge: row.showBadge,
      },
    },
    lastUsedAt: row.lastUsedAt,
  };
}

/**
 * Authenticate the request and set `c.get("auth")`. With `{ kind: "secret" }`
 * a publishable key is refused with 403 before the database is consulted.
 */
export function requireApiKey(options: RequireApiKeyOptions = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("authorization");
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
      const param = options.keyParam ? c.req.query("key") : undefined;
      if (param === undefined || param === "") {
        throw new ApiError(
          "unauthorized",
          `Missing Authorization header. ${options.keyParam ? KEY_PARAM_HINT : USAGE_HINT}`,
        );
      }
      token = param;
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

    const db = c.get("getDb")();
    const found = await lookupApiKey(db, token);
    if (found === null) {
      throw new ApiError("unauthorized", "Unknown or revoked API key.");
    }
    c.set("auth", found.auth);
    await enforceRateLimit(c);

    const now = Date.now();
    if (
      found.lastUsedAt === null ||
      now - found.lastUsedAt.getTime() >= LAST_USED_REFRESH_MS
    ) {
      waitUntil(
        c,
        db
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

/** `/v1/query`: either kind, and a publishable key may ride in `?key=`. */
export const requireQueryKey = requireApiKey({ keyParam: true });
