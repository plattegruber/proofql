/**
 * Global request pacing for the Google connector (#46).
 *
 * All of ProofQL's Google traffic shares one project quota — 300 QPM per
 * API, flipped on by approval (docs/google.md). One cron tick polls every
 * connection, so the pacer is global to the tick, not per connection:
 * {@link Pacer.acquire} is awaited before every data-API request anywhere
 * in the tick, and it never lets more than `limitPerMinute` requests start
 * inside any rolling 60-second window. Default 240 (80% of quota), which is
 * Google's own advice: pace evenly, sequential pagination, backoff with
 * jitter, never fan out in parallel.
 *
 * The schedule is pure — {@link nextSlot} takes the window state and a
 * clock and returns how long to wait and the new state — so the math is
 * unit-tested without timers; `createPacer` wraps it with a real (or
 * injected) sleep. Jitter is added on top of the required wait, never
 * subtracted from it, so it only ever spreads requests out further.
 *
 * {@link stableOrder} is the stagger: connections are processed in a
 * deterministic shuffle seeded by the tick, so the order is reproducible
 * for one tick (a retry of the same tick walks the same list) and
 * different across ticks (no connection is always last in a long tick).
 */

export const DEFAULT_LIMIT_PER_MINUTE = 240;
export const DEFAULT_MAX_JITTER_MS = 100;
const WINDOW_MS = 60_000;

export interface PacerState {
  /** Start times (ms) of the requests admitted in the current window. */
  readonly admitted: readonly number[];
}

export interface PacerOptions {
  limitPerMinute?: number;
  /** Upper bound of the random extra wait per request; 0 disables jitter. */
  maxJitterMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** [0, 1) source for the jitter; injectable for tests. */
  random?: () => number;
}

export const EMPTY_PACER_STATE: PacerState = { admitted: [] };

/**
 * Pure: given the window state at `now`, how long must the next request
 * wait so that, once it starts, no more than `limit` requests have started
 * in the trailing 60 s? Returns the wait and the state after admitting it.
 *
 * The minimum spacing is also enforced (`60000 / limit` ms between
 * consecutive starts) so a burst at the window's edge is smoothed into a
 * steady rate rather than admitted all at once.
 */
export function nextSlot(
  state: PacerState,
  now: number,
  limit: number = DEFAULT_LIMIT_PER_MINUTE,
): { waitMs: number; state: PacerState } {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RangeError(`limit must be a positive number, got ${limit}`);
  }
  const spacing = WINDOW_MS / limit;
  const live = state.admitted.filter((t) => now - t < WINDOW_MS);
  let start = now;
  const last = live[live.length - 1];
  if (last !== undefined && start - last < spacing) start = last + spacing;
  if (live.length >= limit) {
    const oldest = live[live.length - limit] as number;
    start = Math.max(start, oldest + WINDOW_MS);
  }
  const admitted = [...live, start];
  return { waitMs: Math.max(0, start - now), state: { admitted } };
}

export interface Pacer {
  /** Resolve when the next request may start. */
  acquire(): Promise<void>;
  /** Requests admitted so far (for logs and tests). */
  readonly count: number;
  /** Total milliseconds this pacer has made callers wait. */
  readonly waitedMs: number;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createPacer(options: PacerOptions = {}): Pacer {
  const limit = options.limitPerMinute ?? DEFAULT_LIMIT_PER_MINUTE;
  const maxJitter = options.maxJitterMs ?? DEFAULT_MAX_JITTER_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  let state: PacerState = EMPTY_PACER_STATE;
  let count = 0;
  let waitedMs = 0;
  // Serialise acquirers so two concurrent callers cannot both read the
  // same state; the tick is sequential anyway, this is belt and braces.
  let chain: Promise<void> = Promise.resolve();

  return {
    acquire() {
      const turn = chain.then(async () => {
        const slot = nextSlot(state, now(), limit);
        state = slot.state;
        count += 1;
        const jitter = maxJitter > 0 ? Math.floor(random() * maxJitter) : 0;
        const wait = slot.waitMs + jitter;
        if (wait > 0) {
          waitedMs += wait;
          await sleep(wait);
        }
      });
      chain = turn.catch(() => {});
      return turn;
    },
    get count() {
      return count;
    },
    get waitedMs() {
      return waitedMs;
    },
  };
}

/** FNV-1a, 32-bit — small, dependency-free, good enough to shuffle ids. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A deterministic shuffle: sort `ids` by `hash(seed + id)`, ties by id.
 * Same `seed` ⇒ same order; a different seed (the tick's hour, say) ⇒ a
 * different, unrelated order.
 */
export function stableOrder<T extends { id: string }>(
  items: readonly T[],
  seed: string,
): T[] {
  return [...items].sort((a, b) => {
    const ha = fnv1a(`${seed}\u0000${a.id}`);
    const hb = fnv1a(`${seed}\u0000${b.id}`);
    if (ha !== hb) return ha - hb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
