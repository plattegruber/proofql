/**
 * Query-cache purge seam (scope.md §3 "Query": the cache is "purged on
 * ingest, delete, hide, or policy change for that project").
 *
 * The cache itself is #28 and does not exist yet. What exists now is the
 * contract between the two sides, so the routes that invalidate (this
 * worker's review CRUD, later the pipeline and the dashboard) can ship
 * first and #28 can key its entries without touching them:
 *
 *   - Every project has a generation counter in KV (`env.CACHE`) under
 *     `gen:<projectId>`, an integer stored as a decimal string, `0` when the
 *     key is absent.
 *   - Anything that changes what a query may return calls
 *     `bumpProjectGeneration(env, projectId)`. It increments the counter and
 *     returns the new value.
 *   - #28 reads the counter with `readProjectGeneration` and includes it in
 *     every cache key for the project, so a bump orphans every existing
 *     entry at once; no enumeration, no per-key deletes. Orphans age out via
 *     the entries' own TTL.
 *
 * KV has no atomic increment, so two concurrent bumps can both write the same
 * value. That is harmless for invalidation — either write differs from the
 * generation the stale entries were keyed on — and KV is eventually
 * consistent anyway (a read in another colo may lag by up to 60 s), so #28
 * must treat the generation as "soon", never "now". The counter is per
 * project, not per environment: test and live share one, which over-purges
 * harmlessly and keeps one key per tenant.
 */

/** The subset of `KVNamespace` the seam needs; tests pass a Map-backed fake. */
export interface GenerationStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface GenerationEnv {
  CACHE: GenerationStore;
}

export function generationKey(projectId: string): string {
  return `gen:${projectId}`;
}

/** Parse a stored counter; anything unexpected counts as the initial 0. */
function parseGeneration(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : 0;
}

/** The current generation for a project (0 until the first bump). */
export async function readProjectGeneration(
  env: GenerationEnv,
  projectId: string,
): Promise<number> {
  return parseGeneration(await env.CACHE.get(generationKey(projectId)));
}

/**
 * Invalidate every cached query result for a project by advancing its
 * generation. Call after the database change has committed, never inside
 * the transaction: a bump for a rolled-back write is a wasted cache miss, a
 * missing bump for a committed write is stale data.
 */
export async function bumpProjectGeneration(
  env: GenerationEnv,
  projectId: string,
): Promise<number> {
  const key = generationKey(projectId);
  const next = parseGeneration(await env.CACHE.get(key)) + 1;
  await env.CACHE.put(key, String(next));
  return next;
}
