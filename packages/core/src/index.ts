// Domain logic shared by every deployable: API keys, the plan table and its
// limits, the ingest
// queue message, the review shape, sentiment, chunking, CSV import, the query-cache
// generation counter, the KV failure guards, data retention, and the structured logger.
// Pure functions and schemas only — no I/O beyond the logger's sink, no
// database, no platform bindings (the KV contract is a structural type).
export * from "./apiKeys.js";
export * from "./cache-generation.js";
export * from "./chunking.js";
export * from "./contact.js";
export * from "./csv/index.js";
export * from "./enums.js";
export * from "./kv-guard.js";
export * from "./limits.js";
export * from "./log.js";
export * from "./plans.js";
export * from "./queue.js";
export * from "./queue-guard.js";
export * from "./relevance.js";
export * from "./retention.js";
export * from "./review.js";
export * from "./sentiment.js";
export * from "./usage.js";

/** Kept from the scaffold (#10): the workers' build-graph smoke tests import it. */
export const PACKAGE_NAME = "@proofql/core";
