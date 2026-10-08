/**
 * Value lists the database stores as Postgres enums and that have no other
 * home in core (#61). `@proofql/db` passes each one straight into
 * `pgEnum(...)`, so this file and the schema cannot disagree; the other
 * enum-backed lists live with their logic (`SENTIMENTS` in sentiment.ts,
 * `API_KEY_KINDS` / `API_KEY_ENVIRONMENTS` in apiKeys.ts, `CHUNK_KINDS` in
 * chunking.ts, `PLAN_NAMES` in plans.ts).
 *
 * Adding a value here changes the database: it needs a migration
 * (`pnpm db:generate` emits `ALTER TYPE ... ADD VALUE`), and the enum test in
 * packages/db/src/schema/enums.test.ts checks every pg enum mirrors its
 * constant.
 */

/** Where a review's `sentiment` came from: the star rating, or the model (null rating). */
export const SENTIMENT_SOURCES = ["rating", "model"] as const;
export type SentimentSource = (typeof SENTIMENT_SOURCES)[number];

/** Connector kinds a project can connect (scope.md §6); Google is the first. */
export const CONNECTION_KINDS = ["google"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/** Lifecycle of a connection: polling, needs the owner to re-consent, or cut. */
export const CONNECTION_STATUSES = [
  "active",
  "needs_reauth",
  "disconnected",
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** How a batch of reviews arrived: the push API, a CSV upload, a connector poll, or a Places bootstrap. */
export const INGEST_RUN_KINDS = ["api", "csv", "google", "places"] as const;
export type IngestRunKind = (typeof INGEST_RUN_KINDS)[number];

/** Outcome of an ingest run. */
export const INGEST_RUN_STATUSES = ["running", "succeeded", "failed"] as const;
export type IngestRunStatus = (typeof INGEST_RUN_STATUSES)[number];
