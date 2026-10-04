/**
 * The default relevance floor: the minimum cosine similarity between a
 * query and an excerpt for the excerpt to be returned (scope.md §3,
 * "Empty beats irrelevant"). It is the `projects.similarity_floor` column
 * default; each project can tune its own value in Settings.
 *
 * Measured, not guessed: `pnpm db:tune-floor` runs the labelled relevance
 * fixtures (`packages/db/src/seed/fixtures/relevance.ts`) through the
 * deployed api with real `bge-m3` embeddings and reports precision, recall,
 * and the false-positive rate on queries that must return nothing; the
 * runs are saved under `docs/floor-tuning/`. Change this only with a new
 * run attached, and move the schema default (a migration) with it.
 */
export const DEFAULT_SIMILARITY_FLOOR = 0.55;
