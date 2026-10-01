/**
 * The one structured logger for every deployable (#30; docs/observability.md
 * is the catalogue of events and fields).
 *
 * One JSON object per line, written through a `sink` (default: the console,
 * which Workers Logs ingests and indexes field by field):
 *
 *   { "ts", "service", "environment", "event", "level", ...bindings, ...fields }
 *
 * - `event` is a stable dotted name (`query.completed`, `review.indexed`);
 *   anything variable goes in fields so lines stay countable.
 * - `level` is `info` unless the fields carry an explicit `level`, or an
 *   `error` field — a line that reports an error is an error.
 * - Fields are snake_case, matching the API's wire format, so one field
 *   name means one thing across workers and in the dashboard's filters.
 * - **Redaction** is structural, not optional: any field named in
 *   `REDACTED_FIELDS` (`text`, `excerpt`, `author_name`, `key`, `plaintext`,
 *   `authorization`), at any depth, is replaced with `"[redacted]"` before
 *   the line is serialized. Review text and API keys cannot reach the logs
 *   through this logger even when a call site passes them by mistake. Log
 *   `q_length`, not `q`; `review_id`, not the review.
 * - `child(bindings)` returns a logger whose every line carries the
 *   bindings (the api binds `request_id` per request, the pipeline
 *   `message_id` per queue message), so correlation needs no plumbing at
 *   call sites.
 *
 * This file is the only place under packages/ and workers/ allowed to touch
 * `console` (Biome `noConsole`); everything else logs through here.
 */

export type LogLevel = "info" | "warn" | "error";

/** The deployable a line comes from. */
export type LogService = "api" | "pipeline" | "dashboard";

export type LogFields = Record<string, unknown>;

/** Receives one serialized JSON line, without a trailing newline. */
export type LogSink = (line: string) => void;

export interface LoggerOptions {
  service: LogService;
  /** `ENVIRONMENT` from wrangler vars: `local` | `preview` | `prod` (`test` in tests). */
  environment: string;
  /** Where lines go; defaults to the console. Tests pass `recordingSink()`. */
  sink?: LogSink;
  /** Field names to redact, at any depth. Defaults to `REDACTED_FIELDS`. */
  redact?: readonly string[];
  /** Clock for `ts`; injectable for tests. */
  now?: () => Date;
}

export interface Logger {
  /** Emit one line. `fields.level` sets the level; `fields.error` implies `error`. */
  log(event: string, fields?: LogFields): void;
  /** A logger whose every line also carries `bindings` (later keys win). */
  child(bindings: LogFields): Logger;
  /** The bindings this logger adds to every line. */
  readonly bindings: Readonly<LogFields>;
}

/** The shape of one parsed line; what `recordingSink()` collects. */
export interface LogRecord extends LogFields {
  ts: string;
  service: LogService;
  environment: string;
  event: string;
  level: LogLevel;
}

/** Field names whose values never reach a log line (module doc). */
export const REDACTED_FIELDS: readonly string[] = [
  "text",
  "excerpt",
  "author_name",
  "key",
  "plaintext",
  "authorization",
];

export const REDACTED = "[redacted]";

const LEVELS: ReadonlySet<string> = new Set<LogLevel>([
  "info",
  "warn",
  "error",
]);

const consoleSink: LogSink = (line) => {
  // biome-ignore lint/suspicious/noConsole: the one sanctioned console sink for every worker; Workers Logs ingests stdout
  console.log(line);
};

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? consoleSink;
  const redact = new Set(options.redact ?? REDACTED_FIELDS);
  const now = options.now ?? (() => new Date());
  const { service, environment } = options;

  const make = (bindings: LogFields): Logger => ({
    bindings,
    log(event, fields = {}) {
      const { level: explicit, ...rest } = { ...bindings, ...fields };
      const line: LogRecord = {
        ts: now().toISOString(),
        service,
        environment,
        event,
        level: levelFor(explicit, rest),
        ...(redactFields(rest, redact) as LogFields),
      };
      sink(JSON.stringify(line));
    },
    child(more) {
      return make({ ...bindings, ...more });
    },
  });

  return make({});
}

/** `info` unless `level` is a valid level, or an `error` field is present. */
export function levelFor(level: unknown, fields: LogFields): LogLevel {
  if (typeof level === "string" && LEVELS.has(level)) return level as LogLevel;
  return fields.error !== undefined && fields.error !== null ? "error" : "info";
}

/**
 * Deep copy of `value` with every property named in `redact` replaced by
 * `REDACTED`, `Error`s flattened via `errorFields`, and `Date`s as ISO
 * strings. Arrays are walked; everything else is passed through for
 * `JSON.stringify`.
 */
export function redactFields(
  value: unknown,
  redact: ReadonlySet<string> = new Set(REDACTED_FIELDS),
): unknown {
  if (value instanceof Error) return redactFields(errorFields(value), redact);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redactFields(v, redact));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[key] = redact.has(key) ? REDACTED : redactFields(v, redact);
    }
    return out;
  }
  return value;
}

/** What an error looks like in a line: `{ name, message, cause? }` — never the stack. */
export interface ErrorFields {
  name: string;
  message: string;
  cause?: string;
}

export function errorFields(error: unknown): ErrorFields {
  if (error instanceof Error) {
    const fields: ErrorFields = { name: error.name, message: error.message };
    if (error.cause !== undefined) fields.cause = String(error.cause);
    return fields;
  }
  return { name: "NonError", message: String(error) };
}

export interface RecordingSink {
  sink: LogSink;
  /** Every line emitted so far, parsed, oldest first. */
  readonly records: LogRecord[];
  /** The records for one event. */
  find(event: string): LogRecord[];
  /** The single record for an event; throws when there is not exactly one. */
  only(event: string): LogRecord;
  clear(): void;
}

/** A sink that keeps the parsed lines, for tests asserting on log output. */
export function recordingSink(): RecordingSink {
  const records: LogRecord[] = [];
  return {
    records,
    sink: (line) => {
      records.push(JSON.parse(line) as LogRecord);
    },
    find: (event) => records.filter((r) => r.event === event),
    only(event) {
      const found = records.filter((r) => r.event === event);
      if (found.length !== 1) {
        throw new Error(
          `expected exactly one "${event}" line, found ${found.length}`,
        );
      }
      return found[0] as LogRecord;
    },
    clear() {
      records.length = 0;
    },
  };
}
