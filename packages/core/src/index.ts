// Domain logic shared by every deployable: API keys, plan limits, the ingest
// queue message, the review shape, sentiment, chunking, the query-cache
// generation counter, and the structured logger.
// Pure functions and schemas only — no I/O beyond the logger's sink, no
// database, no platform bindings (the KV contract is a structural type).
export * from "./apiKeys.js";
export * from "./cache-generation.js";
export * from "./chunking.js";
export * from "./limits.js";
export * from "./log.js";
export * from "./queue.js";
export * from "./review.js";
export * from "./sentiment.js";

/** Kept from the scaffold (#10): the workers' build-graph smoke tests import it. */
export const PACKAGE_NAME = "@proofql/core";
