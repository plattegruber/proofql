/**
 * `api_keys` — per-project credentials (scope.md §3 "Keys").
 *
 * Two kinds: `secret` (`pq_sk_*`, servers only, can ingest/manage/query) and
 * `publishable` (`pq_pk_*`, lives in the browser, query only, CORS-checked
 * against `projects.allowed_origins`). Each key is bound to one
 * `environment`; the environment of the key is the environment of every row
 * it writes or reads, which is how test and live data share one database
 * without mixing.
 *
 * Only the SHA-256 of the plaintext is stored (`key_hash`); the plaintext is
 * shown once at creation. `prefix` keeps the greppable, non-secret head of
 * the key (e.g. `pq_sk_live_3f9a`) so the dashboard can list keys without
 * ever holding the secret. Revocation is a timestamp, not a delete, so a
 * revoked key still resolves — to a clear "revoked" error rather than
 * "unknown key".
 */

import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { environmentEnum, id } from "./shared.js";
import { projects } from "./tenancy.js";

export const API_KEY_KINDS = ["secret", "publishable"] as const;
export type ApiKeyKind = (typeof API_KEY_KINDS)[number];
export const apiKeyKindEnum = pgEnum("api_key_kind", API_KEY_KINDS);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: apiKeyKindEnum("kind").notNull(),
    environment: environmentEnum("environment").notNull(),
    /** SHA-256 hex of the plaintext key; the lookup column on every request. */
    keyHash: text("key_hash").notNull().unique(),
    /** Non-secret display head of the key, e.g. `pq_pk_live_3f9a`. */
    prefix: text("prefix").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Updated lazily (at most once per key per interval) by the API. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Non-null means the key no longer authenticates. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("api_keys_project_id_idx").on(table.projectId)],
);
