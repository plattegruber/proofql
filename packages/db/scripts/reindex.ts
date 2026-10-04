/**
 * Ops: mark reviews for re-indexing so the pipeline rebuilds their chunks.
 *
 *     DATABASE_URL=postgres://... pnpm db:reindex -- --project <slug|uuid> [--environment live|test]
 *     DATABASE_URL=postgres://... pnpm db:reindex -- --all [--environment live|test]
 *     DATABASE_URL=postgres://... pnpm db:reindex -- --project <slug|uuid> --dry-run
 *
 * Why it exists (#127): the chunker changed — reviews indexed before
 * migration 0008 have `full` + `window` chunks only, no `sentence` chunks,
 * so their highlights stay window-wide until they are re-indexed. Nothing
 * re-indexes a review on its own: a repeat ingest with identical text is a
 * no-op by design, and the pipeline only touches a review when a
 * `review.index` message names it.
 *
 * How it works: this package has no queue binding, so the script does not
 * enqueue anything. It sets `indexed_at = NULL` and `index_attempts = 0`
 * on the selected reviews (hidden ones excluded — the pipeline skips them
 * anyway) and lets the pipeline's existing five-minute re-enqueue sweep
 * (#72, `workers/pipeline/src/sweep.ts`, {@link SWEEP_LIMIT_PER_TICK} per
 * tick) put them back on the queue, oldest `updated_at` first. `indexReview`
 * deletes and re-inserts a review's chunks in one transaction and the
 * embedding stage sets `indexed_at` again, so the operation is idempotent
 * and converges; running it twice costs a second round of embeddings and
 * nothing else.
 *
 * What a visitor sees meanwhile: the old chunks keep serving search until
 * the moment a review is re-chunked, then its new rows carry NULL
 * embeddings for the second or so the Workers AI call takes, during which
 * that one review is absent from results. The API reports
 * `status: "indexing"` for the review until then, and the project's query
 * cache generation is bumped when `indexed_at` flips back. Nothing is
 * deleted by this script.
 *
 * `--project` takes a slug or a project id; a slug is unique per account,
 * not globally, so the script refuses an ambiguous slug and asks for the
 * id. `--environment` narrows to `live` or `test` (default: both).
 * `--dry-run` prints the counts and the estimate without writing.
 */

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";

import { createDb } from "../src/client.js";
import { type Environment, projects } from "../src/schema/index.js";
import { reviews } from "../src/schema/reviews.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The sweep's per-tick cap and period (`workers/pipeline/wrangler.jsonc`
 * runs it every five minutes; `src/handlers.ts` passes `limit: 500`). Only
 * used for the printed estimate — the pipeline, not this script, sets the
 * pace.
 */
export const SWEEP_LIMIT_PER_TICK = 500;
export const SWEEP_PERIOD_MINUTES = 5;

/** How long the sweep needs to re-enqueue `count` reviews, in minutes. */
export function estimateMinutes(count: number): number {
  if (count <= 0) return 0;
  // The first tick happens within the next five minutes; each further
  // batch of 500 waits for the next tick.
  return Math.ceil(count / SWEEP_LIMIT_PER_TICK) * SWEEP_PERIOD_MINUTES;
}

function usage(message: string): never {
  console.error(`db:reindex: ${message}`);
  console.error(
    "usage: pnpm db:reindex -- (--project <slug|uuid> | --all) " +
      "[--environment live|test] [--dry-run]",
  );
  process.exit(1);
}

export interface ReindexSelection {
  projectIds: string[] | null;
  environment: Environment | null;
}

/** The predicate over `reviews` the script resets. */
export function reindexWhere(selection: ReindexSelection): SQL {
  const clauses: SQL[] = [isNull(reviews.hiddenAt)];
  if (selection.projectIds) {
    clauses.push(inArray(reviews.projectId, selection.projectIds));
  }
  if (selection.environment) {
    clauses.push(eq(reviews.environment, selection.environment));
  }
  return and(...clauses) as SQL;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    // `pnpm db:reindex -- --project x` forwards the literal `--`, which
    // parseArgs would reject as a positional; drop it.
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      project: { type: "string" },
      all: { type: "boolean", default: false },
      environment: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const url = process.env.DATABASE_URL;
  if (!url) usage("DATABASE_URL is not set");
  if (values.all === (values.project !== undefined)) {
    usage("pass exactly one of --project <slug|uuid> or --all");
  }
  if (
    values.environment !== undefined &&
    values.environment !== "live" &&
    values.environment !== "test"
  ) {
    usage(`--environment must be live or test, got "${values.environment}"`);
  }
  const environment = (values.environment ?? null) as Environment | null;

  const { db, sql: raw } = createDb(url, { max: 1 });
  try {
    let projectIds: string[] | null = null;
    let label = "every project";
    if (values.project !== undefined) {
      const matches = await db
        .select({ id: projects.id, slug: projects.slug, name: projects.name })
        .from(projects)
        .where(
          UUID.test(values.project)
            ? eq(projects.id, values.project)
            : eq(projects.slug, values.project),
        );
      if (matches.length === 0) usage(`no project matches "${values.project}"`);
      if (matches.length > 1) {
        usage(
          `${matches.length} projects have slug "${values.project}" ` +
            `(${matches.map((m) => m.id).join(", ")}); pass the id instead`,
        );
      }
      const [found] = matches;
      if (!found) usage("unreachable");
      projectIds = [found.id];
      label = `project "${found.name}" (${found.slug}, ${found.id})`;
    }

    const where = reindexWhere({ projectIds, environment });
    const [counted] = await db
      .select({
        total: sql<number>`count(*)::int`,
        alreadyPending: sql<number>`count(*) FILTER (WHERE ${reviews.indexedAt} IS NULL)::int`,
      })
      .from(reviews)
      .where(where);
    const total = counted?.total ?? 0;
    const pending = counted?.alreadyPending ?? 0;
    const scope = environment ? `${environment} reviews` : "reviews";

    if (values["dry-run"]) {
      console.log(
        `db:reindex (dry run): ${total} ${scope} in ${label} would be marked ` +
          `for re-indexing (${pending} already pending).`,
      );
    } else {
      const updated = await db
        .update(reviews)
        .set({ indexedAt: null, indexAttempts: 0 })
        .where(where)
        .returning({ id: reviews.id });
      console.log(
        `db:reindex: marked ${updated.length} ${scope} in ${label} for ` +
          `re-indexing (indexed_at = NULL, index_attempts = 0; ${pending} were already pending).`,
      );
    }
    const minutes = estimateMinutes(total);
    console.log(
      `The pipeline's re-enqueue sweep runs every ${SWEEP_PERIOD_MINUTES} minutes ` +
        `and re-sends up to ${SWEEP_LIMIT_PER_TICK} reviews per tick, so expect ` +
        `the last of them on the queue within about ${minutes} minute(s); ` +
        "watch `review.indexed` lines with `sentences` > 0 in the pipeline logs.",
    );
  } finally {
    await raw.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
