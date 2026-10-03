// @proofql/google/fake — the fake Google Business Profile server. Imported
// by integration tests (in-process via `createFakeGoogle().fetch`) and run
// standalone for local dev by `pnpm --filter @proofql/google dev:fake`
// (./worker.ts). Never deployed. Beside it, the fake Places API (New)
// (./places.ts): a `fetch`-shaped handler the dashboard's and the pipeline's
// tests take in-process, served on :8803 by
// `node apps/dashboard/test/fake-places-server.ts` for a manual run.
export * from "./app.js";
export * from "./fixtures.js";
export * from "./places.js";
export * from "./store.js";
export type * from "./types.js";
