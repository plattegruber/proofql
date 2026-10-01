/**
 * The real `@proofql/core` logger writing into a recording sink, so tests
 * assert on the lines the worker would actually emit (shape, bindings,
 * redaction) rather than on a spy's call arguments.
 */

import {
  createLogger,
  type Logger,
  type RecordingSink,
  recordingSink,
} from "@proofql/core";

export function testLogger(): { log: Logger; out: RecordingSink } {
  const out = recordingSink();
  return {
    out,
    log: createLogger({
      service: "pipeline",
      environment: "test",
      sink: out.sink,
    }),
  };
}
