/**
 * The pipeline's job schedule (#174). The Workers Free plan allows five
 * cron triggers per account, so each environment declares a single
 * five-minute cron (`triggers.crons` in wrangler.jsonc) and this table
 * decides, from the tick's scheduled time (UTC), which jobs run on it:
 *
 * - `sweep`: due every tick (re-enqueue reviews stuck unindexed, #72), but
 *   gated: it only runs while the KV "sweep pending" marker is set, or on
 *   a full-sweep tick (`isFullSweepTick`), so an idle tick never touches
 *   Postgres (src/handlers.ts `planSweep`; @proofql/core sweep-marker.ts).
 * - `google_poll`: minute 0 of every sixth hour (00, 06, 12, 18; #46).
 * - `places_refresh`: daily at 03:30 (#116).
 * - `account_purge`: daily at 04:15 (#169).
 *
 * The time is rounded down to the five-minute boundary first, so a tick
 * that fires a little late still matches. A skipped tick skips that
 * day's (or six hours') run of a time-of-day job; each job is idempotent
 * and its candidates are age-based, so the next due tick catches up.
 *
 * Postgres wakeups (Neon suspends a compute after 5 idle minutes): with no
 * pending work a day has exactly six database ticks per environment, the
 * four Google polls, the Places refresh and the account purge, and the
 * full sweep rides on those six rather than adding its own
 * (docs/performance.md §7 "Neon compute-hours").
 */

export type ScheduledJob =
  | "sweep"
  | "google_poll"
  | "places_refresh"
  | "account_purge";

/** The single cron's period, in minutes (`*\/5 * * * *`). */
export const TICK_MINUTES = 5;

const TICK_MS = TICK_MINUTES * 60_000;

/** Round a time down to the tick boundary (epoch ms are UTC). */
export function tickAt(time: Date | number): Date {
  const ms = typeof time === "number" ? time : time.getTime();
  return new Date(ms - (((ms % TICK_MS) + TICK_MS) % TICK_MS));
}

const at = (hour: number, minute: number) => (d: Date) =>
  d.getUTCHours() === hour && d.getUTCMinutes() === minute;

/** In run order: the sweep first, then the time-of-day jobs. */
export const DUE_JOBS: readonly {
  job: ScheduledJob;
  due: (tick: Date) => boolean;
}[] = [
  { job: "sweep", due: () => true },
  {
    job: "google_poll",
    due: (d) => d.getUTCMinutes() === 0 && d.getUTCHours() % 6 === 0,
  },
  { job: "places_refresh", due: at(3, 30) },
  { job: "account_purge", due: at(4, 15) },
];

/** The jobs a tick scheduled at `time` runs, in order. */
export function jobsDueAt(time: Date | number): ScheduledJob[] {
  const tick = tickAt(time);
  return DUE_JOBS.filter((j) => j.due(tick)).map((j) => j.job);
}

/**
 * Whether the sweep runs on this tick even with no work marker: every
 * tick where another job is due already wakes the database, so a full
 * sweep there is free (00/06/12/18:00, 03:30, 04:15 UTC). It bounds a lost
 * marker to six hours.
 */
export function isFullSweepTick(time: Date | number): boolean {
  const tick = tickAt(time);
  return DUE_JOBS.some((j) => j.job !== "sweep" && j.due(tick));
}
