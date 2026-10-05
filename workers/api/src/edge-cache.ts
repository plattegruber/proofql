/**
 * The api's caches below KV (#158): what lets `/v1/query` run inside the
 * Workers Free plan's 100,000 KV reads and **1,000 KV writes** a day.
 *
 * Three pieces, one instance per app (`createApp`), so per isolate in
 * production — the same lifetime as the usage buffer:
 *
 * - **The Workers Cache API** (`caches.default`), for query results and
 *   resolved API keys. Free, no daily quota, per data center. It is only
 *   functional on a **custom domain**: Cloudflare documents working cache
 *   operations for "Workers deployed to custom domains" (and Pages), and on
 *   `*.workers.dev` a `put` is silently dropped. `edgeCacheFor` therefore
 *   returns null for a `*.workers.dev` request (and wherever `caches` does
 *   not exist: Node tests), and the callers fall back (below). Entries live
 *   under a reserved path on the request's own origin,
 *   `/__proofql_cache/<kind>/<key>`; the worker routes no such path, and the
 *   Cache API is not reachable from outside the worker.
 * - **`MissCounter`**, the KV write budget for the query cache when the
 *   Cache API is unavailable: a query is written to KV only on its
 *   **second** MISS within the TTL in this isolate. A one-off query —
 *   most of the long tail — never costs a write; a repeated one costs one.
 *   The count is per isolate, so a query whose repeats land on different
 *   isolates may never be cached: that is the price of a write budget with
 *   no shared state (docs/performance.md §7).
 * - **`GenerationMemo`**: the project's cache generation (`gen:<id>`) read
 *   from KV at most once per `ttlMs` per project per isolate (default
 *   10 s). Every cached request needs the generation, so without the memo
 *   KV reads scale one-for-one with queries. KV itself already propagates a
 *   bump to other colos in up to 60 s, so the memo adds at most `ttlMs` to
 *   a purge that was never immediate; a bump made by this worker (review
 *   CRUD) updates the memo at once.
 *
 * Plus `LruTtl`, the in-isolate map the auth cache keeps its entries in
 * (src/auth-cache.ts).
 */

import {
  guardKvRead,
  readProjectGeneration,
  safeBumpProjectGeneration,
} from "@proofql/core";
import type { Context } from "hono";

import type { AppEnv } from "./bindings.js";
import { logFor } from "./request-id.js";

/** The slice of the Workers `Cache` this module uses; tests pass a Map-backed fake. */
export interface EdgeCacheLike {
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
}

/** `*.workers.dev`, where the Cache API's `put` is a no-op (module doc). */
export function isWorkersDevHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "workers.dev" || host.endsWith(".workers.dev");
}

/** Reserved path prefix for Cache API keys on the request's origin. */
export const EDGE_CACHE_PATH = "/__proofql_cache/";

/** The Cache API key for `kind`/`key` on the origin of `requestUrl`. */
export function edgeCacheUrl(
  requestUrl: string,
  kind: "q" | "auth",
  key: string,
): string {
  const { origin } = new URL(requestUrl);
  return `${origin}${EDGE_CACHE_PATH}${kind}/${encodeURIComponent(key)}`;
}

/** Bounded map with insertion-order eviction and a per-read max age. */
export class LruTtl<V> {
  readonly #max: number;
  readonly #now: () => number;
  readonly #map = new Map<string, { value: V; at: number }>();

  constructor(max: number, now: () => number = Date.now) {
    this.#max = max;
    this.#now = now;
  }

  get size(): number {
    return this.#map.size;
  }

  /** The value and its age, or undefined when absent or older than `maxAgeMs`. */
  get(key: string, maxAgeMs: number): { value: V; ageMs: number } | undefined {
    const entry = this.#map.get(key);
    if (entry === undefined) return undefined;
    const ageMs = this.#now() - entry.at;
    if (ageMs >= maxAgeMs) {
      this.#map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.#map.delete(key);
    this.#map.set(key, entry);
    return { value: entry.value, ageMs };
  }

  /** Store `value`, stamped `at` (default now). */
  set(key: string, value: V, at: number = this.#now()): void {
    this.#map.delete(key);
    this.#map.set(key, { value, at });
    while (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.#map.delete(key);
  }
}

export interface MissCounterOptions {
  /** MISSes within `windowMs` before the result is written; default 2. */
  threshold?: number;
  /** Default: the query cache TTL. */
  windowMs: number;
  /** Keys tracked per isolate; default 5,000 (a few hundred KB). */
  max?: number;
  now?: () => number;
}

/** The KV write budget (module doc). */
export class MissCounter {
  readonly threshold: number;
  readonly #windowMs: number;
  readonly #seen: LruTtl<number>;
  readonly #now: () => number;

  constructor(options: MissCounterOptions) {
    this.threshold = options.threshold ?? 2;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
    this.#seen = new LruTtl(options.max ?? 5_000, this.#now);
  }

  /** Count one MISS for `key`; true when this one should be written to KV. */
  recordMiss(key: string): boolean {
    if (this.threshold <= 1) return true;
    const seen = this.#seen.get(key, this.#windowMs);
    const count = (seen?.value ?? 0) + 1;
    if (count >= this.threshold) {
      // Written now; a later MISS (TTL expiry, eviction) starts over.
      this.#seen.delete(key);
      return true;
    }
    // Keep the first MISS's timestamp: the window runs from it.
    this.#seen.set(
      key,
      count,
      seen === undefined ? this.#now() : this.#now() - seen.ageMs,
    );
    return false;
  }
}

/** Per-isolate memo of `gen:<projectId>` (module doc). */
export class GenerationMemo {
  readonly ttlMs: number;
  readonly #map: LruTtl<number>;

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.#map = new LruTtl(10_000, now);
  }

  get(projectId: string): number | undefined {
    if (this.ttlMs <= 0) return undefined;
    return this.#map.get(projectId, this.ttlMs)?.value;
  }

  set(projectId: string, generation: number): void {
    if (this.ttlMs <= 0) return;
    this.#map.set(projectId, generation);
  }
}

/** Default memo lifetime for the generation (module doc). */
export const GENERATION_MEMO_MS = 10_000;

export interface EdgeCaches {
  /** `caches.default` in workerd; null where the Cache API does not exist. */
  cache: EdgeCacheLike | null;
  missCounter: MissCounter;
  generations: GenerationMemo;
}

/** The runtime's default cache, or null (Node, or no Cache API). */
export function defaultEdgeCache(): EdgeCacheLike | null {
  const storage = (globalThis as { caches?: { default?: EdgeCacheLike } })
    .caches;
  return storage?.default ?? null;
}

/**
 * The Cache API to use for this request, or null when it would not work:
 * none in this runtime, or a `*.workers.dev` hostname (module doc).
 */
export function edgeCacheFor(c: Context<AppEnv>): EdgeCacheLike | null {
  const cache = c.get("edge")?.cache ?? null;
  if (cache === null) return null;
  return isWorkersDevHost(new URL(c.req.url).hostname) ? null : cache;
}

/**
 * The project's cache generation for this request: the memo, else one KV
 * read (stored in the memo). Null when KV could not be read (a fault or the
 * daily limit): the caller must then treat the request as **uncachable** —
 * no lookup, no store — since a key built on a guessed generation could
 * serve results a purge already retired. The failure is logged by the
 * isolate's throttled `kvFaults` reporter (`kv.limit_exceeded` /
 * `kv.read_failed`, site `api.generation`).
 */
export async function readGeneration(
  c: Context<AppEnv>,
  projectId: string,
): Promise<number | null> {
  const memo = c.get("edge")?.generations;
  const known = memo?.get(projectId);
  if (known !== undefined) return known;
  const generation = await guardKvRead<number | null>(
    { log: logFor(c), site: "api.generation" },
    null,
    () => readProjectGeneration(c.env.CACHE, projectId),
  );
  if (generation !== null) memo?.set(projectId, generation);
  return generation;
}

/**
 * Bump the project's generation after a committed change made by this
 * worker, never throwing (`safeBumpProjectGeneration`), and update the
 * memo so this isolate's next request already uses the new value.
 */
export async function bumpGeneration(
  c: Context<AppEnv>,
  projectId: string,
): Promise<number | null> {
  const generation = await safeBumpProjectGeneration(c.env.CACHE, projectId, {
    log: logFor(c),
    site: "api.generation_bump",
  });
  if (generation !== null)
    c.get("edge")?.generations.set(projectId, generation);
  return generation;
}
