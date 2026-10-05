/**
 * Review management: `GET /v1/reviews`, `GET|PATCH|DELETE /v1/reviews/:id`
 * (scope.md §3 "Ingest", issue #22). The ingest `POST /v1/reviews` lives in
 * ./reviews.ts; both routers mount at the same prefix.
 *
 * Secret key only — these are server-side management calls, and a hidden
 * review must never be readable from a browser key. Every query is scoped
 * by the key's `(project_id, environment)`: a review in another project or
 * in the other environment of the same project is a 404, indistinguishable
 * from one that never existed.
 *
 *   - GET  /            keyset pagination on `(occurred_at, id)` plus the
 *                       filters the dashboard's review browser needs
 *   - GET  /:id         one review
 *   - PATCH /:id        `hidden` (sets/clears `hidden_at`) and/or `metadata`
 *                       (replaces the map); a no-op body changes nothing
 *   - DELETE /:id       the row (chunks cascade) and `projects.review_count`
 *                       in one transaction; 204
 *
 * Anything that can change what a query returns — hide, unhide, metadata
 * (filterable), delete — bumps the project's cache generation after the
 * transaction commits (`bumpGeneration`, ../edge-cache.ts; #28). A bump
 * that fails — KV's daily write limit — is logged and swallowed (#158):
 * the edit has committed, and the cached entries age out with their TTL.
 */

import { REQUEST_BODY_LIMITS } from "@proofql/core";
import { schema } from "@proofql/db";
import {
  and,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { requireSecretKey } from "../auth.js";
import type { AppEnv, AuthContext } from "../bindings.js";
import { bumpGeneration } from "../edge-cache.js";
import { ApiError } from "../errors.js";
import { flattenIssues, type ReviewStatus } from "./reviews.js";
import {
  type Cursor,
  cursorFor,
  decodeCursor,
  encodeCursor,
  type ListQuery,
  listQuerySchema,
  type PatchBody,
  patchBodySchema,
} from "./reviews-crud-request.js";

/** A maximal metadata map is ~18 KB; anything near this is not a PATCH. */
export const PATCH_BODY_LIMIT_BYTES = REQUEST_BODY_LIMITS.reviewPatch;

type ReviewRow = typeof schema.reviews.$inferSelect;

/** The wire shape of a review on every CRUD response. */
export interface ReviewResource {
  id: string;
  external_id: string;
  source: string;
  rating: number | null;
  text: string;
  author_name: string | null;
  author_avatar_url: string | null;
  occurred_at: string | null;
  url: string | null;
  language: string | null;
  metadata: Record<string, string>;
  sentiment: ReviewRow["sentiment"];
  sentiment_source: ReviewRow["sentimentSource"];
  hidden: boolean;
  status: ReviewStatus;
  created_at: string;
  updated_at: string;
}

export interface ListReviewsResponse {
  reviews: ReviewResource[];
  /** Pass back as `?cursor=` for the next page; null on the last page. */
  next_cursor: string | null;
}

export function toResource(row: ReviewRow): ReviewResource {
  return {
    id: row.id,
    external_id: row.externalId,
    source: row.source,
    rating: row.rating,
    text: row.text,
    author_name: row.authorName,
    author_avatar_url: row.authorAvatarUrl,
    occurred_at: row.occurredAt?.toISOString() ?? null,
    url: row.url,
    language: row.language,
    metadata: row.metadata,
    sentiment: row.sentiment,
    sentiment_source: row.sentimentSource,
    hidden: row.hiddenAt !== null,
    status: row.indexedAt === null ? "indexing" : "indexed",
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export const reviewsCrudRoutes = new Hono<AppEnv>();

reviewsCrudRoutes.get("/", requireSecretKey, async (c) => {
  const query = parseListQuery(c.req.query());
  const auth = c.get("auth");
  const db = c.get("getDb")();

  // One extra row tells us whether a next page exists without a count.
  const rows = await db
    .select()
    .from(schema.reviews)
    .where(and(scope(auth), ...filters(query)))
    .orderBy(sql`${occurredKey} DESC NULLS LAST`, desc(schema.reviews.id))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const body: ListReviewsResponse = {
    reviews: page.map(toResource),
    next_cursor:
      rows.length > query.limit && last !== undefined
        ? encodeCursor(cursorFor(last))
        : null,
  };
  return c.json(body, 200);
});

reviewsCrudRoutes.get("/:id", requireSecretKey, async (c) => {
  const id = reviewId(c.req.param("id"));
  const auth = c.get("auth");
  const db = c.get("getDb")();

  const [row] = await db
    .select()
    .from(schema.reviews)
    .where(and(eq(schema.reviews.id, id), scope(auth)))
    .limit(1);
  if (row === undefined) throw notFound(id);

  return c.json(toResource(row), 200);
});

reviewsCrudRoutes.patch(
  "/:id",
  bodyLimit({
    maxSize: PATCH_BODY_LIMIT_BYTES,
    onError: () => {
      throw new ApiError(
        "payload_too_large",
        `Request body exceeds ${PATCH_BODY_LIMIT_BYTES} bytes.`,
      );
    },
  }),
  requireSecretKey,
  async (c) => {
    const id = reviewId(c.req.param("id"));
    const auth = c.get("auth");
    const db = c.get("getDb")();
    const patch = await parsePatchBody(c.req.raw);

    const { row, changed } = await db.transaction(async (tx) => {
      // Lock the row so two PATCHes serialize and "changed" is decided
      // against the state this update is actually applied to.
      const [current] = await tx
        .select()
        .from(schema.reviews)
        .where(and(eq(schema.reviews.id, id), scope(auth)))
        .for("update");
      if (current === undefined) throw notFound(id);

      const updates = diffPatch(current, patch);
      if (updates === null) return { row: current, changed: false };

      const [updated] = await tx
        .update(schema.reviews)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(schema.reviews.id, current.id))
        .returning();
      if (updated === undefined) throw notFound(id);
      return { row: updated, changed: true };
    });

    // After commit: hidden and metadata both affect what a query returns.
    // Never throws (#158): a failed bump is logged; the edit stands.
    if (changed) await bumpGeneration(c, auth.projectId);

    return c.json(toResource(row), 200);
  },
);

reviewsCrudRoutes.delete("/:id", requireSecretKey, async (c) => {
  const id = reviewId(c.req.param("id"));
  const auth = c.get("auth");
  const db = c.get("getDb")();

  await db.transaction(async (tx) => {
    // Take the project lock first, in the same order as ingest (which locks
    // the project before touching review rows), so the two never deadlock.
    // `review_count` is a cached figure; the floor keeps a drifted counter
    // from going negative rather than hiding a bug.
    await tx
      .update(schema.projects)
      .set({
        reviewCount: sql`GREATEST(${schema.projects.reviewCount} - 1, 0)`,
      })
      .where(eq(schema.projects.id, auth.projectId));

    // Chunks go with the row via `ON DELETE CASCADE`.
    const deleted = await tx
      .delete(schema.reviews)
      .where(and(eq(schema.reviews.id, id), scope(auth)))
      .returning({ id: schema.reviews.id });
    // Throwing rolls the decrement back too.
    if (deleted.length === 0) throw notFound(id);
  });

  await bumpGeneration(c, auth.projectId);

  return c.body(null, 204);
});

// ---------------------------------------------------------------------------

/** Every query starts here: the key's project and environment. */
function scope(auth: AuthContext): SQL {
  return and(
    eq(schema.reviews.projectId, auth.projectId),
    eq(schema.reviews.environment, auth.environment),
  ) as SQL;
}

/**
 * The sort key. JS Dates carry milliseconds while the column stores
 * microseconds; truncating on both the ORDER BY and the cursor comparison
 * keeps the keyset exact for any row, whoever wrote it.
 */
const occurredKey = sql`date_trunc('milliseconds', ${schema.reviews.occurredAt})`;

function filters(query: ListQuery): SQL[] {
  const out: SQL[] = [];
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(query.cursor);
    if (cursor === null) {
      throw new ApiError("validation_failed", "Invalid pagination cursor.", {
        details: [{ path: "cursor", message: "Invalid pagination cursor." }],
      });
    }
    out.push(afterCursor(cursor));
  }
  if (query.source !== undefined) {
    out.push(eq(schema.reviews.source, query.source));
  }
  if (query.min_rating !== undefined) {
    out.push(gte(schema.reviews.rating, query.min_rating));
  }
  if (query.hidden === "true") out.push(isNotNull(schema.reviews.hiddenAt));
  if (query.hidden === "false") out.push(isNull(schema.reviews.hiddenAt));
  if (query.since !== undefined) {
    out.push(gte(schema.reviews.occurredAt, new Date(query.since)));
  }
  if (query.indexed === "true") out.push(isNotNull(schema.reviews.indexedAt));
  if (query.indexed === "false") out.push(isNull(schema.reviews.indexedAt));
  return out;
}

/** Rows strictly after `cursor` in `(occurred_at DESC NULLS LAST, id DESC)`. */
function afterCursor(cursor: Cursor): SQL {
  if (cursor.o === null) {
    // Inside the trailing null block: only the id orders.
    return and(
      isNull(schema.reviews.occurredAt),
      lt(schema.reviews.id, cursor.i),
    ) as SQL;
  }
  const at = sql`${cursor.o}::timestamptz`;
  return or(
    sql`${occurredKey} < ${at}`,
    and(sql`${occurredKey} = ${at}`, lt(schema.reviews.id, cursor.i)),
    isNull(schema.reviews.occurredAt),
  ) as SQL;
}

/**
 * The columns a PATCH would change, or null when the body already describes
 * the row (so no write, no `updated_at` churn, no cache purge).
 */
function diffPatch(
  current: ReviewRow,
  patch: PatchBody,
): Partial<Pick<ReviewRow, "hiddenAt" | "metadata">> | null {
  const updates: Partial<Pick<ReviewRow, "hiddenAt" | "metadata">> = {};
  if (patch.hidden === true && current.hiddenAt === null) {
    updates.hiddenAt = new Date();
  } else if (patch.hidden === false && current.hiddenAt !== null) {
    updates.hiddenAt = null;
  }
  if (
    patch.metadata !== undefined &&
    !sameMetadata(current.metadata, patch.metadata)
  ) {
    updates.metadata = patch.metadata;
  }
  return Object.keys(updates).length === 0 ? null : updates;
}

function sameMetadata(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids are uuids; anything else cannot name a row, so it is a 404 up front. */
function reviewId(raw: string): string {
  if (!UUID_RE.test(raw)) throw notFound(raw);
  return raw;
}

function notFound(id: string): ApiError {
  return new ApiError("not_found", `No review ${id} in this project.`);
}

function parseListQuery(raw: Record<string, string>): ListQuery {
  const result = listQuerySchema.safeParse(raw);
  if (!result.success) {
    throw new ApiError("validation_failed", "Query string failed validation.", {
      details: flattenIssues(result.error.issues),
    });
  }
  return result.data;
}

async function parsePatchBody(request: Request): Promise<PatchBody> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    throw new ApiError("validation_failed", "Request body is not valid JSON.", {
      details: [{ path: "", message: "Request body is not valid JSON." }],
    });
  }
  const result = patchBodySchema.safeParse(json);
  if (!result.success) {
    throw new ApiError("validation_failed", "Request body failed validation.", {
      details: flattenIssues(result.error.issues),
    });
  }
  return result.data;
}
