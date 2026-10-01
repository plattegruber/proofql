/**
 * Deterministic sentence-window chunking — FOR THE SEED ONLY.
 *
 * This is a stand-in so the demo corpus has `window` chunks to search over
 * before the ingest pipeline exists. The real chunker is #23 and lives in
 * the pipeline worker; when it lands, the seed should import it and this
 * file should go. Nothing outside `src/seed/` may import this module.
 *
 * Rules (scope.md §2 "Chunking"):
 *
 * - every review gets one `full` chunk: the whole text at offset 0;
 * - a review with more than {@link WINDOW_THRESHOLD} sentences also gets
 *   `window` chunks of {@link WINDOW_SIZE} sentences, each overlapping the
 *   previous one by one sentence (the last window may be two sentences,
 *   never one);
 * - every chunk is a verbatim slice of the review — the window text is
 *   `review.slice(startOffset, startOffset + text.length)`, trimmed only
 *   by moving its boundaries, never by rewriting it.
 *
 * Sentences come from `Intl.Segmenter("en", { granularity: "sentence" })`.
 * ICU's default rules split after any "." followed by a space and a
 * capital, so "Dr. Patel" would become two sentences; segments ending in a
 * short list of honorifics are merged into the next one. Offsets are UTF-16
 * code units, the same unit `String.prototype.slice` uses.
 */

import { assertVerbatimSlice } from "../chunks.js";

/** Reviews with more sentences than this also get window chunks. */
export const WINDOW_THRESHOLD = 3;
/** Sentences per window; consecutive windows share one sentence. */
export const WINDOW_SIZE = 3;
const WINDOW_STEP = WINDOW_SIZE - 1;

/** Abbreviations that must not end a sentence (ICU splits after them). */
const NON_TERMINAL_ABBREVIATIONS =
  /(?:^|\s)(?:Dr|Mr|Mrs|Ms|Jr|Sr|St|Mt|vs|Prof)\.$/;

export interface SeedChunk {
  readonly kind: "full" | "window";
  readonly text: string;
  readonly startOffset: number;
}

export interface SentenceSpan {
  readonly text: string;
  readonly startOffset: number;
}

const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });

/**
 * Split `text` into trimmed sentence spans with their offsets. Whitespace
 * is never part of a span's text; a span's `startOffset` points at its
 * first non-whitespace character.
 */
export function splitSentences(text: string): SentenceSpan[] {
  const raw: { start: number; end: number }[] = [];
  for (const { segment, index } of segmenter.segment(text)) {
    const span = trimSpan(text, index, index + segment.length);
    if (span === null) continue;
    const previous = raw[raw.length - 1];
    if (
      previous &&
      NON_TERMINAL_ABBREVIATIONS.test(text.slice(previous.start, previous.end))
    ) {
      // "Dr." + "Patel did ..." → one sentence.
      previous.end = span.end;
    } else {
      raw.push(span);
    }
  }
  return raw.map(({ start, end }) => ({
    text: text.slice(start, end),
    startOffset: start,
  }));
}

/** Move `[start, end)` inward past whitespace; null when nothing is left. */
function trimSpan(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text.charAt(s))) s++;
  while (e > s && /\s/.test(text.charAt(e - 1))) e--;
  return s < e ? { start: s, end: e } : null;
}

/**
 * The chunks for one review: its `full` chunk first, then any `window`
 * chunks in document order. Every chunk is asserted to be a verbatim slice
 * before it is returned, so a caller can insert the result as-is.
 */
export function chunkReviewText(text: string): SeedChunk[] {
  if (text.trim().length === 0) {
    throw new Error("chunkReviewText: review text is empty");
  }
  const review = { text };
  const chunks: SeedChunk[] = [{ kind: "full", text, startOffset: 0 }];

  const sentences = splitSentences(text);
  if (sentences.length > WINDOW_THRESHOLD) {
    // start < n - 1 so the final window always has at least two sentences.
    for (let start = 0; start < sentences.length - 1; start += WINDOW_STEP) {
      const first = sentences[start];
      const last =
        sentences[Math.min(start + WINDOW_SIZE, sentences.length) - 1];
      if (!first || !last) break;
      const startOffset = first.startOffset;
      const end = last.startOffset + last.text.length;
      chunks.push({
        kind: "window",
        text: text.slice(startOffset, end),
        startOffset,
      });
    }
  }

  for (const chunk of chunks) assertVerbatimSlice(review, chunk);
  return chunks;
}
