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
 * matches the query's words — at least half of its content words that are
 * not generic (#147, #149), or every term (`lexicalMatchSql` in
 * `@proofql/db`) — passes at the project floor minus this offset;
 * everything else needs the floor itself.
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

/**
 * Words too generic to count as evidence on their own in **any** corpus
 * (#147, #149): a query sharing only these with a review has not matched
 * it. The floor of the generic list; each project adds its own derived
 * terms (`projects.generic_terms`, {@link genericTermsFloor}). The
 * lexical tier's partial-match rule ignores both when it counts how many
 * of the query's words a chunk contains (`lexicalMatchSql` in
 * `@proofql/db`). Space-separated, stemmed by Postgres with the corpus's
 * English config.
 */
export const UNIVERSAL_GENERIC_WORDS = "review place service experience";

/**
 * Per-project generic terms (#149). A stemmed lexeme is generic for a
 * project when it appears in more than this share of the project's indexed
 * live reviews...
 */
export const GENERIC_TERM_DOC_SHARE = 0.25;

/** ...and only once the project has at least this many; below it, none. */
export const GENERIC_TERMS_MIN_REVIEWS = 30;

/** At most this many terms are kept, most frequent first. */
export const GENERIC_TERMS_MAX = 30;

/**
 * The document-frequency cut for a project with `reviews` indexed live
 * reviews: a lexeme is generic when its document count is **strictly
 * greater** than the returned value. `null` below
 * {@link GENERIC_TERMS_MIN_REVIEWS}, where document frequency is too noisy
 * to call anything generic (5 reviews of which 2 say "crown" is not
 * evidence that "crown" is filler). `refreshGenericTerms` in `@proofql/db`
 * applies the same cut in SQL.
 */
export function genericTermsFloor(reviews: number): number | null {
  if (!Number.isFinite(reviews) || reviews < GENERIC_TERMS_MIN_REVIEWS) {
    return null;
  }
  return GENERIC_TERM_DOC_SHARE * reviews;
}

/** One `ts_stat` row: a lexeme and how many reviews contain it. */
export interface TermDocCount {
  word: string;
  ndoc: number;
}

/**
 * The generic terms for a project, from per-lexeme document counts: those
 * above {@link genericTermsFloor}, the {@link GENERIC_TERMS_MAX} most
 * frequent (ties by word), returned sorted so two refreshes over the same
 * corpus store the same array. The reference implementation of the SQL in
 * `refreshGenericTerms`; the unit tests pin the threshold math here.
 */
export function selectGenericTerms(
  stats: readonly TermDocCount[],
  reviews: number,
): string[] {
  const floor = genericTermsFloor(reviews);
  if (floor === null) return [];
  return stats
    .filter((s) => s.ndoc > floor)
    .sort((a, b) => b.ndoc - a.ndoc || compare(a.word, b.word))
    .slice(0, GENERIC_TERMS_MAX)
    .map((s) => s.word)
    .sort(compare);
}

/** Code-point order, matching Postgres's `COLLATE "C"`. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Which word-match rule decides the lexical tier (#147); the SQL for each
 * is `lexicalMatchSql` in `@proofql/db`, and `pnpm db:tune-floor
 * --annotate --lexical-rule <rule>` measures any of them offline.
 */
export const LEXICAL_RULES = ["all", "any", "half", "half-specific"] as const;
export type LexicalRule = (typeof LEXICAL_RULES)[number];

/**
 * The rule the search applies: at least half of the query's content words
 * that are not generic ({@link UNIVERSAL_GENERIC_WORDS} plus the project's
 * `generic_terms`), or every term. Chosen on the relevance fixtures in
 * #147 (`docs/performance.md` §5): 30/35 answerable queries answered at
 * 0.66 / 0.53 with the hand-written dental list, against 27/35 for `all`;
 * 29/35 with the demo project's derived terms (#149).
 */
export const LEXICAL_RULE: LexicalRule = "half-specific";
