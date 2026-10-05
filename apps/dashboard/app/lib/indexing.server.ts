/**
 * Indexed vs. waiting counts over a slice of `reviews`, in one statement
 * (the progress views poll it, so each poll costs one Hyperdrive query
 * rather than two). `deferred` is the "waiting on the sweep" signal of
 * app/lib/indexing.ts: some review has been unindexed for longer than
 * INDEXING_DEFERRED_AFTER_MS.
 */
import { type Db, schema } from "@proofql/db";
import { type SQL, sql } from "drizzle-orm";

import { INDEXING_DEFERRED_AFTER_MS } from "./indexing";

export interface IndexingTally {
  indexed: number;
  indexing: number;
  /** At least one review has waited longer than INDEXING_DEFERRED_AFTER_MS. */
  deferred: boolean;
}

export async function indexingTally(
  db: Db,
  where: SQL | undefined,
): Promise<IndexingTally> {
  const { reviews } = schema;
  const stale = sql`now() - make_interval(secs => ${INDEXING_DEFERRED_AFTER_MS / 1000})`;
  const [row] = await db
    .select({
      indexed: sql<number>`count(*) filter (where ${reviews.indexedAt} is not null)::int`,
      indexing: sql<number>`count(*) filter (where ${reviews.indexedAt} is null)::int`,
      stale: sql<number>`count(*) filter (where ${reviews.indexedAt} is null and ${reviews.updatedAt} < ${stale})::int`,
    })
    .from(reviews)
    .where(where);
  return {
    indexed: row?.indexed ?? 0,
    indexing: row?.indexing ?? 0,
    deferred: (row?.stale ?? 0) > 0,
  };
}
