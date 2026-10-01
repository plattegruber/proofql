/**
 * Project writes for the dashboard (#37 create/rename/origins/delete, #41
 * policy). Plain functions over a `Db`, like app/lib/accounts.ts, so the
 * integration tests (projects.server.integration.test.ts) exercise exactly
 * what the actions call. Every write is scoped by `accountId` as well as
 * the project id: a stale or forged id from another account matches nothing.
 *
 * The functions return outcome objects rather than throwing for the two
 * user-facing conflicts (slug taken, plan limit) — the actions turn those
 * into 422 field errors per docs/frontend-conventions.md.
 */
import { projectLimitForPlan } from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { and, count, eq } from "drizzle-orm";

import type { Project } from "./accounts";

export type { Project };

/** Postgres `unique_violation`; the per-account slug constraint fires it. */
const UNIQUE_VIOLATION = "23505";

/**
 * drizzle-orm wraps driver errors in DrizzleQueryError with the postgres-js
 * PostgresError on `cause`, so both layers are checked (the same unwrapping
 * the @proofql/db test harness does).
 */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return code === UNIQUE_VIOLATION;
}

export async function countProjectsForAccount(
  db: Db,
  accountId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.projects)
    .where(eq(schema.projects.accountId, accountId));
  return row?.n ?? 0;
}

export interface ProjectQuota {
  used: number;
  limit: number;
  atLimit: boolean;
}

/** How many projects the account has against its plan's allowance. */
export async function projectQuota(
  db: Db,
  account: { id: string; plan: string },
): Promise<ProjectQuota> {
  const used = await countProjectsForAccount(db, account.id);
  const limit = projectLimitForPlan(account.plan);
  return { used, limit, atLimit: used >= limit };
}

export type CreateProjectResult =
  | { ok: true; project: Project }
  | { ok: false; reason: "slug_taken" | "plan_limit"; quota?: ProjectQuota };

/**
 * Create a project for an account. The plan limit is checked in the same
 * transaction as the insert; the per-account slug uniqueness is the
 * database's constraint (migration 0002), caught and reported rather than
 * pre-checked, so two concurrent creates cannot both win.
 */
export async function createProject(
  db: Db,
  input: {
    account: { id: string; plan: string };
    name: string;
    slug: string;
  },
): Promise<CreateProjectResult> {
  const showBadge = input.account.plan !== "paid";
  try {
    return await db.transaction(async (tx) => {
      const quota = await projectQuota(tx, input.account);
      if (quota.atLimit) {
        return { ok: false as const, reason: "plan_limit" as const, quota };
      }
      const [row] = await tx
        .insert(schema.projects)
        .values({
          accountId: input.account.id,
          name: input.name,
          slug: input.slug,
          showBadge,
        })
        .returning();
      if (!row) throw new Error("projects insert returned no row");
      return { ok: true as const, project: row };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, reason: "slug_taken" };
    }
    throw error;
  }
}

export interface ProjectSettingsUpdate {
  name: string;
  slug: string;
  minRating: number;
  similarityFloor: number;
}

export type UpdateProjectResult =
  | {
      ok: true;
      project: Project;
      /** True when `min_rating` or `similarity_floor` actually changed. */
      policyChanged: boolean;
    }
  | { ok: false; reason: "slug_taken" | "not_found" };

/**
 * Save the Settings form (#41). Returns whether the publication policy
 * changed so the action can bump the project's cache generation — after
 * this commits, never inside it (packages/core cache-generation).
 */
export async function updateProjectSettings(
  db: Db,
  ids: { projectId: string; accountId: string },
  update: ProjectSettingsUpdate,
): Promise<UpdateProjectResult> {
  const before = await db.query.projects.findFirst({
    where: and(
      eq(schema.projects.id, ids.projectId),
      eq(schema.projects.accountId, ids.accountId),
    ),
  });
  if (!before) return { ok: false, reason: "not_found" };
  try {
    const [row] = await db
      .update(schema.projects)
      .set({
        name: update.name,
        slug: update.slug,
        minRating: update.minRating,
        similarityFloor: update.similarityFloor,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.projects.id, ids.projectId),
          eq(schema.projects.accountId, ids.accountId),
        ),
      )
      .returning();
    if (!row) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      project: row,
      policyChanged:
        before.minRating !== row.minRating ||
        before.similarityFloor !== row.similarityFloor,
    };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: "slug_taken" };
    throw error;
  }
}

/**
 * Replace the CORS allowlist for publishable keys. No cache-generation
 * bump: the api reads `allowed_origins` fresh with the key on every request
 * (workers/api/src/auth.ts `lookupApiKey`) and the CORS decision is made
 * before the cache is consulted, so cached query results are never a
 * function of the origin list.
 */
export async function setAllowedOrigins(
  db: Db,
  ids: { projectId: string; accountId: string },
  origins: readonly string[],
): Promise<Project | undefined> {
  const [row] = await db
    .update(schema.projects)
    .set({ allowedOrigins: [...origins], updatedAt: new Date() })
    .where(
      and(
        eq(schema.projects.id, ids.projectId),
        eq(schema.projects.accountId, ids.accountId),
      ),
    )
    .returning();
  return row;
}

/**
 * Delete a project. The schema cascades from `projects` to keys, reviews,
 * chunks, connections, ingest runs and usage, so one DELETE is the whole
 * operation. Returns the deleted row, or undefined when nothing matched.
 */
export async function deleteProject(
  db: Db,
  ids: { projectId: string; accountId: string },
): Promise<Project | undefined> {
  const [row] = await db
    .delete(schema.projects)
    .where(
      and(
        eq(schema.projects.id, ids.projectId),
        eq(schema.projects.accountId, ids.accountId),
      ),
    )
    .returning();
  return row;
}
