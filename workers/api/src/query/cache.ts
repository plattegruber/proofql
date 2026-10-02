/**
 * KV cache for `/v1/query` results (scope.md §3 "Query": "cached in KV
 * keyed on (project, environment, normalized query, filters); purged on
 * ingest, delete, hide, or policy change for that project"; issue #28).
 *
 * ## Key
 *
 * ```
 * q:<projectId>:<environment>:<generation>:<sha256 hex>
 * ```
 *
 * The hash is over the canonical JSON of what the search actually
 * receives — `q` normalized (trimmed, whitespace collapsed, lower-cased),
 * `limit`, `mode`, `filters` with sorted keys and a sorted, de-duplicated
 * `source` list, and the project policy inputs (`min_rating`,
 * `similarity_floor`) — so two requests that would run the same SQL share
 * an entry and nothing that changes the SQL can share one. Policy is in
 * the hash as well as being a purge trigger (below): a policy edit that
 * forgets to bump the generation still cannot serve results computed under
 * the old floor, because its key differs.
 *
 * ## Purge
 *
 * The project's generation counter (`@proofql/core` cache-generation,
 * `gen:<projectId>`) is part of every key, so invalidating a project is one KV write:
 * `bumpProjectGeneration` orphans every entry at once and the orphans age
 * out through `CACHE_TTL_SECONDS`. The bump sites:
 *
 *   - hide, unhide, metadata edit, delete — `../routes/reviews-crud.ts` (#22)
 *   - index completion — `workers/pipeline/src/index-review.ts` bumps when a
 *     review's `indexed_at` transitions (#24). Ingest itself (`POST
 *     /v1/reviews`) deliberately does **not** bump: an upsert sets
 *     `indexed_at` back to null, which removes the review from results only
 *     once the pipeline has re-embedded it, and a bump at ingest time would
 *     purge for a change that is not yet visible to the search. The
 *     pipeline's bump lands exactly when results change.
 *   - policy change — `onProjectPolicyChanged` below. There is no policy
 *     update API yet (dashboard, #41); when it lands it must call this after
 *     the `projects` row is committed.
 *
 * KV is eventually consistent (a read in another colo can lag a write by up
 * to 60 s), so a purge is "soon", never "now"; the TTL bounds the worst
 * case for an entry whose bump was lost.
 *
 * ## What is stored
 *
 * The `results` array of the response as JSON, with `{ generation,
 * storedAt }` as KV metadata. `took_ms`, `cached`, and `badge` are
 * per-request: the first two by definition, `badge` because it is derived
 * from the account's plan, which arrives with the key on every request and
 * must flip the moment the plan does, not when the cache turns over — so a
 * plan change needs no generation bump. Only successful searches are
 * stored; errors are never cached.
 */

import { bumpProjectGeneration, type GenerationKv } from "@proofql/core";

import type { QueryRequest } from "./request.js";
import type { QueryResponseResult } from "./route.js";

/** Safety net for orphaned entries; a bump is the real invalidation. */
export const CACHE_TTL_SECONDS = 24 * 60 * 60;

/** Response header naming the outcome: `HIT`, `MISS`, or `BYPASS`. */
export const CACHE_HEADER = "x-cache";

export type CacheOutcome = "HIT" | "MISS" | "BYPASS";

/** The slice of `KVNamespace` this module uses; tests pass a Map-backed fake. */
export interface CacheStore {
  getWithMetadata(
    key: string,
    type: "text",
  ): Promise<{ value: string | null; metadata: unknown }>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: unknown },
  ): Promise<void>;
}

/** Stored alongside each entry; diagnostic, not read on the hot path. */
export interface CacheEntryMetadata {
  generation: number;
  /** ISO 8601. */
  storedAt: string;
}

export interface CachedQuery {
  results: QueryResponseResult[];
  metadata: CacheEntryMetadata | null;
}

/** The policy inputs that shape the SQL; read with the key (`AuthContext`). */
export interface CacheKeyPolicy {
  minRating: number;
  similarityFloor: number;
}

export interface CacheKeyInput {
  projectId: string;
  environment: string;
  generation: number;
  request: QueryRequest;
  policy?: CacheKeyPolicy;
}

/** `"  Dental   IMPLANTS "` → `"dental implants"`. */
export function normalizeQ(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The object that is hashed: everything the search depends on, in a shape
 * where equal inputs serialize identically (`canonicalJson`). Exported so
 * the tests can pin what is and is not part of the identity.
 */
export function cacheIdentity(input: CacheKeyInput): Record<string, unknown> {
  const { request, policy } = input;
  const { filters } = request;
  return {
    q: request.q === undefined ? null : normalizeQ(request.q),
    limit: request.limit,
    mode: request.mode,
    filters: {
      min_rating: filters.min_rating ?? null,
      // `IN (...)` is order-insensitive, so the list's order is not identity.
      source:
        filters.source === undefined
          ? null
          : [...new Set(filters.source)].sort(),
      since: filters.since === undefined ? null : filters.since.toISOString(),
      metadata: filters.metadata ?? null,
    },
    policy:
      policy === undefined
        ? null
        : {
            min_rating: policy.minRating,
            similarity_floor: policy.similarityFloor,
          },
  };
}

/**
 * JSON with object keys sorted at every level, `Date`s as ISO strings, and
 * `undefined` properties dropped — so two structurally equal values yield
 * one string regardless of insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The KV key for a request (module doc "Key"). */
export async function cacheKey(input: CacheKeyInput): Promise<string> {
  const hash = await sha256Hex(canonicalJson(cacheIdentity(input)));
  return `q:${input.projectId}:${input.environment}:${input.generation}:${hash}`;
}

/**
 * The stored results for `key`, or null for a miss. An entry that does not
 * parse as a results array is treated as a miss rather than served: the
 * cache can only ever be stale, never wrong-shaped.
 */
export async function getCached(
  kv: CacheStore,
  key: string,
): Promise<CachedQuery | null> {
  const { value, metadata } = await kv.getWithMetadata(key, "text");
  if (value === null) return null;
  let results: unknown;
  try {
    results = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(results)) return null;
  return {
    results: results as QueryResponseResult[],
    metadata: isEntryMetadata(metadata) ? metadata : null,
  };
}

/** Store a successful search's `results` under `key` for `ttlSeconds`. */
export async function putCached(
  kv: CacheStore,
  key: string,
  results: QueryResponseResult[],
  options: { generation: number; ttlSeconds?: number; now?: Date },
): Promise<void> {
  const metadata: CacheEntryMetadata = {
    generation: options.generation,
    storedAt: (options.now ?? new Date()).toISOString(),
  };
  await kv.put(key, JSON.stringify(results), {
    expirationTtl: options.ttlSeconds ?? CACHE_TTL_SECONDS,
    metadata,
  });
}

function isEntryMetadata(value: unknown): value is CacheEntryMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as CacheEntryMetadata).generation === "number" &&
    typeof (value as CacheEntryMetadata).storedAt === "string"
  );
}

/**
 * Whether the request asked to skip the cache lookup. `Cache-Control:
 * no-cache` (RFC 9111 §5.2.1.4) means "do not answer from a stored
 * response"; the fresh answer is still stored for the next caller. Other
 * directives are ignored — there is no client-controlled `no-store`, so a
 * caller cannot keep a project's results out of the cache.
 */
export function wantsFresh(cacheControl: string | undefined): boolean {
  if (cacheControl === undefined) return false;
  return cacheControl
    .split(",")
    .some((directive) => directive.trim().toLowerCase() === "no-cache");
}

/**
 * Call after a change to a project's publication policy (`min_rating`,
 * `similarity_floor`, or any future column the search reads) has been
 * committed. The dashboard's project settings (#41) is the first caller.
 * Resolves to the new generation.
 */
export function onProjectPolicyChanged(
  kv: GenerationKv,
  projectId: string,
): Promise<number> {
  return bumpProjectGeneration(kv, projectId);
}
