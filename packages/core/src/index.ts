// Domain logic shared by every deployable: API keys, plan limits, the ingest
// queue message, the review shape, sentiment.
// Pure functions and schemas only — no I/O, no database, no platform bindings.
export * from "./apiKeys.js";
export * from "./limits.js";
export * from "./queue.js";
export * from "./review.js";
export * from "./sentiment.js";

/** Kept from the scaffold (#10): the workers' build-graph smoke tests import it. */
export const PACKAGE_NAME = "@proofql/core";
