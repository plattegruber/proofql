/**
 * Hard-delete workspaces that were deleted in Clerk long enough ago (#169).
 *
 * The Clerk webhook's `organization.deleted` only marks the account
 * (`accounts.deleted_at`, migration 0004): deleting the row at once would
 * be irreversible the moment someone removes an organization by mistake.
 * `purgeDeletedAccounts` finishes the job `ACCOUNT_PURGE_AFTER_DAYS` (30)
 * later. The pipeline runs it from its daily cron tick (04:15 UTC); ops can
 * run it by hand with `pnpm db:purge-accounts` (scripts/purge-accounts.ts).
 *
 * What goes:
 *
 *   - the `accounts` row, and with it every tenant row: `projects` cascade
 *     from `accounts`, and `api_keys` (revoked ones included), `connections`,
 *     `ingest_runs`, `reviews`, `review_chunks` and `usage` cascade from
 *     `projects` (all `ON DELETE CASCADE` since migration 0001; the cascade
 *     audit in purge.integration.test.ts fails if a new table breaks that);
 *   - each project's R2 prefix `uploads/<projectId>/`, when a bucket is
 *     passed. That is belt and braces: the bucket's lifecycle rule already
 *     expires every upload `UPLOAD_RETENTION_DAYS` (7) after it was written,
 *     so a workspace deleted 30 days ago normally has nothing left in R2. A
 *     failed prefix delete is logged (`uploads.delete_failed`) and does not
 *     undo or block the database purge — the lifecycle rule still applies.
 *
 * Each account is deleted in its own transaction that re-checks the mark
 * under a row lock, so a workspace revived in the meantime (re-creating the
 * organization in Clerk clears `deleted_at`, see `upsertAccountByClerkOrgId`
 * in the dashboard) is skipped. After the purge nothing is left to revive:
 * the next sign-in with the same Clerk organization creates a brand-new,
 * empty account, which is the intended outcome.
 *
 * Bounded per run (`limit`, default `ACCOUNT_PURGE_BATCH` = 50), oldest
 * mark first; the rest wait for the next tick and `remaining` says so.
 */

import {
  ACCOUNT_PURGE_AFTER_DAYS,
  ACCOUNT_PURGE_BATCH,
  deletePrefix,
  type Logger,
  type PrefixBucket,
  projectUploadsPrefix,
  retentionCutoff,
} from "@proofql/core";
import { and, asc, eq, isNotNull, lt, sql } from "drizzle-orm";

import type { Db } from "../client.js";
import { accounts, projects } from "../schema/tenancy.js";

export interface PurgeDeletedAccountsDeps {
  db: Db;
  /** The uploads bucket; omitted ⇒ R2 is left to the lifecycle rule. */
  uploads?: PrefixBucket;
  log?: Logger;
}

export interface PurgeDeletedAccountsOptions {
  /** Defaults to the current time. */
  now?: Date;
  /** Defaults to `ACCOUNT_PURGE_AFTER_DAYS`. */
  afterDays?: number;
  /** Accounts per run; defaults to `ACCOUNT_PURGE_BATCH`. */
  limit?: number;
  /** List what is due and log nothing destructive; deletes nothing. */
  dryRun?: boolean;
}

export interface PurgedAccount {
  accountId: string;
  deletedAt: Date;
  projects: number;
  /** Sum of the projects' `review_count` (live reviews) at purge time. */
  reviews: number;
  /** R2 objects removed under the projects' prefixes; null without a bucket. */
  uploadObjects: number | null;
}

export interface PurgeDeletedAccountsResult {
  cutoff: Date;
  dryRun: boolean;
  /** Purged accounts (or, in a dry run, the ones that would be). */
  accounts: PurgedAccount[];
  /** More accounts were due than `limit`; the next run continues. */
  remaining: boolean;
}

export async function purgeDeletedAccounts(
  deps: PurgeDeletedAccountsDeps,
  options: PurgeDeletedAccountsOptions = {},
): Promise<PurgeDeletedAccountsResult> {
  const { db, uploads, log } = deps;
  const now = options.now ?? new Date();
  const cutoff = retentionCutoff(
    now,
    options.afterDays ?? ACCOUNT_PURGE_AFTER_DAYS,
  );
  const limit = options.limit ?? ACCOUNT_PURGE_BATCH;
  const dryRun = options.dryRun ?? false;
  const due = and(
    isNotNull(accounts.deletedAt),
    lt(accounts.deletedAt, cutoff),
  );

  // One extra row tells "exactly `limit` due" from "more than `limit`".
  const candidates = await db
    .select({ id: accounts.id, deletedAt: accounts.deletedAt })
    .from(accounts)
    .where(due)
    .orderBy(asc(accounts.deletedAt), asc(accounts.id))
    .limit(limit + 1);
  const remaining = candidates.length > limit;

  const purged: PurgedAccount[] = [];
  for (const candidate of candidates.slice(0, limit)) {
    const removed = dryRun
      ? await describeAccount(db, candidate.id)
      : await deleteAccount(db, candidate.id, cutoff);
    if (removed === null) continue; // revived since the select

    let uploadObjects: number | null = null;
    if (uploads && !dryRun) {
      uploadObjects = 0;
      for (const projectId of removed.projectIds) {
        try {
          uploadObjects += await deletePrefix(
            uploads,
            projectUploadsPrefix(projectId),
          );
        } catch (error) {
          log?.log("uploads.delete_failed", {
            level: "warn",
            account_id: candidate.id,
            project_id: projectId,
            site: "pipeline.account_purge",
            error,
          });
        }
      }
    }

    const entry: PurgedAccount = {
      accountId: candidate.id,
      deletedAt: candidate.deletedAt as Date,
      projects: removed.projectIds.length,
      reviews: removed.reviews,
      uploadObjects,
    };
    purged.push(entry);
    if (!dryRun) {
      log?.log("account.purged", {
        account_id: entry.accountId,
        deleted_at: entry.deletedAt.toISOString(),
        projects: entry.projects,
        reviews: entry.reviews,
        upload_objects: entry.uploadObjects,
      });
    }
  }

  log?.log("account.purge.completed", {
    dry_run: dryRun,
    cutoff: cutoff.toISOString(),
    accounts: purged.length,
    projects: purged.reduce((n, a) => n + a.projects, 0),
    reviews: purged.reduce((n, a) => n + a.reviews, 0),
    upload_objects:
      uploads && !dryRun
        ? purged.reduce((n, a) => n + (a.uploadObjects ?? 0), 0)
        : null,
    remaining,
  });

  return { cutoff, dryRun, accounts: purged, remaining };
}

interface RemovedAccount {
  projectIds: string[];
  reviews: number;
}

async function describeAccount(
  db: Db,
  accountId: string,
): Promise<RemovedAccount> {
  const rows = await db
    .select({ id: projects.id, reviewCount: projects.reviewCount })
    .from(projects)
    .where(eq(projects.accountId, accountId));
  return {
    projectIds: rows.map((r) => r.id),
    reviews: rows.reduce((n, r) => n + r.reviewCount, 0),
  };
}

/** Lock, re-check the mark, read the projects, delete. Null if no longer due. */
async function deleteAccount(
  db: Db,
  accountId: string,
  cutoff: Date,
): Promise<RemovedAccount | null> {
  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.id, accountId),
          isNotNull(accounts.deletedAt),
          lt(accounts.deletedAt, cutoff),
        ),
      )
      .for("update");
    if (locked.length === 0) return null;
    const rows = await tx
      .select({ id: projects.id, reviewCount: projects.reviewCount })
      .from(projects)
      .where(eq(projects.accountId, accountId));
    await tx.delete(accounts).where(eq(accounts.id, accountId));
    return {
      projectIds: rows.map((r) => r.id),
      reviews: rows.reduce((n, r) => n + r.reviewCount, 0),
    };
  });
}

/** Accounts due for purge at `now` (for the ops script's summary line). */
export async function countAccountsDueForPurge(
  db: Db,
  now: Date = new Date(),
  afterDays: number = ACCOUNT_PURGE_AFTER_DAYS,
): Promise<number> {
  const cutoff = retentionCutoff(now, afterDays);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(accounts)
    .where(and(isNotNull(accounts.deletedAt), lt(accounts.deletedAt, cutoff)));
  return row?.n ?? 0;
}
