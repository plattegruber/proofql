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
 * A failed queue write does not fail the request (#159). The rows are
 * committed with `indexed_at` null, and the pipeline's five-minute sweep
 * re-enqueues every unindexed review, so the response is the normal 200
 * receipt (those reviews report `status: "indexing"`) with a top-level
 * `indexing: "deferred"`. The usual cause is the Workers Free plan's daily
 * Queues operations limit; indexing then catches up after 00:00 UTC.
 * `enqueueOrDefer` (@proofql/core) logs it: `quota.exhausted` at error for
 * the limit, `ingest.enqueue_deferred` at warn for anything else.
 *
 * The upsert itself is `upsertReviews` in @proofql/db (#38 moved it there
 * so the dashboard's CSV import writes reviews through the same code);
 * this route owns parsing, the API error mapping, the queue write and the
 * `ingest_runs` row.
 *
 * Every request past auth leaves an `ingest_runs` row (kind `api`) with
 * its counts, or `status = failed` and the error message.
 */

import {
  enqueueOrDefer,
  REQUEST_BODY_LIMITS,
  type ReviewInput,
  reviewBatchSchema,
  reviewInputSchema,
} from "@proofql/core";
import {
  type Db,
  type IngestedReview,
  ProjectNotFoundError,
  ReviewLimitError,
  type ReviewStatus,
  schema,
  upsertReviews,
} from "@proofql/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { requireSecretKey } from "../auth.js";
import type { AppEnv, AuthContext } from "../bindings.js";
import { ApiError, type ValidationIssue } from "../errors.js";
import { logFor } from "../request-id.js";

/** Hard ceiling on the request body; 100 maximal reviews are ~2 MB short of it. */
export const REVIEW_BODY_LIMIT_BYTES = REQUEST_BODY_LIMITS.reviews;

/** Re-exported for tests; the implementation lives with the upsert in @proofql/db. */
export { dedupeLastWins } from "@proofql/db";
export type { IngestedReview, ReviewStatus };

export interface IngestResponse {
  reviews: IngestedReview[];
  /**
   * Present only when the reviews were stored but could not be queued for
   * indexing; the sweep indexes them later (module doc).
   */
  indexing?: "deferred";
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

      const result = await upsertReviews(db, {
        projectId: auth.projectId,
        environment: auth.environment,
        reviews: inputs,
        onLimit: "reject",
      }).catch((error: unknown) => {
        throw toApiError(error);
      });

      const enqueued = await enqueueOrDefer(
        c.env.INGEST_QUEUE,
        result.toEnqueue,
        {
          log: logFor(c).child({
            project_id: auth.projectId,
            key_environment: auth.environment,
          }),
          site: "api.ingest",
        },
      );

      await db.insert(schema.ingestRuns).values({
        projectId: auth.projectId,
        environment: auth.environment,
        kind: "api",
        status: "succeeded",
        received,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        finishedAt: new Date(),
      });

      const body: IngestResponse = enqueued.sent
        ? { reviews: result.reviews }
        : { reviews: result.reviews, indexing: "deferred" };
      return c.json(body, 200);
    } catch (error) {
      await recordFailure(db, auth, received, error);
      throw error;
    }
  },
);

/**
 * The upsert's domain errors as API errors. The limit message is the
 * upsert's own — the contract clients see has not changed since #21.
 */
function toApiError(error: unknown): unknown {
  if (error instanceof ProjectNotFoundError) {
    // The key's project was deleted between auth and here (cascade removes
    // the key too); the caller's credential is simply no longer valid.
    return new ApiError("unauthorized", "Unknown or revoked API key.");
  }
  if (error instanceof ReviewLimitError) {
    return new ApiError("review_limit_reached", error.message);
  }
  return error;
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
