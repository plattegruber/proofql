// Vitest globalSetup for the integration project: the @proofql/db harness
// builds (or reuses) the migrated `proofql_template` database that every
// `setupTestDb()` clone starts from. See packages/db/test/globalSetup.ts.
export { default } from "@proofql/db/test/globalSetup";
