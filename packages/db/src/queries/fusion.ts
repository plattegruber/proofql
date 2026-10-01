/**
 * Reciprocal Rank Fusion (RRF) — the pure, unit-testable half of hybrid
 * search (#16). `searchChunks.ts` computes the same formula inside its SQL
 * statement (ranking and per-review collapse have to happen in the
 * database); these functions are the reference the SQL is checked against
 * and the normalization step the row mapper applies.
 *
 * RRF fuses several ranked lists without comparing their scores, which is
 * the point: cosine similarity and `ts_rank_cd` live on unrelated scales.
 * A candidate's fused score is the sum over lists of `1 / (k + rank)`,
 * where `rank` is its 1-based position in that list and a candidate absent
 * from a list contributes 0. `k = 60` is the constant from the original
 * paper (Cormack, Clarke & Buettcher, 2009); it damps the gap between
 * rank 1 and rank 2 so one list cannot dominate the other.
 */

/** The standard RRF constant. */
export const RRF_K = 60;

/**
 * One list's contribution for a candidate at 1-based `rank`, or 0 when the
 * candidate is absent from the list (`null`).
 */
export function rrfContribution(
  rank: number | null,
  k: number = RRF_K,
): number {
  if (rank === null) return 0;
  if (!Number.isInteger(rank) || rank < 1) {
    throw new RangeError(`rrf rank must be a positive integer, got ${rank}`);
  }
  return 1 / (k + rank);
}

/**
 * The raw fused score of a candidate from its rank in each list (`null`
 * where it does not appear).
 */
export function rrfScore(
  ranks: ReadonlyArray<number | null>,
  k: number = RRF_K,
): number {
  let score = 0;
  for (const rank of ranks) score += rrfContribution(rank, k);
  return score;
}

/**
 * The largest raw score possible with `lists` ranked lists: rank 1 in every
 * one of them.
 */
export function maxRrfScore(lists: number, k: number = RRF_K): number {
  return lists / (k + 1);
}

/**
 * Map a raw RRF score onto [0, 1] by dividing by {@link maxRrfScore}, so a
 * candidate ranked first in every active list scores exactly 1 and one
 * absent from every list scores 0. `lists` is the number of lists that
 * actually took part in the fusion (hybrid: 2; vector-only when no query
 * text was given: 1), so the top candidate scores 1 either way and scores
 * stay comparable across queries. The result is clamped against float
 * noise; the mapping is monotone, so ordering by it equals ordering by the
 * raw score.
 */
export function normalizeRrf(
  score: number,
  lists: number,
  k: number = RRF_K,
): number {
  if (!Number.isInteger(lists) || lists < 1) {
    throw new RangeError(`lists must be a positive integer, got ${lists}`);
  }
  const normalized = score / maxRrfScore(lists, k);
  return Math.min(1, Math.max(0, normalized));
}

export interface Fused<T> {
  item: T;
  /** Raw RRF score — see {@link normalizeRrf} for the [0, 1] mapping. */
  score: number;
  /** 1-based rank per input list, `null` where the item was absent. */
  ranks: Array<number | null>;
}

/**
 * Fuse ranked lists (best first; rank = index + 1) into one list ordered
 * by descending RRF score. Items are compared by identity, or by `key`
 * when given. Ties are broken by `tieBreak` when given, else by first
 * appearance across the lists in order, so the output is deterministic.
 */
export function fuseRanked<T>(
  lists: ReadonlyArray<ReadonlyArray<T>>,
  options: {
    k?: number;
    key?: (item: T) => unknown;
    tieBreak?: (a: T, b: T) => number;
  } = {},
): Array<Fused<T>> {
  const k = options.k ?? RRF_K;
  const key = options.key ?? ((item: T) => item);
  const entries = new Map<unknown, Fused<T> & { order: number }>();

  lists.forEach((list, listIndex) => {
    list.forEach((item, position) => {
      const id = key(item);
      let entry = entries.get(id);
      if (!entry) {
        entry = {
          item,
          score: 0,
          ranks: new Array<number | null>(lists.length).fill(null),
          order: entries.size,
        };
        entries.set(id, entry);
      }
      // A list ranks each item once; keep the best rank if it repeats.
      if (entry.ranks[listIndex] === null) {
        entry.ranks[listIndex] = position + 1;
        entry.score += rrfContribution(position + 1, k);
      }
    });
  });

  return [...entries.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        (options.tieBreak ? options.tieBreak(a.item, b.item) : 0) ||
        a.order - b.order,
    )
    .map(({ item, score, ranks }) => ({ item, score, ranks }));
}
