// @proofql/google — the Google Business Profile connector's pure parts:
// endpoints, the v4 → ReviewInput adapter, typed API fetchers, OAuth token
// calls, credential encryption, the request pacer, and the location
// mapping stored on `connections`. No database, no platform bindings; the
// pipeline (polling) and the dashboard (connect flow) wire these to their
// own I/O. The fake Google server lives behind `@proofql/google/fake` so
// Hono never enters a worker that only polls.
export * from "./adapter.js";
export * from "./client.js";
export * from "./credentials.js";
export * from "./endpoints.js";
export * from "./errors.js";
export * from "./locations.js";
export * from "./oauth.js";
export * from "./pacing.js";
export * from "./schema.js";

export const PACKAGE_NAME = "@proofql/google";
