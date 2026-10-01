/**
 * Bearer auth for the public API (scope.md §3 "Keys").
 *
 *   Authorization: Bearer pq_sk_live_…
 *
 * Order of checks, cheapest first:
 *
 *   1. header present and shaped `Bearer <key>`      → else 401
 *   2. key matches API_KEY_PATTERN (`parseApiKey`)   → else 401, no DB work
 *   3. route needs a secret key and this is `pq_pk_` → 403, still no DB work
 *   4. SHA-256 → `api_keys.key_hash`, not revoked    → else 401
 *
 * The resolved key's `environment` is attached to the context and scopes
 * every row the request touches; a test key can never read or write live
 * rows. Steps 1–3 need no database, which keeps garbage and misconfigured
 * traffic from costing a digest or a round-trip.
 *
 * `last_used_at` is refreshed at most once per key per minute, after the
 * response, via `waitUntil` — a dashboard hint, never on the hot path.
 */

import { type ApiKeyKind, hashApiKey, parseApiKey } from "@proofql/core";
import { schema } from "@proofql/db";
import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";

import type { AppEnv } from "./bindings.js";
import { waitUntil } from "./db.js";
import { ApiError } from "./errors.js";

/** How stale `last_used_at` may be before a request refreshes it. */
export const LAST_USED_REFRESH_MS = 60_000;

export interface RequireApiKeyOptions {
  /** Require this kind; publishable keys get 403 on `secret` routes. */
  kind?: ApiKeyKind;
}

const USAGE_HINT = "Send `Authorization: Bearer <api key>`.";

/** Pull the key out of the header, or null when the header is not Bearer. */
export function extractBearerToken(
  authorization: string | undefined,
): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  return match?.[1] ?? null;
}

/**
 * Authenticate the request and set `c.get("auth")`. With `{ kind: "secret" }`
 * a publishable key is refused with 403 before the database is consulted.
 */
export function requireApiKey(options: RequireApiKeyOptions = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("authorization");
    if (header === undefined) {
      throw new ApiError(
        "unauthorized",
        `Missing Authorization header. ${USAGE_HINT}`,
      );
    }
    const token = extractBearerToken(header);
    if (token === null) {
      throw new ApiError(
        "unauthorized",
        `Authorization header is not a Bearer token. ${USAGE_HINT}`,
      );
    }
    const parsed = parseApiKey(token);
    if (parsed === null) {
      throw new ApiError(
        "unauthorized",
        "Malformed API key. Keys look like pq_sk_live_… or pq_pk_live_….",
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

    const keyHash = await hashApiKey(token);
    const db = c.get("getDb")();
    const [row] = await db
      .select({
        id: schema.apiKeys.id,
        projectId: schema.apiKeys.projectId,
        kind: schema.apiKeys.kind,
        environment: schema.apiKeys.environment,
        lastUsedAt: schema.apiKeys.lastUsedAt,
      })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.keyHash, keyHash),
          isNull(schema.apiKeys.revokedAt),
        ),
      )
      .limit(1);

    // A stored row whose kind/environment disagree with its own prefix is
    // corrupt; treat it as unknown rather than trust either side.
    if (
      row === undefined ||
      row.kind !== parsed.kind ||
      row.environment !== parsed.environment
    ) {
      throw new ApiError("unauthorized", "Unknown or revoked API key.");
    }

    c.set("auth", {
      apiKeyId: row.id,
      projectId: row.projectId,
      environment: row.environment,
      kind: row.kind,
    });

    const now = Date.now();
    if (
      row.lastUsedAt === null ||
      now - row.lastUsedAt.getTime() >= LAST_USED_REFRESH_MS
    ) {
      waitUntil(
        c,
        db
          .update(schema.apiKeys)
          .set({ lastUsedAt: new Date(now) })
          .where(eq(schema.apiKeys.id, row.id)),
      );
    }

    await next();
  });
}

/** Write routes: secret keys only (403 for publishable, before any DB work). */
export const requireSecretKey = requireApiKey({ kind: "secret" });

/** Read routes: either kind. */
export const requireAnyKey = requireApiKey();
