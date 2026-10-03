// @proofql/google/fake — the fake Google Business Profile server. Imported
// by integration tests (in-process via `createFakeGoogle().fetch`) and run
// standalone for local dev by `pnpm --filter @proofql/google dev:fake`
// (./worker.ts). Never deployed.
export * from "./app.js";
export * from "./fixtures.js";
export * from "./store.js";
export type * from "./types.js";
