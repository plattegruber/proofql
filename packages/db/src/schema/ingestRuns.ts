/**
 * `ingest_runs` — provenance and observability for every batch that feeds
 * the pipeline (scope.md §4).
 *
 * One row per push-API batch, CSV upload, Google poll, or Places bootstrap:
 * what it was (`kind`), how it went (the counts, `status`, `error`), and
 * where the raw input lives (`artifact_key`, an R2 key for uploaded CSVs).
 * This is what the dashboard's import progress bar and "last sync" read,
 * and what makes a failed import visible rather than silent.
 *
 * Counts are plain integers updated with `SET x = x + n` inside the stage
 * that did the work, never read-modify-write. `error` is the one message
 * worth showing a human; per-row failures beyond that are counted, not
 * stored.
 */

import {
  INGEST_RUN_KINDS,
  INGEST_RUN_STATUSES,
  type IngestRunKind,
  type IngestRunStatus,
} from "@proofql/core";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { environmentEnum, id } from "./shared.js";
import { projects } from "./tenancy.js";

export { INGEST_RUN_KINDS, type IngestRunKind };
export const ingestRunKindEnum = pgEnum("ingest_run_kind", INGEST_RUN_KINDS);

export { INGEST_RUN_STATUSES, type IngestRunStatus };
export const ingestRunStatusEnum = pgEnum(
  "ingest_run_status",
  INGEST_RUN_STATUSES,
);

export const ingestRuns = pgTable(
  "ingest_runs",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environment: environmentEnum("environment").notNull(),
    kind: ingestRunKindEnum("kind").notNull(),
    status: ingestRunStatusEnum("status").notNull().default("running"),
    /** Rows the run was handed (batch size, CSV rows, poll page total). */
    received: integer("received").notNull().default(0),
    /** New reviews inserted. */
    created: integer("created").notNull().default(0),
    /** Existing reviews updated by the upsert. */
    updated: integer("updated").notNull().default(0),
    /** Rows rejected before reaching the database (validation, duplicates). */
    skipped: integer("skipped").notNull().default(0),
    /** Rows that errored. */
    failed: integer("failed").notNull().default(0),
    /** The one human-readable failure message; null unless `status = failed`. */
    error: text("error"),
    /**
     * Kind-specific outcome beyond the counts, for the dashboard's result
     * view. Takeout runs (`TakeoutRunDetails` in the dashboard): the
     * locations imported, star-only and stale reviews skipped, reviews
     * removed because Google no longer has them, Places bootstrap rows
     * replaced. Null for every other kind.
     */
    details: jsonb("details").$type<Record<string, unknown>>(),
    /** R2 key of the uploaded artifact (CSV); null for API and connector runs. */
    artifactKey: text("artifact_key"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Null while `running`. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    // Dashboard lists runs newest-first per project.
    index("ingest_runs_project_id_started_at_idx").on(
      table.projectId,
      table.startedAt.desc(),
    ),
  ],
);
