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
export const DEFAULT_SIMILARITY_FLOOR = 0.66;

/**
 * The lexical tier of the floor (#138 follow-up). A chunk that also
 * matches the query's words — the hybrid search's full-text branch ranked
 * it (`tsv @@ websearch_to_tsquery('english', q)`) — passes at the project
 * floor minus this offset; everything else needs the floor itself.
 *
 * Why: bge-m3 scores a bare keyword low against a sentence ("veneers"
 * tops out at 0.633 against the one veneer review), so a flat floor high
 * enough to keep unanswerable in-domain queries empty also blanks short
 * keyword queries that *literally* match a review. Lexical matching is
 * strong evidence the corpus answers the query: on the relevance fixtures
 * every lexical candidate was a labelled answer (21 of 21), and none of the
 * 22 must-be-empty queries had one. The offset rather than a second
 * project column: the measured result is flat across lexical floors
 * 0.50–0.60, so an independent knob buys nothing, and an offset follows a
 * project's own floor when the owner tunes it (`docs/floor-tuning/`).
 */
export const LEXICAL_FLOOR_OFFSET = 0.13;

/** The lexical tier for a project floor, rounded to the floor's precision, never below 0. */
export function lexicalFloorFor(similarityFloor: number): number {
  const raw = similarityFloor - LEXICAL_FLOOR_OFFSET;
  return Math.max(0, Math.round(raw * 1e6) / 1e6);
}
