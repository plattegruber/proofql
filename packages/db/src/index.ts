// @proofql/db — Drizzle schema, client factory, and schema-level invariants
// for Postgres (pgvector + full-text search). Migrations live in
// ../migrations and are applied by scripts/migrate.ts; see README.md.

export {
  assertVerbatimSlice,
  isVerbatimSlice,
  type VerbatimSliceChunk,
  VerbatimSliceError,
  type VerbatimSliceReview,
} from "./chunks.js";
export { createDb, type Db, type Sql } from "./client.js";
export * as schema from "./schema/index.js";
