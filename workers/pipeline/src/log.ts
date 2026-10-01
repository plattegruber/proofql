/**
 * Structured logging for the pipeline: one JSON object per line, `event`
 * first, so Workers Logs can filter on it.
 *
 * This is the only place in the worker that touches `console` — Biome's
 * `noConsole` is an error everywhere else under workers/. #30 (structured
 * query logs and request IDs) replaces this with a shared logger; until then
 * every call site goes through `log` so the swap is one file.
 */

export type LogFields = Record<string, unknown>;

export type Logger = (event: string, fields?: LogFields) => void;

export const log: Logger = (event, fields = {}) => {
  // biome-ignore lint/suspicious/noConsole: the single sanctioned sink until #30 lands a shared structured logger.
  console.log(JSON.stringify({ event, ...fields }));
};

/** `{ name, message }` plus `cause` when present — never the stack. */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    const fields: LogFields = { name: error.name, message: error.message };
    if (error.cause !== undefined) fields.cause = String(error.cause);
    return fields;
  }
  return { name: "NonError", message: String(error) };
}
