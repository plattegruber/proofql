/**
 * `reviews` — the normalized review shape every source lands in
 * (scope.md §3 "Ingest", §4).
 *
 * One row per review per project per environment. `(project_id,
 * environment, source, external_id)` is the upsert key for the push API and
 * the connectors: re-sending a review updates it in place instead of
 * duplicating it, and a test import can never collide with live data.
 *
 * The publication policy the query API applies in SQL reads three columns
 * here: `hidden_at IS NULL`, `rating >= projects.min_rating`, and for
 * unrated reviews `sentiment <> 'negative'`. `sentiment` is filled from the
 * star rating when there is one (`sentiment_source = 'rating'`) and from the
 * Workers AI classifier otherwise (`'model'`); both are nullable because a
 * review is stored before the pipeline has looked at it.
 *
 * `indexed_at` is the pipeline's "chunks and embeddings exist" marker; the
 * API reports `status: "indexing"` while it is null. `index_attempts`
 * counts how many times the pipeline's re-enqueue sweep (#72) has put a
 * still-unindexed review back on the queue; the sweep stops at five so a
 * review the pipeline can never index is not re-sent every five minutes
 * forever, and a successful index resets it to 0. `metadata` is the
 * customer's flat string→string map (`{"location": "north"}`) and is
 * filterable at query time; it is jsonb rather than columns because its
 * keys are the customer's, not ours.
 *
 * Deleting a review cascades to its chunks; deleting a project cascades to
 * its reviews. There is no soft delete — `hidden_at` is the "keep but never
 * show" state and a DELETE really deletes.
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { environmentEnum, id, timestamps } from "./shared.js";
import { projects } from "./tenancy.js";

export const SENTIMENTS = ["positive", "neutral", "negative"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];
export const sentimentEnum = pgEnum("sentiment", SENTIMENTS);

export const SENTIMENT_SOURCES = ["rating", "model"] as const;
export type SentimentSource = (typeof SENTIMENT_SOURCES)[number];
export const sentimentSourceEnum = pgEnum(
  "sentiment_source",
  SENTIMENT_SOURCES,
);

/** Customer-supplied, flat, string-valued; filterable as `metadata.<key>`. */
export type ReviewMetadata = Record<string, string>;

export const reviews = pgTable(
  "reviews",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environment: environmentEnum("environment").notNull(),
    /**
     * Free string from a known set (`google`, `yelp`, `facebook`,
     * `trustpilot`, `custom`). Text rather than an enum so a new source is a
     * code change, not a migration.
     */
    source: text("source").notNull(),
    /** The source's own id for this review; the upsert key with `source`. */
    externalId: text("external_id").notNull(),
    /** 1–5 stars; null for sources without ratings. */
    rating: smallint("rating"),
    text: text("text").notNull(),
    authorName: text("author_name"),
    authorAvatarUrl: text("author_avatar_url"),
    /** When the review was written at the source. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    /** Canonical URL of the review at its source, for attribution links. */
    url: text("url"),
    /** BCP 47 tag as reported by the source or detected; null when unknown. */
    language: text("language"),
    metadata: jsonb("metadata")
      .$type<ReviewMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    sentiment: sentimentEnum("sentiment"),
    sentimentSource: sentimentSourceEnum("sentiment_source"),
    /** Publication policy: non-null hides the review from every query. */
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    /** Set by the pipeline once chunks and embeddings exist. */
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    /** Re-enqueue sweeps so far while `indexed_at` stayed null (#72); 0 after a successful index. */
    indexAttempts: smallint("index_attempts").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    unique("reviews_project_env_source_external_id_unique").on(
      table.projectId,
      table.environment,
      table.source,
      table.externalId,
    ),
    // Every per-tenant read of `reviews` starts from "this project, this
    // environment": the search statements' joins (#111), the no-query
    // recency statement, the CRUD and dashboard list routes, and the
    // onboarding/import counts. The trailing `occurred_at DESC NULLS LAST,
    // id` matches the recency statement's ORDER BY exactly, so "newest
    // `limit` publishable reviews" is an index scan that stops after
    // `limit` rows instead of a seq scan of every tenant plus a top-N sort
    // (#117: 8.2 → 0.8 ms for a 1,000-review tenant in a 45k-row table).
    // The former `reviews_project_id_environment_idx` was this index's
    // prefix and is dropped in 0006; equality lookups on the prefix read the
    // same leaf pages here. Not partial on `hidden_at IS NULL`: measured
    // identical for recency, and the list routes filter on hidden rows too.
    index("reviews_project_id_environment_occurred_at_idx").on(
      table.projectId,
      table.environment,
      table.occurredAt.desc().nullsLast(),
      table.id,
    ),
    // The re-enqueue sweep (#72) scans "unindexed, oldest first" across all
    // tenants every five minutes; a partial index keeps that a few rows
    // wide no matter how large `reviews` grows.
    index("reviews_unindexed_updated_at_idx")
      .on(table.updatedAt)
      .where(sql`${table.indexedAt} IS NULL`),
    check(
      "reviews_rating_range",
      sql`${table.rating} IS NULL OR (${table.rating} BETWEEN 1 AND 5)`,
    ),
  ],
);
