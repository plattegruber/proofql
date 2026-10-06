/**
 * Daily workspace purge (#169): the pipeline cron's 04:15 UTC tick runs
 * @proofql/db `purgeDeletedAccounts` — accounts soft-deleted by the Clerk
 * webhook more than `ACCOUNT_PURGE_AFTER_DAYS` (30) ago are hard-deleted
 * (FK cascades take every tenant row) and their projects' `uploads/<id>/`
 * prefixes are removed from the `UPLOADS` bucket, at most
 * `ACCOUNT_PURGE_BATCH` (50) accounts per tick.
 *
 * Logs `account.purged` per account and `account.purge.completed` per tick
 * (docs/observability.md). Without an `UPLOADS` binding the database purge
 * still runs and R2 is left to the bucket's 7-day lifecycle rule; the tick
 * says so with `upload_objects: null`.
 *
 * Locally: `wrangler dev --test-scheduled`, then
 * GET /cdn-cgi/local/scheduled?time=<epoch ms of a 04:15 UTC> on port 8798.
 */

import type { Logger, PrefixBucket } from "@proofql/core";
import {
  type Db,
  type PurgeDeletedAccountsResult,
  purgeDeletedAccounts,
} from "@proofql/db";

export interface AccountPurgeContext {
  db: Db;
  uploads?: PrefixBucket;
  log: Logger;
}

export type AccountPurgeResult = PurgeDeletedAccountsResult;

export function runAccountPurge(
  ctx: AccountPurgeContext,
  options: { now?: Date } = {},
): Promise<AccountPurgeResult> {
  return purgeDeletedAccounts(
    ctx.uploads
      ? { db: ctx.db, uploads: ctx.uploads, log: ctx.log }
      : { db: ctx.db, log: ctx.log },
    options,
  );
}
