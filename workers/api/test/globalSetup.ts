/**
 * Vitest globalSetup for the integration project: builds or refreshes the
 * shared `proofql_template` database through the @proofql/db harness.
 *
 * A one-line shim rather than pointing `globalSetup` at packages/db directly:
 * vitest resolves a globalSetup entry's own imports relative to this
 * workspace, so an entry file outside it cannot find the harness's
 * dependencies (`postgres`). Importing the real setup from a file inside the
 * workspace resolves everything normally.
 */

export default async function globalSetup(): Promise<void> {
  const { default: setup } = await import("@proofql/db/test/globalSetup");
  await setup();
}
