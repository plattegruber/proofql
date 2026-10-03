// @proofql/google — the Google Business Profile connector's pure parts:
// endpoints, the v4 → ReviewInput adapter, typed API fetchers, OAuth token
// calls, credential encryption, the request pacer, and the location
// mapping stored on `connections` — plus the Places API (New) client and
// mapper behind the bootstrap and its refresh (./places.ts). No database,
// no platform bindings; the pipeline (polling, refresh) and the dashboard
// (connect flow, import card) wire these to their own I/O. The fake Google
// and Places servers live behind `@proofql/google/fake` so Hono never
// enters a worker that only polls.
export * from "./adapter.js";
export * from "./client.js";
export * from "./credentials.js";
export * from "./endpoints.js";
export * from "./errors.js";
export * from "./locations.js";
export * from "./oauth.js";
export * from "./pacing.js";
export * from "./places.js";
export * from "./schema.js";

export const PACKAGE_NAME = "@proofql/google";
export * from "./connect.js";
