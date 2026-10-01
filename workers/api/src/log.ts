/**
 * One structured log line per event: `{"event", "ts", ...fields}` as JSON
 * on stdout, which Workers Logs ingests as fields. The single place the
 * api writes to the console; #30 formalizes the convention across workers
 * (and the pipeline shares the shape), so every call site goes through
 * here and never through `console.*` directly.
 */

export type LogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

export function log(event: string, fields: LogFields = {}): void {
  // biome-ignore lint/suspicious/noConsole: the one sanctioned console sink
  console.log(
    JSON.stringify({ event, ts: new Date().toISOString(), ...fields }),
  );
}
