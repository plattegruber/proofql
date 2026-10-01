/**
 * Vitest globalSetup for the integration project: builds or refreshes the
 * shared `proofql_template` database through the @proofql/db harness.
 *
 * A one-line shim rather than pointing `globalSetup` at packages/db directly
 * (same reason as workers/api/test/globalSetup.ts): vitest resolves a
 * globalSetup entry's own imports relative to this workspace, so the entry
 * must live inside it for the harness's dependencies to resolve.
 */

export default async function globalSetup(): Promise<void> {
  const { default: setup } = await import("@proofql/db/test/globalSetup");
  await setup();
}
