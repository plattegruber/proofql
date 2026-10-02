/**
 * Calendar math for the monthly query quota (`usage.month`, scope.md §2):
 * shared by the api worker, which enforces and counts, and the dashboard,
 * which reads the same row for the usage panel, so both agree on what "this
 * month" is — always the UTC calendar month.
 */

/** `YYYY-MM-01` for the UTC month containing `now` — the `usage.month` key. */
export function usageMonthStart(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

/** Whole seconds from `now` until the first instant of next UTC month. */
export function secondsToMonthEnd(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
