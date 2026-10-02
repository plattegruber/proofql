/**
 * The one write path for reviews (scope.md §3 "Ingest"; issues #21, #38).
 *
 * `POST /v1/reviews` and the dashboard's CSV import both call this, so a
 * review is stored the same way regardless of where it came from. Upsert
 * keyed on `(project_id, environment, source, external_id)`:
 *
 *   - new                         → insert, `indexed_at` null, enqueue
 *   - exists, text changed        → update everything, `indexed_at` null, enqueue
 *   - exists, text unchanged      → update the mutable non-text fields only
 *   - rating removed (→ null)     → sentiment must now come from the model:
 *                                   treated like a text change (enqueue)
 *
 * Duplicates of one `(source, external_id)` inside a batch collapse to the
 * last occurrence (counted as `skipped`). The plan's review cap is checked
 * under a `FOR UPDATE` lock on the project row before anything is written,
 * so two concurrent batches cannot both squeeze under the cap. Two cap
 * policies: `reject` (the API: the batch lands whole or not at all, via
 * `ReviewLimitError`) and `truncate` (the CSV import: insert what fits, in
 * input order, and hand the rest back as `rejected`).
 *
 * The function owns its transaction and returns the queue messages rather
 * than sending them: the caller writes the queue after the commit, so a
 * consumer never runs on a row that was rolled back.
 */

import {
  type IngestMessage,
  PRICING_URL,
  planFor,
  planLabel,
  type ReviewInput,
  sentimentFromRating,
} from "@proofql/core";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import type { Db } from "../client.js";
import { reviews } from "../schema/reviews.js";
import type { Environment } from "../schema/shared.js";
import { accounts, projects } from "../schema/tenancy.js";

export type ReviewStatus = "indexing" | "indexed";

/** A stored review as the push API reports it. */
export interface IngestedReview {
  id: string;
  external_id: string;
  source: string;
  status: ReviewStatus;
}

export type ReviewLimitPolicy = "reject" | "truncate";

export interface UpsertReviewsParams {
  projectId: string;
  environment: Environment;
  /** May contain duplicates; the last occurrence of a key wins. */
  reviews: ReviewInput[];
  /** What to do when inserts would pass the plan cap. Default `reject`. */
  onLimit?: ReviewLimitPolicy;
}

export interface UpsertReviewsResult {
  /** Stored rows in (deduplicated) input order; rejected rows are absent. */
  reviews: IngestedReview[];
  created: number;
  updated: number;
  /** In-batch duplicates collapsed away. */
  skipped: number;
  /** Inserts refused by the cap (`truncate` only; always empty for `reject`). */
  rejected: ReviewInput[];
  /** The plan's cap and the project's review count after this call. */
  limit: number;
  reviewCount: number;
  /** One message per review that needs (re)indexing; send after commit. */
  toEnqueue: IngestMessage[];
}

/** `reject` policy: the batch would pass the cap. Nothing was written. */
export class ReviewLimitError extends Error {
  override readonly name = "ReviewLimitError";
  readonly remaining: number;
  constructor(
    readonly limit: number,
    readonly reviewCount: number,
    readonly wouldAdd: number,
    readonly plan: string = "free",
  ) {
    const remaining = Math.max(0, limit - reviewCount);
    super(
      `This project can hold ${limit} reviews on the ${planLabel(plan)} plan; it has ${reviewCount} and this request would add ${wouldAdd} (${remaining} remaining). Nothing was written. Upgrade at ${PRICING_URL} to raise the limit, or delete reviews to make room.`,
    );
    this.remaining = remaining;
  }
}

/** The project row is gone (deleted between the caller's auth and here). */
export class ProjectNotFoundError extends Error {
  override readonly name = "ProjectNotFoundError";
  constructor(readonly projectId: string) {
    super(`project ${projectId} not found`);
  }
}

/** Drizzle's transaction client; structurally what the queries below need. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type ExistingRow = {
  id: string;
  source: string;
  externalId: string;
  text: string;
  rating: number | null;
  indexedAt: Date | null;
};

export async function upsertReviews(
  db: Db,
  params: UpsertReviewsParams,
): Promise<UpsertReviewsResult> {
  const { projectId, environment } = params;
  const onLimit = params.onLimit ?? "reject";
  const { unique: inputs, skipped } = dedupeLastWins(params.reviews);

  return db.transaction(async (tx) => {
    // Lock the project row for the rest of the transaction: the cap check
    // and the review_count increment below must be serialized across
    // batches.
    const [project] = await tx
      .select({
        reviewCount: projects.reviewCount,
        plan: accounts.plan,
      })
      .from(projects)
      .innerJoin(accounts, eq(accounts.id, projects.accountId))
      .where(eq(projects.id, projectId))
      .for("update", { of: projects });
    if (project === undefined) throw new ProjectNotFoundError(projectId);

    const existing =
      inputs.length === 0
        ? []
        : await findExisting(tx, projectId, environment, inputs);
    const existingByKey = new Map(
      existing.map((row) => [upsertKey(row.source, row.externalId), row]),
    );

    let toInsert: ReviewInput[] = [];
    const toUpdate: { input: ReviewInput; row: ExistingRow }[] = [];
    for (const input of inputs) {
      const row = existingByKey.get(upsertKey(input.source, input.external_id));
      if (row === undefined) toInsert.push(input);
      else toUpdate.push({ input, row });
    }

    const limit = planFor(project.plan).reviewsPerProject;
    let rejected: ReviewInput[] = [];
    if (project.reviewCount + toInsert.length > limit) {
      if (onLimit === "reject") {
        throw new ReviewLimitError(
          limit,
          project.reviewCount,
          toInsert.length,
          project.plan,
        );
      }
      const room = Math.max(0, limit - project.reviewCount);
      rejected = toInsert.slice(room);
      toInsert = toInsert.slice(0, room);
    }
    const rejectedKeys = new Set(
      rejected.map((r) => upsertKey(r.source, r.external_id)),
    );

    const stored = new Map<string, IngestedReview>();
    const toEnqueue: IngestMessage[] = [];
    const message = (reviewId: string): IngestMessage => ({
      type: "review.index",
      reviewId,
      projectId,
      environment,
    });

    if (toInsert.length > 0) {
      const inserted = await tx
        .insert(reviews)
        .values(
          toInsert.map((input) => ({
            projectId,
            environment,
            source: input.source,
            externalId: input.external_id,
            ...mutableColumns(input),
            text: input.text,
            ...sentimentColumns(input.rating),
          })),
        )
        .returning(returningColumns);
      for (const row of inserted) {
        stored.set(upsertKey(row.source, row.externalId), toIngested(row));
        toEnqueue.push(message(row.id));
      }
    }

    const now = new Date();
    for (const { input, row } of toUpdate) {
      const textChanged = input.text !== row.text;
      const ratingRemoved = input.rating === null && row.rating !== null;
      const reindex = textChanged || ratingRemoved;
      const [updated] = await tx
        .update(reviews)
        .set({
          ...mutableColumns(input),
          updatedAt: now,
          ...(textChanged ? { text: input.text } : {}),
          // Rating present: sentiment is derived from it, always. Rating
          // absent: only the model can say, and only a reindex runs it, so
          // leave a previously computed model sentiment alone otherwise.
          ...(input.rating !== null || ratingRemoved
            ? sentimentColumns(input.rating)
            : {}),
          ...(reindex ? { indexedAt: null } : {}),
        })
        .where(eq(reviews.id, row.id))
        .returning(returningColumns);
      if (updated === undefined) {
        throw new Error(`review ${row.id} vanished mid-transaction`);
      }
      stored.set(
        upsertKey(updated.source, updated.externalId),
        toIngested(updated),
      );
      if (reindex) toEnqueue.push(message(updated.id));
    }

    if (toInsert.length > 0) {
      await tx
        .update(projects)
        .set({
          reviewCount: sql`${projects.reviewCount} + ${toInsert.length}`,
        })
        .where(eq(projects.id, projectId));
    }

    // Response in request order, minus what the cap refused.
    const result: IngestedReview[] = [];
    for (const input of inputs) {
      const key = upsertKey(input.source, input.external_id);
      if (rejectedKeys.has(key)) continue;
      const row = stored.get(key);
      if (row === undefined) {
        throw new Error(
          `no stored row for ${input.source}/${input.external_id}`,
        );
      }
      result.push(row);
    }

    return {
      reviews: result,
      created: toInsert.length,
      updated: toUpdate.length,
      skipped,
      rejected,
      limit,
      reviewCount: project.reviewCount + toInsert.length,
      toEnqueue,
    };
  });
}

const returningColumns = {
  id: reviews.id,
  source: reviews.source,
  externalId: reviews.externalId,
  indexedAt: reviews.indexedAt,
};

function toIngested(row: {
  id: string;
  source: string;
  externalId: string;
  indexedAt: Date | null;
}): IngestedReview {
  return {
    id: row.id,
    external_id: row.externalId,
    source: row.source,
    status: row.indexedAt === null ? "indexing" : "indexed",
  };
}

/** Columns every upsert writes, whether or not the text changed. */
function mutableColumns(input: ReviewInput) {
  return {
    rating: input.rating,
    authorName: input.author_name,
    authorAvatarUrl: input.author_avatar_url,
    occurredAt: new Date(input.occurred_at),
    url: input.url,
    language: input.language ?? null,
    metadata: input.metadata ?? {},
  };
}

/** Rating → sentiment here; no rating → null for the pipeline's classifier. */
function sentimentColumns(rating: number | null) {
  return rating === null
    ? { sentiment: null, sentimentSource: null }
    : {
        sentiment: sentimentFromRating(rating),
        sentimentSource: "rating" as const,
      };
}

/** The rows this batch would touch, one `IN (...)` per source. */
async function findExisting(
  tx: Tx,
  projectId: string,
  environment: Environment,
  inputs: ReviewInput[],
): Promise<ExistingRow[]> {
  const idsBySource = new Map<string, string[]>();
  for (const input of inputs) {
    const ids = idsBySource.get(input.source) ?? [];
    ids.push(input.external_id);
    idsBySource.set(input.source, ids);
  }
  const bySource = [...idsBySource].map(([source, ids]) =>
    and(eq(reviews.source, source), inArray(reviews.externalId, ids)),
  );
  return tx
    .select({
      id: reviews.id,
      source: reviews.source,
      externalId: reviews.externalId,
      text: reviews.text,
      rating: reviews.rating,
      indexedAt: reviews.indexedAt,
    })
    .from(reviews)
    .where(
      and(
        eq(reviews.projectId, projectId),
        eq(reviews.environment, environment),
        or(...bySource),
      ),
    );
}

/** `\0` cannot appear in either part, so the join is unambiguous. */
export function upsertKey(source: string, externalId: string): string {
  return `${source}\0${externalId}`;
}

/** Collapse repeated `(source, external_id)` to the last occurrence. */
export function dedupeLastWins(inputs: ReviewInput[]): {
  unique: ReviewInput[];
  skipped: number;
} {
  const byKey = new Map<string, ReviewInput>();
  for (const input of inputs) {
    const key = upsertKey(input.source, input.external_id);
    byKey.delete(key); // re-insert so the surviving entry takes the LAST position
    byKey.set(key, input);
  }
  return { unique: [...byKey.values()], skipped: inputs.length - byKey.size };
}
