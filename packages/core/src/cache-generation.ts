/**
 * The query-cache generation counter (#81; scope.md §3 "Query": the cache
 * is "purged on ingest, delete, hide, or policy change for that project").
 *
 * The api worker caches `/v1/query` results in KV under keys that include
 * the project's current *generation*, an integer stored at `gen:<projectId>`
 * as a decimal string (`0` when the key is absent). Anything that changes
 * what a query may return — the api's review CRUD, the pipeline's index
 * completion, later the dashboard's policy settings — calls
 * `bumpProjectGeneration`; the api's cache reads the counter with
 * `readProjectGeneration` and includes it in every key, so a bump orphans
 * every existing entry for the project in one write: no enumeration, no
 * per-key deletes. Orphans age out through the entries' own TTL.
 *
 * This is the contract between the writers and the one reader, which is why
 * it lives here and not in either worker. KV has no atomic increment, so two
 * concurrent bumps can write the same value; that is harmless for
 * invalidation — either write differs from the generation the stale entries
 * were keyed on — and KV is eventually consistent anyway (a read in another
 * colo may lag by up to 60 s), so the cache treats a bump as "soon", never
 * "now". The counter is per project, not per environment: test and live
 * share one, which over-purges harmlessly and keeps one key per tenant.
 *
 * Bump **after** the database change has committed, never inside the
 * transaction: a bump for a rolled-back write is a wasted cache miss, a
 * missing bump for a committed write is stale data.
 */

/** The KV surface this module needs; `env.CACHE` (a `KVNamespace`) fits. */
export interface GenerationKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** `gen:<projectId>` — the one key format every worker must agree on. */
export function generationKey(projectId: string): string {
  return `gen:${projectId}`;
}

/** Parse a stored counter; anything but a decimal integer counts as 0. */
export function parseGeneration(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : 0;
}

/** The current generation for a project (0 until the first bump). */
export async function readProjectGeneration(
  kv: GenerationKv,
  projectId: string,
): Promise<number> {
  return parseGeneration(await kv.get(generationKey(projectId)));
}

/**
 * Invalidate every cached query result for a project by advancing its
 * generation (module doc). Resolves to the new value.
 */
export async function bumpProjectGeneration(
  kv: GenerationKv,
  projectId: string,
): Promise<number> {
  const key = generationKey(projectId);
  const next = parseGeneration(await kv.get(key)) + 1;
  await kv.put(key, String(next));
  return next;
}

/**
 * Defer generation bumps to one write per project (#158). The pipeline
 * indexes a queue batch of up to ten reviews, and every review whose
 * `indexed_at` flips bumps its project — ten KV writes for one batch of one
 * project's import, against the free plan's 1,000 writes a day. Wrapped in
 * this, `bumpProjectGeneration` reads the pending value instead of KV after
 * the first bump and its `put` is held; `flush()` writes each project's
 * final value once. Call `flush()` after the batch's database work, before
 * acknowledging: the results only change once the last review is indexed,
 * so one bump at the end purges exactly when it matters.
 */
export interface CoalescedGenerations {
  /** Hand this to code that bumps; `gen:*` writes are held until `flush`. */
  readonly kv: GenerationKv;
  /** Projects with a held bump. */
  readonly pending: readonly string[];
  /**
   * Write every held generation; resolves to the ones written. A failing
   * write rejects after attempting the rest (callers guard it).
   */
  flush(): Promise<{ projectId: string; generation: number }[]>;
}

export function coalesceGenerationBumps(
  kv: GenerationKv,
): CoalescedGenerations {
  const held = new Map<string, string>();
  const prefix = generationKey("");
  return {
    kv: {
      get: async (key) => held.get(key) ?? kv.get(key),
      put: async (key, value) => {
        if (key.startsWith(prefix)) held.set(key, value);
        else await kv.put(key, value);
      },
    },
    get pending() {
      return [...held.keys()].map((key) => key.slice(prefix.length));
    },
    async flush() {
      const entries = [...held.entries()];
      held.clear();
      const written: { projectId: string; generation: number }[] = [];
      let failure: unknown = null;
      for (const [key, value] of entries) {
        try {
          await kv.put(key, value);
          written.push({
            projectId: key.slice(prefix.length),
            generation: parseGeneration(value),
          });
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== null) throw failure;
      return written;
    },
  };
}

/** In-memory `GenerationKv` for tests: a Map with the KV method names. */
export class MemoryKv implements GenerationKv {
  readonly store = new Map<string, string>();
  /** Every `put` in order, so tests can count bumps. */
  readonly puts: { key: string; value: string }[] = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.store.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    this.puts.push({ key, value });
  }
}
