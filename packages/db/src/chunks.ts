/**
 * The verbatim-slice invariant for review chunks (scope.md §4).
 *
 * A chunk's `text` must be exactly the slice of its parent review's text
 * that begins at `start_offset`. This is the property that makes "a
 * fabricated quote cannot exist" true: the pipeline only ever stores
 * slices, and this check is the gate on the write path. It spans two
 * tables, so it cannot be a database CHECK constraint; it is a pure function
 * instead, unit-tested here and asserted in the integration tests.
 *
 * Offsets are JavaScript string indices (UTF-16 code units), the same unit
 * `String.prototype.slice` uses, because the chunker runs in a Worker and
 * the snippet renders in a browser — both speak UTF-16. Nothing in Postgres
 * interprets `start_offset`.
 */

export interface VerbatimSliceReview {
  readonly text: string;
}

export interface VerbatimSliceChunk {
  readonly text: string;
  readonly startOffset: number;
}

export class VerbatimSliceError extends Error {
  override readonly name = "VerbatimSliceError";

  constructor(
    message: string,
    readonly chunk: VerbatimSliceChunk,
  ) {
    super(message);
  }
}

/**
 * True when `chunk.text` is exactly
 * `review.text.slice(chunk.startOffset, chunk.startOffset + chunk.text.length)`.
 * Empty chunks are never valid: an excerpt with no text is not an excerpt.
 */
export function isVerbatimSlice(
  review: VerbatimSliceReview,
  chunk: VerbatimSliceChunk,
): boolean {
  const { text, startOffset } = chunk;
  if (!Number.isInteger(startOffset) || startOffset < 0) return false;
  if (text.length === 0) return false;
  if (startOffset + text.length > review.text.length) return false;
  return review.text.slice(startOffset, startOffset + text.length) === text;
}

/**
 * Throw {@link VerbatimSliceError} unless `chunk` is a verbatim slice of
 * `review`. Call this before every chunk insert.
 */
export function assertVerbatimSlice(
  review: VerbatimSliceReview,
  chunk: VerbatimSliceChunk,
): void {
  if (isVerbatimSlice(review, chunk)) return;
  const { text, startOffset } = chunk;
  const actual = review.text.slice(startOffset, startOffset + text.length);
  throw new VerbatimSliceError(
    `chunk is not a verbatim slice of its review at offset ${startOffset}: ` +
      `expected ${JSON.stringify(actual)}, got ${JSON.stringify(text)}`,
    chunk,
  );
}
