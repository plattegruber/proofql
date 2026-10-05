/**
 * When a chunk "matches the query's words" for the floor's lexical tier
 * (#138, #147). The hybrid search's full-text *ranking* branch keeps
 * `tsv @@ websearch_to_tsquery('english', q)`, which requires every term;
 * the floor decision uses one of these rules instead.
 *
 * The rules, all measured on the relevance fixtures with
 * `pnpm db:tune-floor -- --annotate <run> --lexical-rule <rule>`:
 *
 * - `all`: the ranking branch's own match (every term). The #146 rule.
 * - `any`: at least one of the query's content words (the English
 *   config's stemmed, stop-word-free lexemes) is in the chunk.
 * - `half`: at least half of the query's content words are in the chunk.
 * - `half-specific`: at least half of the query's content words that are
 *   **not generic** are in the chunk; a query made only of generic words
 *   gets no partial credit. Generic means the project's derived
 *   `generic_terms` (#149, `./genericTerms.ts`) plus core's
 *   `UNIVERSAL_GENERIC_WORDS` — {@link genericLexemesSql}.
 *
 * Every rule is a superset of `all` (it is OR-ed in), so a chunk that
 * matched under #146 still does.
 */

import { type LexicalRule, UNIVERSAL_GENERIC_WORDS } from "@proofql/core";
import { type SQL, sql } from "drizzle-orm";

/**
 * The generic lexemes for one search, as a `text[]` expression: the
 * project's stored terms (already lexemes, from `ts_stat`) followed by
 * `UNIVERSAL_GENERIC_WORDS`, stemmed by Postgres with the corpus's config
 * (so "experience" becomes `experi`). `projectTerms` is a `text[]`
 * expression: the search reads `projects.generic_terms` in the statement;
 * the tuning script binds an explicit list.
 */
export function genericLexemesSql(projectTerms: SQL): SQL {
  return sql`array_cat(${projectTerms}, tsvector_to_array(to_tsvector('english', ${UNIVERSAL_GENERIC_WORDS})))`;
}

/** {@link genericLexemesSql} over a literal list of project lexemes. */
export function genericLexemesFor(projectTerms: readonly string[]): SQL {
  return genericLexemesSql(sql`${sql.param([...projectTerms])}::text[]`);
}

/**
 * A boolean SQL expression: does the chunk whose tsvector is `tsv` match
 * `queryText` under `rule`. `genericLexemes` is a `text[]` expression of
 * stemmed lexemes ({@link genericLexemesSql}; only read by
 * `half-specific`); defaults to the universal words alone.
 */
export function lexicalMatchSql(
  tsv: SQL,
  queryText: string,
  rule: LexicalRule,
  genericLexemes: SQL = genericLexemesFor([]),
): SQL {
  const all = sql`${tsv} @@ websearch_to_tsquery('english', ${queryText})`;
  if (rule === "all") return all;
  const terms = sql`unnest(tsvector_to_array(to_tsvector('english', ${queryText}))) AS t(lexeme)`;
  const has = sql`${tsv} @@ quote_literal(t.lexeme)::tsquery`;
  if (rule === "any") {
    return sql`(${all} OR EXISTS (SELECT 1 FROM ${terms} WHERE ${has}))`;
  }
  const specific =
    rule === "half-specific"
      ? sql`WHERE t.lexeme <> ALL(${genericLexemes})`
      : sql``;
  return sql`(${all} OR COALESCE((
      SELECT count(*) > 0 AND 2 * count(*) FILTER (WHERE ${has}) >= count(*)
      FROM ${terms} ${specific}
    ), false))`;
}
