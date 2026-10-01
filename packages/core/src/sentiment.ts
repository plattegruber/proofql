/**
 * Rating-based sentiment (scope.md §2 "Sentiment gate").
 *
 * Reviews almost always carry a star rating; it is the sentiment signal, and
 * it is free. The pipeline stores the result on the review with
 * `sentiment_source = 'rating'`. Only reviews with `rating = null` fall
 * through to the Workers AI classifier (`sentiment_source = 'model'`); that
 * path lives in `@proofql/ai`, not here.
 */

export const SENTIMENTS = ["positive", "neutral", "negative"] as const;

export type Sentiment = (typeof SENTIMENTS)[number];

/**
 * Map a 1–5 star rating to sentiment: 4–5 positive, 3 neutral, 1–2 negative.
 *
 * Throws `RangeError` for anything that is not an integer in 1..5. Ratings
 * reach this function only after `reviewInputSchema` has validated them, so
 * an out-of-range value here is a programming error, not bad user input.
 */
export function sentimentFromRating(rating: number): Sentiment {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new RangeError(
      `rating must be an integer from 1 to 5, got ${String(rating)}`,
    );
  }
  if (rating >= 4) return "positive";
  if (rating === 3) return "neutral";
  return "negative";
}
