/**
 * The indexing view's shared rules (#162): when the progress UI calls
 * indexing "delayed", what it says then, and how often a page left open
 * re-reads the counts. Pure and browser-safe, so every rule is unit-tested
 * (indexing.test.ts) and shared by the import run page, onboarding step 3
 * and the onboarding "Check for reviews" poll.
 *
 * Why "delayed": past the Workers Free plan's daily Queues limit the
 * reviews are stored but their index messages are refused (#159), and the
 * pipeline's five-minute sweep sends them once the quota resets. The
 * dashboard learns that either from the request that hit it (`?indexing=
 * deferred` after a Places import) or, for any path, from reviews that
 * have stayed unindexed longer than {@link INDEXING_DEFERRED_AFTER_MS}:
 * normal indexing takes seconds, so a review still waiting after two
 * minutes is waiting on the sweep.
 *
 * Why the backoff: every poll is a dashboard request plus a few Hyperdrive
 * queries, and the free plan's 100,000 queries a day are shared by every
 * tenant (docs/launch.md §16). A tab left open on a deferred import used to
 * poll every 2 s until midnight UTC, about 1,800 requests an hour. The
 * schedule below costs 104 requests in its first 30 minutes and then
 * stops, with a "Check again" button.
 */

/** Unindexed reviews older than this mean indexing is waiting on the sweep. */
export const INDEXING_DEFERRED_AFTER_MS = 2 * 60_000;

/** The search param a redirect carries when the request itself was deferred. */
export const INDEXING_PARAM = "indexing";
export const INDEXING_DEFERRED = "deferred";

/** What the progress UI says while indexing is deferred. */
export const INDEXING_DELAYED_COPY =
  "Indexing is delayed and will finish automatically; you can leave this page. Reviews appear in results as they are indexed, at the latest after midnight UTC.";

/** The meter's hint under "Reviews indexed", or undefined when nothing waits. */
export function indexingHint(
  indexing: number,
  deferred: boolean,
): string | undefined {
  if (indexing <= 0) return undefined;
  if (deferred) return INDEXING_DELAYED_COPY;
  return `${indexing.toLocaleString("en-US")} waiting on the pipeline — searchable within seconds.`;
}

/** One step of the polling schedule: poll every `everyMs` until `untilMs`. */
export interface PollStep {
  untilMs: number;
  everyMs: number;
}

/**
 * Every 2 s for the first minute, every 10 s until five minutes, every
 * 30 s until thirty minutes, then stop.
 */
export const POLL_SCHEDULE: readonly PollStep[] = [
  { untilMs: 60_000, everyMs: 2_000 },
  { untilMs: 5 * 60_000, everyMs: 10_000 },
  { untilMs: 30 * 60_000, everyMs: 30_000 },
];

/**
 * The wait before the next poll, `elapsedMs` after polling started, or
 * null once the schedule is over (stop and offer "Check again").
 */
export function pollDelayMs(
  elapsedMs: number,
  schedule: readonly PollStep[] = POLL_SCHEDULE,
): number | null {
  for (const step of schedule) {
    if (elapsedMs < step.untilMs) return step.everyMs;
  }
  return null;
}

/** `schedule` cut off at `untilMs`: the same pace, a shorter run. */
export function scheduleUntil(
  untilMs: number,
  schedule: readonly PollStep[] = POLL_SCHEDULE,
): PollStep[] {
  const out: PollStep[] = [];
  for (const step of schedule) {
    out.push({ ...step, untilMs: Math.min(step.untilMs, untilMs) });
    if (step.untilMs >= untilMs) break;
  }
  return out;
}
