/**
 * Cache for `/v1/query` results (scope.md §3 "Query": "cached … keyed on
 * (project, environment, normalized query, filters); purged on ingest,
 * delete, hide, or policy change for that project"; issues #28, #158).
 *
 * ## Where results live (#158)
 *
 * - **The Workers Cache API** (`caches.default`) when the request arrived
 *   on a custom domain: free, unmetered, per data center. The entry is a
 *   JSON `Response` under `<origin>/__proofql_cache/q/<key>` with
 *   `Cache-Control: max-age=<CACHE_TTL_SECONDS>` (src/edge-cache.ts).
 * - **KV** otherwise — on `*.workers.dev` the Cache API's `put` is a no-op —
 *   with a **write budget**: a result is written only on its second MISS
 *   within the TTL in the same isolate (`MissCounter`), so the long tail of
 *   one-off queries never spends the free plan's 1,000 daily KV writes.
 *   The trade-off: a query asked once per isolate is never cached, and a
 *   popular query pays one extra uncached search per isolate before it is.
 *
 * Either way the key and the purge are the same.
 *
 * ## Key
 *
 * ```
 * q:<projectId>:<environment>:<generation>:<sha256 hex>
 * ```
 *
 * The hash is over the canonical JSON of what the search actually
 * receives — `q` normalized (trimmed, whitespace collapsed, lower-cased),
 * `limit`, `mode`, `fallback`, a sorted `include` list, `filters` with
 * sorted keys and a sorted, de-duplicated `source` list, and the project
 * policy inputs (`min_rating`, `similarity_floor`, the generic words of
 * `category`) — so two requests that
 * would run the same SQL share an entry and nothing that changes the SQL
 * *or the stored shape* can share one (`include: ["text"]` changes what
 * each result carries, not the SQL; it is in the key for the body's sake). Policy is in
 * the hash as well as being a purge trigger (below): a policy edit that
 * forgets to bump the generation still cannot serve results computed under
 * the old floor, because its key differs.
 *
 * ## Purge
 *
 * The project's generation counter (`@proofql/core` cache-generation,
 * `gen:<projectId>`, always in KV) is part of every key, so invalidating a
 * project is one KV write: `bumpProjectGeneration` orphans every entry at
 * once — in the Cache API and in KV alike — and the orphans age out through
 * `CACHE_TTL_SECONDS`. The bump sites:
 *
 *   - hide, unhide, metadata edit, delete — `../routes/reviews-crud.ts` (#22)
 *   - index completion — `workers/pipeline/src/index-review.ts` bumps when a
 *     review's `indexed_at` transitions (#24), coalesced to one bump per
 *     project per queue batch (#158). Ingest itself (`POST
 *     /v1/reviews`) deliberately does **not** bump: an upsert sets
 *     `indexed_at` back to null, which removes the review from results only
 *     once the pipeline has re-embedded it, and a bump at ingest time would
 *     purge for a change that is not yet visible to the search. The
 *     pipeline's bump lands exactly when results change.
 *   - policy change — `onProjectPolicyChanged` below; the dashboard's
 *     project settings, key revocation and allowlist edits.
 *
 * KV is eventually consistent (a read in another colo can lag a write by up
 * to 60 s) and the api memoizes the generation for 10 s per isolate, so a
 * purge is "soon", never "now"; the TTL bounds the worst case for an entry
 * whose bump was lost — including a bump that failed because the day's KV
 * writes were spent, which is logged (`kv.limit_exceeded`) and swallowed.
 * When the generation cannot be *read*, the request is uncachable: no
 * lookup, no store.
 *
 * ## What is stored
 *
 * `{ results, match }` — the response's `results` array and its `match`
 * verdict (#86: a fallback answer must stay labelled as one on a HIT) as
 * JSON, with `{ generation, storedAt }` as KV metadata. An entry in the
 * older bare-array shape is treated as a miss, never served without its
 * verdict. `took_ms`, `cached`, and `badge` are
 * per-request: the first two by definition, `badge` because it is derived
 * from the account's plan, which arrives with the key on every request and
 * must flip the moment the plan does, not when the cache turns over — so a
 * plan change needs no generation bump. Only successful searches are
 * stored; errors are never cached.
 */

import {
  bumpProjectGeneration,
  type GenerationKv,
  genericQueryWords,
  LEXICAL_RULE,
  lexicalFloorFor,
} from "@proofql/core";

import type { EdgeCacheLike } from "../edge-cache.js";
import type { QueryRequest } from "./request.js";
import type { QueryMatch, QueryResponseResult } from "./route.js";

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

/** The stored body (module doc "What is stored"). */
export interface CachedBody {
  results: QueryResponseResult[];
  match: QueryMatch;
}

export interface CachedQuery extends CachedBody {
  metadata: CacheEntryMetadata | null;
}

const MATCHES: ReadonlySet<string> = new Set([
  "query",
  "fallback",
  "none",
  "recent",
]);

/** The policy inputs that shape the SQL; read with the key (`AuthContext`). */
export interface CacheKeyPolicy {
  minRating: number;
  similarityFloor: number;
  /**
   * The project's business category (#151); only its generic words enter
   * the key, so two categories with the same words share answers.
   */
  category?: string | null | undefined;
  /**
   * Reranker threshold when experimental reranking is on (#147); absent
   * otherwise, which leaves keys made without reranking unchanged.
   */
  rerankThreshold?: number | undefined;
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
    include: [...request.include].sort(),
    fallback: request.fallback,
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
            // Derived, but part of what the SQL applies (#138): keys made
            // before the two-tier floor, or under another offset, never
            // answer for it.
            lexical_floor: lexicalFloorFor(policy.similarityFloor),
            // Which chunks count as word matches (#147): answers cached
            // under the every-term rule, or another generic-word list
            // (another category, #151), never answer for this one.
            lexical_rule: LEXICAL_RULE,
            generic_words: genericQueryWords(policy.category),
            rerank_threshold: policy.rerankThreshold,
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
 * The stored body for `key`, or null for a miss. An entry that does not
 * parse as `{ results: [...], match }` is treated as a miss rather than
 * served: the cache can only ever be stale, never wrong-shaped.
 */
export async function getCached(
  kv: CacheStore,
  key: string,
): Promise<CachedQuery | null> {
  const { value, metadata } = await kv.getWithMetadata(key, "text");
  if (value === null) return null;
  let body: unknown;
  try {
    body = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isCachedBody(body)) return null;
  return {
    results: body.results,
    match: body.match,
    metadata: isEntryMetadata(metadata) ? metadata : null,
  };
}

function isCachedBody(value: unknown): value is CachedBody {
  if (typeof value !== "object" || value === null) return false;
  const { results, match } = value as Partial<CachedBody>;
  return (
    Array.isArray(results) && typeof match === "string" && MATCHES.has(match)
  );
}

/** Store a successful search's body under `key` for `ttlSeconds`. */
export async function putCached(
  kv: CacheStore,
  key: string,
  body: CachedBody,
  options: { generation: number; ttlSeconds?: number; now?: Date },
): Promise<void> {
  const metadata: CacheEntryMetadata = {
    generation: options.generation,
    storedAt: (options.now ?? new Date()).toISOString(),
  };
  await kv.put(key, JSON.stringify(body), {
    expirationTtl: options.ttlSeconds ?? CACHE_TTL_SECONDS,
    metadata,
  });
}

/**
 * The body cached in the Cache API under `url`, or null for a miss or a
 * wrong-shaped entry (same rule as `getCached`).
 */
export async function getEdgeCached(
  cache: EdgeCacheLike,
  url: string,
): Promise<CachedBody | null> {
  const res = await cache.match(url);
  if (res === undefined) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  return isCachedBody(body)
    ? { results: body.results, match: body.match }
    : null;
}

/** Store a successful search's body in the Cache API for `ttlSeconds`. */
export async function putEdgeCached(
  cache: EdgeCacheLike,
  url: string,
  body: CachedBody,
  options: { generation: number; ttlSeconds?: number; now?: Date },
): Promise<void> {
  await cache.put(
    url,
    new Response(JSON.stringify(body), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${options.ttlSeconds ?? CACHE_TTL_SECONDS}`,
        "x-proofql-generation": String(options.generation),
        "x-proofql-stored-at": (options.now ?? new Date()).toISOString(),
      },
    }),
  );
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
