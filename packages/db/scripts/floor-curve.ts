/**
 * The arithmetic behind `tune-floor.ts` (#138), kept pure so it is unit
 * tested and so a saved run (`docs/floor-tuning/<date>.json`) replays
 * offline to the same numbers.
 *
 * Input: for every labelled query (`seed/fixtures/relevance.ts`), the rows
 * the API returned at a very low scratch floor, each with the review key
 * and its cosine `similarity`. Output: precision, recall, and the
 * false-positive rate on the must-be-empty queries at every candidate
 * floor, the score distributions, and the recommendation.
 *
 * Definitions, at a floor `f` (a row counts when `similarity >= f`, the
 * SQL's comparison):
 *
 * - **Positives** (`kind: positive`, minus `cross-language`, which is
 *   reported but not tuned on): a returned row is a true positive when its
 *   key is in `expect`, a false positive when it is in neither `expect` nor
 *   `acceptable`, and neutral when it is `acceptable`. An expected key with
 *   no row at or above `f` (including one the scratch run never returned)
 *   is a miss. Precision and recall are pooled over all rows, not averaged
 *   per query, so a query with nine answers weighs more than one with one.
 * - **Negatives** (`kind: negative` and `kind: policy-filtered`): the
 *   correct answer is `[]`, so the false-positive rate is the share of
 *   these queries with at least one row at or above `f` — a query-level
 *   rate, because one irrelevant quote on a page is the failure, however
 *   many follow it.
 * - **Recommendation**: the lowest floor where the negatives' rate is at
 *   most `maxNegativeRate` and the positives' recall is at least
 *   `minRecall`. When no floor satisfies both, both boundaries are reported
 *   (`lowestSafe`: lowest with the rate under the cap; `highestRecall`:
 *   highest with recall over the bar) and `recommended` is null.
 */

import type {
  RelevanceKind,
  RelevanceTag,
} from "../src/seed/fixtures/relevance.js";

export interface ObservedRow {
  /** Review key from the fixtures, or `?<uuid>` for a review not in them. */
  readonly key: string;
  readonly similarity: number;
}

export interface ObservedQuery {
  readonly id: string;
  readonly q: string;
  readonly kind: RelevanceKind;
  readonly tags?: readonly RelevanceTag[];
  readonly expect: readonly string[];
  readonly acceptable?: readonly string[];
  /** Rows the API returned at the scratch floor, in rank order. */
  readonly rows: readonly ObservedRow[];
}

export interface FloorPoint {
  readonly floor: number;
  /** Pooled over positives; null when nothing was returned at this floor. */
  readonly precision: number | null;
  readonly recall: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly misses: number;
  /** Positive queries with no row at all at this floor. */
  readonly emptyPositives: number;
  /**
   * Query-level: positives with at least one expected review at or above
   * the floor — "the page shows a genuine answer". The number a snippet
   * owner feels, since a block shows ~3 quotes, not every matching review.
   */
  readonly answered: number;
  readonly answeredRate: number;
  /**
   * Query-level: positives whose first `TOP_N` rows at the floor (in rank
   * order, what `limit=3` renders) are all expected or acceptable and
   * include at least one expected review.
   */
  readonly topClean: number;
  /** Negatives (incl. policy-filtered) with at least one row. */
  readonly negativeQueriesHit: number;
  readonly negativeRate: number;
  readonly negativeRows: number;
}

export interface Percentiles {
  readonly n: number;
  readonly p10: number | null;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly min: number | null;
  readonly max: number | null;
}

export interface Recommendation {
  readonly minRecall: number;
  readonly maxNegativeRate: number;
  /** Lowest floor meeting both targets, or null when they conflict. */
  readonly recommended: number | null;
  /** Lowest floor with the negatives' rate at or under the cap. */
  readonly lowestSafe: number | null;
  /** Highest floor with recall at or over the bar. */
  readonly highestRecall: number | null;
  /**
   * The default to ship: `recommended` when the targets agree, otherwise
   * `lowestSafe` — scope.md §1, "empty beats irrelevant", ranks a page
   * showing nothing above a page showing an unrelated quote, so the cap on
   * false positives wins the conflict and recall is what gives.
   */
  readonly chosen: number | null;
}

export interface QueryVerdict {
  readonly id: string;
  readonly q: string;
  readonly kind: RelevanceKind;
  readonly tags: readonly RelevanceTag[];
  /** Expected keys missing at the floor, with the similarity they did get (null: never returned). */
  readonly missed: readonly { key: string; similarity: number | null }[];
  /** Rows at the floor that are neither expected nor acceptable. */
  readonly falsePositives: readonly ObservedRow[];
  readonly hits: readonly ObservedRow[];
}

export interface CurveOptions {
  readonly from?: number;
  readonly to?: number;
  readonly step?: number;
  readonly minRecall?: number;
  readonly maxNegativeRate?: number;
}

export interface Curve {
  readonly floors: readonly FloorPoint[];
  readonly distributions: {
    /** Similarities of expected reviews, over positives. */
    readonly positiveHits: Percentiles;
    /** Similarities of positives' rows that are neither expected nor acceptable. */
    readonly positiveFalse: Percentiles;
    /** The best similarity each negative query got (what a floor must exceed). */
    readonly negativeTop: Percentiles;
    /** Every row the negatives returned. */
    readonly negativeAll: Percentiles;
  };
  readonly recommendation: Recommendation;
  readonly counts: {
    readonly positives: number;
    readonly negatives: number;
    readonly policyFiltered: number;
    readonly crossLanguage: number;
  };
}

/** Rows a typical snippet renders (`data-limit="3"`), for `topClean`. */
export const TOP_N = 3;

export const DEFAULT_CURVE_OPTIONS = {
  from: 0.5,
  to: 0.8,
  step: 0.01,
  minRecall: 0.9,
  maxNegativeRate: 0.05,
} as const satisfies Required<CurveOptions>;

/** `from`, `from + step`, …, `to`, each rounded to the step's precision. */
export function floorSteps(from: number, to: number, step: number): number[] {
  if (!(step > 0)) throw new RangeError("step must be positive");
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  const out: number[] = [];
  const n = Math.round((to - from) / step);
  for (let i = 0; i <= n; i++) {
    out.push(Number((from + i * step).toFixed(decimals)));
  }
  return out;
}

/** Nearest-rank percentiles of `values`; null fields when empty. */
export function percentiles(values: readonly number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return { n: 0, p10: null, p50: null, p90: null, min: null, max: null };
  }
  const at = (p: number) =>
    sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))] as number;
  return {
    n,
    p10: at(0.1),
    p50: at(0.5),
    p90: at(0.9),
    min: sorted[0] as number,
    max: sorted[n - 1] as number,
  };
}

function isCrossLanguage(query: ObservedQuery): boolean {
  return query.tags?.includes("cross-language") ?? false;
}

/** The positives the curve is tuned on. */
export function tunedPositives(
  queries: readonly ObservedQuery[],
): ObservedQuery[] {
  return queries.filter((q) => q.kind === "positive" && !isCrossLanguage(q));
}

/** The queries whose correct answer is `[]`. */
export function mustBeEmpty(
  queries: readonly ObservedQuery[],
): ObservedQuery[] {
  return queries.filter(
    (q) => q.kind === "negative" || q.kind === "policy-filtered",
  );
}

/** What one query got right and wrong at `floor`. */
export function verdictAt(query: ObservedQuery, floor: number): QueryVerdict {
  // A must-be-empty query's `expect` names hidden reviews for the record;
  // nothing is expected back, so every row is a false positive.
  const positive = query.kind === "positive";
  const expected = new Set(positive ? query.expect : []);
  const acceptable = new Set(positive ? (query.acceptable ?? []) : []);
  const above = query.rows.filter((row) => row.similarity >= floor);
  const hits = above.filter((row) => expected.has(row.key));
  const falsePositives = above.filter(
    (row) => !expected.has(row.key) && !acceptable.has(row.key),
  );
  const got = new Map(query.rows.map((row) => [row.key, row.similarity]));
  const hitKeys = new Set(hits.map((row) => row.key));
  const missed = [...expected]
    .filter((key) => !hitKeys.has(key))
    .map((key) => ({ key, similarity: got.get(key) ?? null }));
  return {
    id: query.id,
    q: query.q,
    kind: query.kind,
    tags: query.tags ?? [],
    missed,
    falsePositives,
    hits,
  };
}

/** Pooled precision/recall over `positives` and the rate over `negatives` at `floor`. */
export function pointAt(
  positives: readonly ObservedQuery[],
  negatives: readonly ObservedQuery[],
  floor: number,
): FloorPoint {
  let tp = 0;
  let fp = 0;
  let misses = 0;
  let emptyPositives = 0;
  let answered = 0;
  let topClean = 0;
  for (const query of positives) {
    const v = verdictAt(query, floor);
    tp += v.hits.length;
    fp += v.falsePositives.length;
    misses += v.missed.length;
    if (!query.rows.some((row) => row.similarity >= floor)) emptyPositives++;
    if (v.hits.length > 0) answered++;
    const ok = new Set([...query.expect, ...(query.acceptable ?? [])]);
    const top = query.rows
      .filter((row) => row.similarity >= floor)
      .slice(0, TOP_N);
    if (
      top.length > 0 &&
      top.every((row) => ok.has(row.key)) &&
      top.some((row) => query.expect.includes(row.key))
    ) {
      topClean++;
    }
  }
  let negativeQueriesHit = 0;
  let negativeRows = 0;
  for (const query of negatives) {
    const rows = query.rows.filter((row) => row.similarity >= floor).length;
    if (rows > 0) negativeQueriesHit++;
    negativeRows += rows;
  }
  return {
    floor,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + misses === 0 ? 1 : tp / (tp + misses),
    truePositives: tp,
    falsePositives: fp,
    misses,
    emptyPositives,
    answered,
    answeredRate: positives.length === 0 ? 1 : answered / positives.length,
    topClean,
    negativeQueriesHit,
    negativeRate:
      negatives.length === 0 ? 0 : negativeQueriesHit / negatives.length,
    negativeRows,
  };
}

/** The whole curve, distributions, and the recommendation. */
export function computeCurve(
  queries: readonly ObservedQuery[],
  options: CurveOptions = {},
): Curve {
  const opts = { ...DEFAULT_CURVE_OPTIONS, ...options };
  const positives = tunedPositives(queries);
  const negatives = mustBeEmpty(queries);
  const floors = floorSteps(opts.from, opts.to, opts.step).map((floor) =>
    pointAt(positives, negatives, floor),
  );

  const positiveHits: number[] = [];
  const positiveFalse: number[] = [];
  for (const query of positives) {
    const v = verdictAt(query, 0);
    positiveHits.push(...v.hits.map((row) => row.similarity));
    positiveFalse.push(...v.falsePositives.map((row) => row.similarity));
  }
  const negativeTop: number[] = [];
  const negativeAll: number[] = [];
  for (const query of negatives) {
    const sims = query.rows.map((row) => row.similarity);
    negativeAll.push(...sims);
    if (sims.length > 0) negativeTop.push(Math.max(...sims));
  }

  const safe = floors.filter((p) => p.negativeRate <= opts.maxNegativeRate);
  const recalling = floors.filter((p) => p.recall >= opts.minRecall);
  const lowestSafe = safe[0]?.floor ?? null;
  const highestRecall = recalling[recalling.length - 1]?.floor ?? null;
  const both = floors.find(
    (p) => p.negativeRate <= opts.maxNegativeRate && p.recall >= opts.minRecall,
  );

  return {
    floors,
    distributions: {
      positiveHits: percentiles(positiveHits),
      positiveFalse: percentiles(positiveFalse),
      negativeTop: percentiles(negativeTop),
      negativeAll: percentiles(negativeAll),
    },
    recommendation: {
      minRecall: opts.minRecall,
      maxNegativeRate: opts.maxNegativeRate,
      recommended: both?.floor ?? null,
      lowestSafe,
      highestRecall,
      chosen: both?.floor ?? lowestSafe,
    },
    counts: {
      positives: positives.length,
      negatives: queries.filter((q) => q.kind === "negative").length,
      policyFiltered: queries.filter((q) => q.kind === "policy-filtered")
        .length,
      crossLanguage: queries.filter(isCrossLanguage).length,
    },
  };
}

/** Every query's verdict at `floor`, failures first (misses or false positives). */
export function verdictsAt(
  queries: readonly ObservedQuery[],
  floor: number,
): QueryVerdict[] {
  return queries
    .map((query) => verdictAt(query, floor))
    .sort((a, b) => Number(isClean(a)) - Number(isClean(b)));
}

/** True when the query is answered correctly at the floor it was judged at. */
export function isClean(verdict: QueryVerdict): boolean {
  return verdict.missed.length === 0 && verdict.falsePositives.length === 0;
}
