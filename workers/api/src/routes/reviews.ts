/**
 * `POST /v1/reviews` — the push API (scope.md §3 "Ingest"; issue #21).
 *
 * Secret key only. Body: one review or an array of up to 100
 * (`reviewIngestBodySchema` from @proofql/core). Upsert keyed on
 * `(project_id, environment, source, external_id)`, where project and
 * environment come from the key, never the body:
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
 * so a batch either lands whole or not at all, and two concurrent batches
 * cannot both squeeze under the cap. The queue is written after the
 * transaction commits; a consumer that runs on a stale message just
 * re-reads the current row.
 *
 * Every request past auth leaves an `ingest_runs` row (kind `api`) with
 * its counts, or `status = failed` and the error message.
 */

import {
  type IngestMessage,
  type ReviewInput,
  reviewBatchSchema,
  reviewInputSchema,
  reviewLimitForPlan,
  sentimentFromRating,
} from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { requireSecretKey } from "../auth.js";
import type { AppEnv, AuthContext } from "../bindings.js";
import { ApiError, type ValidationIssue } from "../errors.js";

/** Hard ceiling on the request body; 100 maximal reviews are ~2 MB short of it. */
export const REVIEW_BODY_LIMIT_BYTES = 1024 * 1024;

export type ReviewStatus = "indexing" | "indexed";

export interface IngestedReview {
  id: string;
  external_id: string;
  source: string;
  status: ReviewStatus;
}

export interface IngestResponse {
  reviews: IngestedReview[];
}

export const reviewsRoutes = new Hono<AppEnv>();

reviewsRoutes.post(
  "/",
  bodyLimit({
    maxSize: REVIEW_BODY_LIMIT_BYTES,
    onError: () => {
      throw new ApiError(
        "payload_too_large",
        `Request body exceeds ${REVIEW_BODY_LIMIT_BYTES} bytes. Send at most 100 reviews per request.`,
      );
    },
  }),
  requireSecretKey,
  async (c) => {
    const auth = c.get("auth");
    const db = c.get("getDb")();
    let received = 0;

    try {
      const inputs = await parseBody(c.req.raw);
      received = inputs.length;
      const { unique, skipped } = dedupeLastWins(inputs);

      const { result, messages } = await db.transaction((tx) =>
        upsertReviews(tx, auth, unique),
      );

      if (messages.length > 0) {
        await c.env.INGEST_QUEUE.sendBatch(messages.map((body) => ({ body })));
      }

      await db.insert(schema.ingestRuns).values({
        projectId: auth.projectId,
        environment: auth.environment,
        kind: "api",
        status: "succeeded",
        received,
        created: result.created,
        updated: result.updated,
        skipped,
        finishedAt: new Date(),
      });

      const body: IngestResponse = { reviews: result.reviews };
      return c.json(body, 200);
    } catch (error) {
      await recordFailure(db, auth, received, error);
      throw error;
    }
  },
);

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

interface UpsertResult {
  reviews: IngestedReview[];
  created: number;
  updated: number;
}

async function upsertReviews(
  tx: Tx,
  auth: AuthContext,
  inputs: ReviewInput[],
): Promise<{ result: UpsertResult; messages: IngestMessage[] }> {
  const { projectId, environment } = auth;

  // Lock the project row for the rest of the transaction: the cap check and
  // the review_count increment below must be serialized across batches.
  const [project] = await tx
    .select({
      reviewCount: schema.projects.reviewCount,
      plan: schema.accounts.plan,
    })
    .from(schema.projects)
    .innerJoin(
      schema.accounts,
      eq(schema.accounts.id, schema.projects.accountId),
    )
    .where(eq(schema.projects.id, projectId))
    .for("update", { of: schema.projects });
  if (project === undefined) {
    // The key's project was deleted between auth and here (cascade removes
    // the key too); the caller's credential is simply no longer valid.
    throw new ApiError("unauthorized", "Unknown or revoked API key.");
  }

  const existing = await findExisting(tx, projectId, environment, inputs);
  const existingByKey = new Map(
    existing.map((row) => [upsertKey(row.source, row.externalId), row]),
  );

  const toInsert: ReviewInput[] = [];
  const toUpdate: { input: ReviewInput; row: ExistingRow }[] = [];
  for (const input of inputs) {
    const row = existingByKey.get(upsertKey(input.source, input.external_id));
    if (row === undefined) toInsert.push(input);
    else toUpdate.push({ input, row });
  }

  const limit = reviewLimitForPlan(project.plan);
  if (project.reviewCount + toInsert.length > limit) {
    const remaining = Math.max(0, limit - project.reviewCount);
    throw new ApiError(
      "review_limit_reached",
      `This project can hold ${limit} reviews on its plan; it has ${project.reviewCount} and this request would add ${toInsert.length} (${remaining} remaining). Nothing was written.`,
    );
  }

  const stored = new Map<string, IngestedReview>();
  const messages: IngestMessage[] = [];
  const message = (reviewId: string): IngestMessage => ({
    type: "review.index",
    reviewId,
    projectId,
    environment,
  });

  if (toInsert.length > 0) {
    const inserted = await tx
      .insert(schema.reviews)
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
      messages.push(message(row.id));
    }
  }

  const now = new Date();
  for (const { input, row } of toUpdate) {
    const textChanged = input.text !== row.text;
    const ratingRemoved = input.rating === null && row.rating !== null;
    const reindex = textChanged || ratingRemoved;
    const [updated] = await tx
      .update(schema.reviews)
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
      .where(eq(schema.reviews.id, row.id))
      .returning(returningColumns);
    if (updated === undefined) {
      throw new Error(`review ${row.id} vanished mid-transaction`);
    }
    stored.set(
      upsertKey(updated.source, updated.externalId),
      toIngested(updated),
    );
    if (reindex) messages.push(message(updated.id));
  }

  if (toInsert.length > 0) {
    await tx
      .update(schema.projects)
      .set({
        reviewCount: sql`${schema.projects.reviewCount} + ${toInsert.length}`,
      })
      .where(eq(schema.projects.id, projectId));
  }

  // Response in request order.
  const reviews = inputs.map((input) => {
    const row = stored.get(upsertKey(input.source, input.external_id));
    if (row === undefined) {
      throw new Error(`no stored row for ${input.source}/${input.external_id}`);
    }
    return row;
  });

  return {
    result: { reviews, created: toInsert.length, updated: toUpdate.length },
    messages,
  };
}

const returningColumns = {
  id: schema.reviews.id,
  source: schema.reviews.source,
  externalId: schema.reviews.externalId,
  indexedAt: schema.reviews.indexedAt,
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
  environment: AuthContext["environment"],
  inputs: ReviewInput[],
): Promise<ExistingRow[]> {
  const idsBySource = new Map<string, string[]>();
  for (const input of inputs) {
    const ids = idsBySource.get(input.source) ?? [];
    ids.push(input.external_id);
    idsBySource.set(input.source, ids);
  }
  const bySource = [...idsBySource].map(([source, ids]) =>
    and(
      eq(schema.reviews.source, source),
      inArray(schema.reviews.externalId, ids),
    ),
  );
  return tx
    .select({
      id: schema.reviews.id,
      source: schema.reviews.source,
      externalId: schema.reviews.externalId,
      text: schema.reviews.text,
      rating: schema.reviews.rating,
      indexedAt: schema.reviews.indexedAt,
    })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.projectId, projectId),
        eq(schema.reviews.environment, environment),
        or(...bySource),
      ),
    );
}

/** `\0` cannot appear in either part, so the join is unambiguous. */
function upsertKey(source: string, externalId: string): string {
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

/**
 * JSON → validated `ReviewInput[]`. The array and single-object branches are
 * chosen by shape before zod runs so issue paths read `0.rating`, not a
 * union-failure tree.
 */
async function parseBody(request: Request): Promise<ReviewInput[]> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    throw new ApiError("validation_failed", "Request body is not valid JSON.", {
      details: [{ path: "", message: "Request body is not valid JSON." }],
    });
  }
  const result = Array.isArray(json)
    ? reviewBatchSchema.safeParse(json)
    : reviewInputSchema
        .transform((review): ReviewInput[] => [review])
        .safeParse(json);
  if (!result.success) {
    throw new ApiError("validation_failed", "Request body failed validation.", {
      details: flattenIssues(result.error.issues),
    });
  }
  return result.data;
}

export function flattenIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): ValidationIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/** Best effort: a failed run is recorded, but never masks the real error. */
async function recordFailure(
  db: Db,
  auth: AuthContext,
  received: number,
  error: unknown,
): Promise<void> {
  const message =
    error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : "internal: unhandled error";
  try {
    await db.insert(schema.ingestRuns).values({
      projectId: auth.projectId,
      environment: auth.environment,
      kind: "api",
      status: "failed",
      received,
      failed: received,
      error: message.slice(0, 1000),
      finishedAt: new Date(),
    });
  } catch {
    // The database is the likely cause of the original failure; the caller
    // is about to surface that one.
  }
}
