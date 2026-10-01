/**
 * Row factories for integration tests.
 *
 * Each factory takes a `Db` and `Partial<Insert>` overrides, fills the rest
 * with defaults, INSERTs a real row (the point is exercising constraints —
 * no in-memory fakes), and returns the full selected row. Parents are
 * created on demand: `review(db)` with no `projectId` creates an account
 * and a project first; `chunk(db)` with no `reviewId` creates a review.
 *
 * Defaults are deterministic (no randomness): every value a constraint
 * requires to be unique (`clerk_org_id`, `slug`, `key_hash`,
 * `external_id`) combines a readable stem with a monotonic per-process
 * counter, so two no-arg calls in one database never collide and a failing
 * test reproduces identically.
 */

import { eq } from "drizzle-orm";

import { assertVerbatimSlice } from "../src/chunks.js";
import type { Db } from "../src/client.js";
import { apiKeys } from "../src/schema/apiKeys.js";
import { reviewChunks } from "../src/schema/reviewChunks.js";
import { reviews } from "../src/schema/reviews.js";
import { accounts, projects } from "../src/schema/tenancy.js";

/** Monotonic per-process counter — the uniqueness component of defaults. */
let seq = 0;
function nextSeq(): number {
  return ++seq;
}

function must<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`${what} insert returned no row`);
  return row;
}

type AccountInsert = typeof accounts.$inferInsert;
type ProjectInsert = typeof projects.$inferInsert;
type ApiKeyInsert = typeof apiKeys.$inferInsert;
type ReviewInsert = typeof reviews.$inferInsert;
type ChunkInsert = typeof reviewChunks.$inferInsert;

export type Account = typeof accounts.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type ReviewChunk = typeof reviewChunks.$inferSelect;

export async function account(
  db: Db,
  overrides: Partial<AccountInsert> = {},
): Promise<Account> {
  const n = nextSeq();
  const [row] = await db
    .insert(accounts)
    .values({
      clerkOrgId: `org_test_${n}`,
      name: `Test Account ${n}`,
      ...overrides,
    })
    .returning();
  return must(row, "account");
}

export async function project(
  db: Db,
  overrides: Partial<ProjectInsert> = {},
): Promise<Project> {
  const n = nextSeq();
  const accountId = overrides.accountId ?? (await account(db)).id;
  const [row] = await db
    .insert(projects)
    .values({
      name: `Test Project ${n}`,
      slug: `test-project-${n}`,
      ...overrides,
      accountId,
    })
    .returning();
  return must(row, "project");
}

/**
 * An `api_keys` row. `keyHash` defaults to a unique 64-hex string shaped
 * like a SHA-256 digest; real key generation and hashing live in
 * `@proofql/core`, not here.
 */
export async function apiKey(
  db: Db,
  overrides: Partial<ApiKeyInsert> = {},
): Promise<ApiKey> {
  const n = nextSeq();
  const projectId = overrides.projectId ?? (await project(db)).id;
  const kind = overrides.kind ?? "secret";
  const environment = overrides.environment ?? "live";
  const prefix = `pq_${kind === "secret" ? "sk" : "pk"}_${environment}_${n
    .toString(16)
    .padStart(4, "0")}`;
  const [row] = await db
    .insert(apiKeys)
    .values({
      keyHash: n.toString(16).padStart(64, "0"),
      prefix,
      ...overrides,
      projectId,
      kind,
      environment,
    })
    .returning();
  return must(row, "apiKey");
}

export const DEFAULT_REVIEW_TEXT =
  "Dr. Patel did my implant and I honestly forgot it wasn't my own tooth " +
  "within a week. The front desk explained every charge before I paid. " +
  "Parking behind the building was easy.";

export async function review(
  db: Db,
  overrides: Partial<ReviewInsert> = {},
): Promise<Review> {
  const n = nextSeq();
  const projectId = overrides.projectId ?? (await project(db)).id;
  const [row] = await db
    .insert(reviews)
    .values({
      environment: "live",
      source: "google",
      externalId: `ext_${n}`,
      rating: 5,
      text: DEFAULT_REVIEW_TEXT,
      authorName: `Author ${n}`,
      occurredAt: new Date("2026-03-14T18:20:00Z"),
      ...overrides,
      projectId,
    })
    .returning();
  return must(row, "review");
}

/**
 * A `review_chunks` row. Defaults to the parent review's `full` chunk
 * (whole text at offset 0) with `project_id`/`environment` copied from the
 * parent. The verbatim-slice invariant is asserted before the insert, as
 * the pipeline's write path does — pass `{ skipVerbatimCheck: true }` to
 * deliberately store a non-slice (only for tests of the invariant itself).
 */
export async function chunk(
  db: Db,
  overrides: Partial<ChunkInsert> = {},
  opts: { skipVerbatimCheck?: boolean } = {},
): Promise<ReviewChunk> {
  let parent: Review;
  if (overrides.reviewId) {
    const [found] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, overrides.reviewId));
    parent = must(found, `review ${overrides.reviewId}`);
  } else {
    parent = await review(
      db,
      overrides.projectId ? { projectId: overrides.projectId } : {},
    );
  }

  const text = overrides.text ?? parent.text;
  const startOffset = overrides.startOffset ?? 0;
  if (!opts.skipVerbatimCheck) {
    assertVerbatimSlice(parent, { text, startOffset });
  }

  const [row] = await db
    .insert(reviewChunks)
    .values({
      kind: "full",
      ...overrides,
      reviewId: parent.id,
      projectId: overrides.projectId ?? parent.projectId,
      environment: overrides.environment ?? parent.environment,
      text,
      startOffset,
    })
    .returning();
  return must(row, "chunk");
}

/** A 1024-dim vector with `1` at `hot` and `0` elsewhere — exact in fp16. */
export function unitVector(hot: number, dimensions = 1024): number[] {
  const v = new Array<number>(dimensions).fill(0);
  v[hot] = 1;
  return v;
}
