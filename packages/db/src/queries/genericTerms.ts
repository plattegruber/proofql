/**
 * Per-project generic query words (#149), derived from document frequency.
 *
 * The floor's partial word match (`./lexicalMatch.ts`, rule
 * `half-specific`) ignores words every review of a business contains: a
 * query sharing only "dentist" with a dental review, or only "coffee" with
 * a cafe review, has not matched it. Which words those are depends on the
 * business, so they are measured per project rather than listed: a stemmed
 * lexeme is generic when it appears in more than a quarter of the project's
 * indexed live reviews, once there are at least 30 of them (the threshold
 * math and its reference implementation are `genericTermsFloor` and
 * `selectGenericTerms` in `@proofql/core`).
 *
 * ## The statement
 *
 * One `ts_stat` over the project's live `full` chunks' `tsv`. A review has
 * exactly one `full` chunk, so `ndoc` (rows containing the lexeme) is the
 * number of reviews containing it: document frequency, with no double
 * counting from the overlapping window and sentence chunks. Only indexed,
 * unhidden reviews count — the corpus the search actually reads. Live only:
 * the test environment holds a developer's synthetic data, usually a
 * handful of reviews, and a project's vocabulary is a property of the
 * business, so test-key queries use the live terms too (one column, not one
 * per environment). `ts_stat` takes its query as text; the project id goes
 * in through `format('%L')`, never spliced from JavaScript.
 *
 * The terms are stored sorted (code-point order) so equal sets compare
 * equal and a refresh over an unchanged corpus is recognisably a no-op.
 *
 * ## When it runs
 *
 * The pipeline calls {@link refreshGenericTermsIfDue} after a review
 * becomes indexed (`workers/pipeline/src/embed-chunks.ts`): debounced to
 * once an hour per project, except that the refresh runs at once when the
 * project crosses the 30-review minimum, which is when the set goes from
 * empty to real. The seed calls {@link refreshGenericTerms} directly. The
 * statement costs one pass over the project's `full` chunks (one per
 * review), cheap next to the embedding call that precedes it.
 */

import {
  GENERIC_TERM_DOC_SHARE,
  GENERIC_TERMS_MAX,
  GENERIC_TERMS_MIN_REVIEWS,
} from "@proofql/core";
import { type SQL, sql } from "drizzle-orm";

import type { Db } from "../client.js";

/** The connection surface used here; a transaction fits too. */
export type GenericTermsExecutor = Pick<Db, "execute">;

/** How often the pipeline may recompute a project's terms. */
export const GENERIC_TERMS_REFRESH_INTERVAL = "1 hour";

export interface GenericTermsResult {
  /** The derived terms, sorted. */
  terms: string[];
  /** Indexed, unhidden live reviews the terms were derived from. */
  reviews: number;
}

export interface RefreshGenericTermsResult extends GenericTermsResult {
  /** What the column held before. */
  previous: string[];
  /** Whether the set differs from `previous` (the caller bumps the cache). */
  changed: boolean;
}

/** The `ts_stat` input: the project's live `full` chunks of indexed, visible reviews. */
const FULL_CHUNKS_QUERY = `SELECT c.tsv FROM review_chunks c
  JOIN reviews r ON r.id = c.review_id AND r.project_id = c.project_id AND r.environment = c.environment
  WHERE c.project_id = %L AND c.environment = 'live' AND c.kind = 'full'
    AND r.indexed_at IS NOT NULL AND r.hidden_at IS NULL`;

/** Reviews counted toward the minimum; `extra` narrows further. */
function reviewCount(projectId: string, extra: SQL = sql``): SQL {
  return sql`(SELECT count(*)::int FROM reviews r
    WHERE r.project_id = ${projectId} AND r.environment = 'live'
      AND r.indexed_at IS NOT NULL AND r.hidden_at IS NULL ${extra})`;
}

/** CTEs `n(reviews)` and `derived(terms)`, shared by every statement here. */
function derivedCtes(projectId: string): SQL {
  return sql`
    n AS (SELECT ${reviewCount(projectId)} AS reviews),
    derived AS (
      SELECT COALESCE(array_agg(top.word ORDER BY top.word COLLATE "C"), '{}'::text[]) AS terms
      FROM (
        SELECT s.word
        FROM n, ts_stat(format(${FULL_CHUNKS_QUERY}, ${projectId}::text)) AS s
        WHERE n.reviews >= ${GENERIC_TERMS_MIN_REVIEWS}
          AND s.ndoc > ${GENERIC_TERM_DOC_SHARE}::float8 * n.reviews
        ORDER BY s.ndoc DESC, s.word COLLATE "C"
        LIMIT ${GENERIC_TERMS_MAX}
      ) AS top
    )`;
}

/**
 * The terms a refresh would store, without writing anything: read-only, so
 * the tuning script can derive them against a database whose schema
 * predates `projects.generic_terms` (`pnpm db:tune-floor --annotate`).
 */
export async function computeGenericTerms(
  db: GenericTermsExecutor,
  projectId: string,
): Promise<GenericTermsResult> {
  const [row] = await db.execute<{ terms: string[]; reviews: number }>(sql`
    WITH ${derivedCtes(projectId)}
    SELECT derived.terms, n.reviews FROM derived, n`);
  return { terms: row?.terms ?? [], reviews: row?.reviews ?? 0 };
}

/**
 * Recompute and store `projects.generic_terms` for `projectId` in one
 * statement, stamping `generic_terms_refreshed_at`. Resolves to null when
 * the project does not exist. Does not touch the query cache: the caller
 * bumps the project's generation when `changed` (and after its transaction
 * commits, if any).
 */
export async function refreshGenericTerms(
  db: GenericTermsExecutor,
  projectId: string,
): Promise<RefreshGenericTermsResult | null> {
  return update(db, projectId, sql``);
}

/**
 * {@link refreshGenericTerms}, but only when it is due: never computed,
 * computed more than {@link GENERIC_TERMS_REFRESH_INTERVAL} ago, or the
 * project has crossed the 30-review minimum since the last computation
 * (fewer than 30 of today's reviews had been indexed by then, so the stored
 * set is the empty below-minimum one). Resolves to null when not due. The
 * check and the write are one statement, so concurrent pipeline messages
 * cannot interleave between them.
 */
export async function refreshGenericTermsIfDue(
  db: GenericTermsExecutor,
  projectId: string,
): Promise<RefreshGenericTermsResult | null> {
  const indexedBefore = reviewCount(
    projectId,
    sql`AND r.indexed_at <= p.generic_terms_refreshed_at`,
  );
  return update(
    db,
    projectId,
    sql`AND (
      p.generic_terms_refreshed_at IS NULL
      OR p.generic_terms_refreshed_at < now() - ${GENERIC_TERMS_REFRESH_INTERVAL}::interval
      OR (n.reviews >= ${GENERIC_TERMS_MIN_REVIEWS}
          AND ${indexedBefore} < ${GENERIC_TERMS_MIN_REVIEWS})
    )`,
  );
}

async function update(
  db: GenericTermsExecutor,
  projectId: string,
  due: SQL,
): Promise<RefreshGenericTermsResult | null> {
  const [row] = await db.execute<{
    terms: string[];
    previous: string[];
    reviews: number;
  }>(sql`
    WITH ${derivedCtes(projectId)},
    prev AS (SELECT generic_terms FROM projects WHERE id = ${projectId})
    UPDATE projects p
    SET generic_terms = derived.terms, generic_terms_refreshed_at = now()
    FROM derived, prev, n
    WHERE p.id = ${projectId} ${due}
    RETURNING p.generic_terms AS terms, prev.generic_terms AS previous, n.reviews`);
  if (!row) return null;
  return {
    terms: row.terms,
    previous: row.previous,
    reviews: row.reviews,
    changed: !sameSet(row.terms, row.previous),
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((t) => set.has(t));
}
