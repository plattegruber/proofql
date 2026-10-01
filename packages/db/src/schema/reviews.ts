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
 * API reports `status: "indexing"` while it is null. `metadata` is the
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
    ...timestamps,
  },
  (table) => [
    unique("reviews_project_env_source_external_id_unique").on(
      table.projectId,
      table.environment,
      table.source,
      table.externalId,
    ),
    // The query API's policy scan and the dashboard's review browser both
    // start from "this project, this environment".
    index("reviews_project_id_environment_idx").on(
      table.projectId,
      table.environment,
    ),
    check(
      "reviews_rating_range",
      sql`${table.rating} IS NULL OR (${table.rating} BETWEEN 1 AND 5)`,
    ),
  ],
);
