/**
 * Test-only entry point: `import { setupTestDb, project } from "@proofql/db/test"`.
 *
 * Lets other workspaces (the api worker's route tests, the pipeline's
 * consumer tests) run against the same per-file database harness and
 * factories as this package, instead of each growing its own copy. Source
 * files, not dist: nothing under `test/` is built or shipped, and Vitest
 * transforms TypeScript from a linked workspace directly.
 */

export * from "./factories.js";
export * from "./harness.js";
