/**
 * Query-cache invalidation by generation (#22, #24).
 *
 * The api worker caches query results in KV under keys that include the
 * project's current *generation*, an integer stored at `gen:<projectId>`.
 * Bumping the generation makes every cached result for the project
 * unreachable in one write, with no key enumeration — which KV does not
 * offer cheaply — and no race with readers mid-fill: a reader that cached
 * under the old generation simply never gets a hit again.
 *
 * A missing key reads as generation 0, so the first bump writes `"1"`.
 * `get` + `put` is not atomic; two concurrent bumps may collapse into one,
 * which still invalidates (any change of value does), so it is accepted.
 * The counter is per project, not per environment (test and live share
 * one; over-purging is harmless).
 *
 * TODO(core): this is a deliberate twin of workers/api/src/cache-purge.ts
 * (#73), which this worker cannot import. Same key, same parsing, same
 * semantics; the next change to either should move both into
 * `@proofql/core` so the contract with the #28 reader has one home.
 */

/** The KV surface this module needs; `env.CACHE` (a `KVNamespace`) fits. */
export interface GenerationKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** `gen:<projectId>` — the one key format both workers must agree on. */
export function generationKey(projectId: string): string {
  return `gen:${projectId}`;
}

/** Parse the stored generation; anything but a decimal integer counts as 0. */
export function parseGeneration(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : 0;
}

/** Increment the project's generation; resolves to the new value. */
export async function bumpProjectGeneration(
  kv: GenerationKv,
  projectId: string,
): Promise<number> {
  const key = generationKey(projectId);
  const next = parseGeneration(await kv.get(key)) + 1;
  await kv.put(key, String(next));
  return next;
}

/** In-memory `GenerationKv` for tests: a Map with the KV method names. */
export class MemoryKv implements GenerationKv {
  readonly store = new Map<string, string>();
  /** Every `put` in order, so tests can count bumps. */
  readonly puts: { key: string; value: string }[] = [];

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    this.puts.push({ key, value });
  }
}
