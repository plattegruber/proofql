/**
 * Column helpers and enums shared by every table group.
 *
 * `environment` is the live/test split from scope.md §3: test keys write to
 * the same database as live keys, and every tenant-scoped row (keys,
 * reviews, chunks, ingest runs) carries the column so a project can wipe
 * its test data with one `DELETE ... WHERE environment = 'test'` and so a
 * query against a test key can never return a live review. It is a column,
 * not a separate schema or database, because the alternative doubles the
 * connection, migration, and cache surface for a distinction that is just
 * a filter.
 */

import { API_KEY_ENVIRONMENTS, type ApiKeyEnvironment } from "@proofql/core";
import { pgEnum, timestamp, uuid } from "drizzle-orm/pg-core";

/** Values from core (#61); `ENVIRONMENTS` is the db-side name for the column every tenant row carries. */
export const ENVIRONMENTS = API_KEY_ENVIRONMENTS;
export type Environment = ApiKeyEnvironment;

export const environmentEnum = pgEnum("environment", ENVIRONMENTS);

/** `id uuid primary key default gen_random_uuid()` — every table but `usage`. */
export const id = () => uuid("id").primaryKey().defaultRandom();

/** `created_at` / `updated_at` as `timestamp with time zone`, defaulting to now(). */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};
