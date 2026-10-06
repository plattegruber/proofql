/**
 * Data retention (#169): how long upload files and deleted workspaces are
 * kept, and the R2 prefix delete that both purge paths share.
 *
 *   - Upload files (`uploads/<projectId>/<runId>.<ext>` plus `.plan.json`
 *     and `.errors.json`, apps/dashboard/app/lib/csv.server.ts) expire
 *     `UPLOAD_RETENTION_DAYS` after they were written, through an R2
 *     lifecycle rule on the `uploads/` prefix (infra/provisioning.md). The
 *     rule is bucket configuration, not code: this constant is what the
 *     dashboard tells the user and what the rule must match.
 *   - A deleted project's prefix is removed at once (`deletePrefix`, from
 *     the dashboard's delete action, in `waitUntil`).
 *   - A workspace deleted in Clerk is only marked (`accounts.deleted_at`);
 *     the pipeline's daily cron hard-deletes it `ACCOUNT_PURGE_AFTER_DAYS`
 *     later (@proofql/db `purgeDeletedAccounts`).
 *
 * `PrefixBucket` is the structural slice of `R2Bucket` the delete needs, so
 * this stays free of platform types (like the KV contract in
 * cache-generation.ts); `MemoryBucket` implements it for tests.
 */

/** Days an upload, its plan and its error report stay in R2. */
export const UPLOAD_RETENTION_DAYS = 7;

/** Days between a workspace's soft delete and its hard delete. */
export const ACCOUNT_PURGE_AFTER_DAYS = 30;

/** Accounts hard-deleted per cron tick at most; the rest wait a day. */
export const ACCOUNT_PURGE_BATCH = 50;

/** The R2 prefix every upload object of every project lives under. */
export const UPLOADS_ROOT_PREFIX = "uploads/";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `uploads/<projectId>/` — the trailing slash keeps one id from matching another's prefix. */
export function projectUploadsPrefix(projectId: string): string {
  if (projectId.length === 0 || projectId.includes("/")) {
    throw new Error(`invalid project id for an uploads prefix: "${projectId}"`);
  }
  return `${UPLOADS_ROOT_PREFIX}${projectId}/`;
}

/** `now` minus `days` whole days: rows marked before this instant are due. */
export function retentionCutoff(now: Date, days: number): Date {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`retention days must be a non-negative integer: ${days}`);
  }
  return new Date(now.getTime() - days * DAY_MS);
}

/** Whether something written at `writtenAt` is past `days` of retention at `now`. */
export function isPastRetention(
  writtenAt: Date,
  now: Date,
  days: number,
): boolean {
  return writtenAt.getTime() < retentionCutoff(now, days).getTime();
}

/** The `list`/`delete` slice of `R2Bucket` a prefix delete uses. */
export interface PrefixBucket {
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: readonly { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
}

/** R2's ceiling for both one `list` page and one multi-key `delete`. */
export const R2_BATCH_LIMIT = 1000;

/**
 * Delete every object under `prefix`, a page at a time (list up to 1,000,
 * delete those keys in one call, follow the cursor). Resolves to the number
 * of keys deleted. Refuses an empty prefix: that would empty the bucket.
 */
export async function deletePrefix(
  bucket: PrefixBucket,
  prefix: string,
  options: { batchSize?: number } = {},
): Promise<number> {
  if (prefix.length === 0)
    throw new Error("refusing to delete an empty prefix");
  const limit = Math.min(options.batchSize ?? R2_BATCH_LIMIT, R2_BATCH_LIMIT);
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list(
      cursor === undefined ? { prefix, limit } : { prefix, limit, cursor },
    );
    const keys = page.objects.map((o) => o.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    // Keys are deleted as we go, so a cursor past them is still valid in
    // R2 (it encodes the last key, not an offset).
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return deleted;
}

/**
 * In-memory `PrefixBucket` with R2's paging semantics (lexicographic keys,
 * `truncated` + opaque `cursor`), for tests in every workspace.
 */
export class MemoryBucket implements PrefixBucket {
  readonly objects = new Map<string, string>();
  /** Every `delete` call's keys, in order. */
  readonly deleteCalls: string[][] = [];

  constructor(keys: Iterable<string> = []) {
    for (const key of keys) this.objects.set(key, "");
  }

  async put(key: string, value: string | ArrayBuffer = ""): Promise<void> {
    this.objects.set(
      key,
      typeof value === "string" ? value : new TextDecoder().decode(value),
    );
  }

  async list(options: { prefix: string; cursor?: string; limit?: number }) {
    const limit = options.limit ?? R2_BATCH_LIMIT;
    const after = options.cursor ?? "";
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(options.prefix) && k > after)
      .sort();
    const page = keys.slice(0, limit);
    const truncated = keys.length > limit;
    return {
      objects: page.map((key) => ({ key })),
      truncated,
      ...(truncated ? { cursor: page[page.length - 1] } : {}),
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = typeof keys === "string" ? [keys] : keys;
    this.deleteCalls.push([...list]);
    for (const key of list) this.objects.delete(key);
  }

  /** Keys under `prefix`, sorted. */
  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
