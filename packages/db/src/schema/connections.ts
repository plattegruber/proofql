/**
 * `connections` — a project's OAuth-backed review sources (scope.md §4;
 * the Google Business Profile connector is M3).
 *
 * One row per `(project_id, kind)`: a project has at most one Google
 * connection. `credentials` holds AES-GCM ciphertext of the token JSON,
 * encrypted by the application with a Worker secret before it reaches the
 * database — the plaintext never touches Postgres, logs, or API responses.
 * Disconnecting NULLs the column; dead tokens are never kept.
 *
 * `cursor` is the connector's own resume token (a page token or
 * last-seen timestamp) and `metadata` is connector-specific state that must
 * survive re-authorization (the selected Google location, for example).
 *
 * Connections carry no `environment`: a connected Google account produces
 * live reviews. Test data comes from the push API and CSV with a test key.
 */

import { sql } from "drizzle-orm";
import {
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { id, timestamps } from "./shared.js";
import { projects } from "./tenancy.js";

export const CONNECTION_KINDS = ["google"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];
export const connectionKindEnum = pgEnum("connection_kind", CONNECTION_KINDS);

export const CONNECTION_STATUSES = [
  "active",
  "needs_reauth",
  "disconnected",
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];
export const connectionStatusEnum = pgEnum(
  "connection_status",
  CONNECTION_STATUSES,
);

export const connections = pgTable(
  "connections",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: connectionKindEnum("kind").notNull(),
    status: connectionStatusEnum("status").notNull().default("active"),
    /** AES-GCM ciphertext of the credential JSON; null when disconnected. */
    credentials: text("credentials"),
    /** Connector resume token; opaque to everything but the connector. */
    cursor: text("cursor"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Stamped by the poller after each successful sync. */
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("connections_project_id_kind_unique").on(
      table.projectId,
      table.kind,
    ),
  ],
);
