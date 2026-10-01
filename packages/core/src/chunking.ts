/**
 * Deterministic review chunking (scope.md §2 "Chunking", §4).
 *
 * Every review yields one `full` chunk covering its whole text. Reviews with
 * more than a few sentences also yield `window` chunks of up to three
 * sentences, stepping by two so consecutive windows overlap by one, so a
 * review that covers four topics can match four queries. The best-matching
 * chunk is the excerpt the API returns.
 *
 * **Verbatim by construction.** Every chunk's `text` is a slice of the
 * input and `startOffset` is where that slice begins:
 *
 *     text.slice(chunk.startOffset, chunk.startOffset + chunk.text.length) === chunk.text
 *
 * Offsets are UTF-16 code units — the unit `String.prototype.slice` and
 * `Intl.Segmenter` both use — so the invariant holds in the Worker that
 * chunks and the browser that renders, byte-for-byte, for emoji, combining
 * marks, and CJK alike (see packages/db README "Verbatim slices"). Nothing
 * here generates or normalizes text: whitespace is trimmed from a window by
 * shrinking the slice, never by altering characters.
 *
 * Sentence boundaries come from `Intl.Segmenter` with `granularity:
 * "sentence"`, which is Unicode UAX #29 sentence segmentation and needs no
 * per-language rule tables. The review's BCP 47 `language` is passed as the
 * locale when present; an unknown or malformed tag falls back to `"en"`
 * rather than failing the review.
 *
 * Pure: no I/O, no database. The pipeline (#23) calls `chunkReview` and the
 * demo seed (#20) is meant to switch to it.
 */

export const CHUNK_KINDS = ["full", "window"] as const;
export type ChunkKind = (typeof CHUNK_KINDS)[number];

export interface Chunk {
  readonly kind: ChunkKind;
  /** A verbatim slice of the review text. Never empty. */
  readonly text: string;
  /** UTF-16 code-unit index of `text` within the review text. */
  readonly startOffset: number;
}

export interface ChunkOptions {
  /**
   * BCP 47 tag for sentence segmentation (the review's `language`).
   * `null`/`undefined`/unparseable → `"en"`.
   */
  locale?: string | null;
  /** Sentences per window (default 3). */
  maxSentencesPerWindow?: number;
  /** Sentences to advance between windows (default 2 → overlap of one). */
  windowStep?: number;
  /**
   * Windows are only emitted when the review has at least this many
   * sentences (default 4). Shorter reviews are a single `full` chunk.
   */
  minSentencesForWindows?: number;
}

export const DEFAULT_CHUNK_OPTIONS = {
  locale: "en",
  maxSentencesPerWindow: 3,
  windowStep: 2,
  minSentencesForWindows: 4,
} as const satisfies Required<ChunkOptions>;

/** A sentence's position in the text, with surrounding whitespace excluded. */
export interface SentenceSpan {
  /** Inclusive UTF-16 start index. */
  readonly start: number;
  /** Exclusive UTF-16 end index. */
  readonly end: number;
}

/** Thrown by {@link assertVerbatimChunks} when a chunk is not a slice. */
export class ChunkInvariantError extends Error {
  override readonly name = "ChunkInvariantError";

  constructor(
    message: string,
    readonly chunk: Chunk,
  ) {
    super(message);
  }
}

/**
 * Chunk a review's text.
 *
 * Returns the `full` chunk first, then `window` chunks in text order. Throws
 * `RangeError` when `text` is empty or whitespace-only — there is nothing to
 * index, and callers are expected to skip such reviews rather than store an
 * empty excerpt.
 */
export function chunkReview(text: string, options: ChunkOptions = {}): Chunk[] {
  if (text.trim().length === 0) {
    throw new RangeError("chunkReview: text is empty or whitespace-only");
  }
  const resolved = resolveOptions(options);

  const chunks: Chunk[] = [{ kind: "full", text, startOffset: 0 }];

  const sentences = segmentSentences(text, resolved.locale);
  if (sentences.length < resolved.minSentencesForWindows) {
    return chunks;
  }

  for (const window of planWindows(sentences.length, resolved)) {
    const first = sentences[window.start];
    const last = sentences[window.end - 1];
    if (!first || !last) continue; // unreachable: planWindows stays in range
    // A single window spanning every sentence would duplicate the full chunk.
    if (window.start === 0 && window.end === sentences.length) continue;
    chunks.push({
      kind: "window",
      text: text.slice(first.start, last.end),
      startOffset: first.start,
    });
  }

  return chunks;
}

/**
 * Split `text` into sentence spans with `Intl.Segmenter`. Leading and
 * trailing whitespace of each sentence is excluded by moving the span's
 * bounds; whitespace-only segments are dropped. Spans are in text order and
 * never overlap. Text with no sentence boundary is one span.
 */
export function segmentSentences(
  text: string,
  locale: string | null | undefined = DEFAULT_CHUNK_OPTIONS.locale,
): SentenceSpan[] {
  const segmenter = createSegmenter(locale);
  const spans: SentenceSpan[] = [];
  for (const { segment, index } of segmenter.segment(text)) {
    const span = trimSpan(text, index, index + segment.length);
    if (span) spans.push(span);
  }
  return spans;
}

/**
 * Throw {@link ChunkInvariantError} unless every chunk is a non-empty
 * verbatim slice of `text` at its `startOffset`. The pipeline calls this
 * before writing; tests call it on every generated input.
 */
export function assertVerbatimChunks(
  text: string,
  chunks: readonly Chunk[],
): void {
  for (const chunk of chunks) {
    const { startOffset } = chunk;
    if (!Number.isInteger(startOffset) || startOffset < 0) {
      throw new ChunkInvariantError(
        `chunk startOffset must be a non-negative integer, got ${String(startOffset)}`,
        chunk,
      );
    }
    if (chunk.text.length === 0) {
      throw new ChunkInvariantError(
        `chunk at offset ${startOffset} is empty`,
        chunk,
      );
    }
    const actual = text.slice(startOffset, startOffset + chunk.text.length);
    if (actual !== chunk.text) {
      throw new ChunkInvariantError(
        `chunk is not a verbatim slice at offset ${startOffset}: ` +
          `expected ${JSON.stringify(actual)}, got ${JSON.stringify(chunk.text)}`,
        chunk,
      );
    }
  }
}

interface WindowPlan {
  /** Inclusive sentence index. */
  start: number;
  /** Exclusive sentence index. */
  end: number;
}

/**
 * Window boundaries over `count` sentences: `maxSentencesPerWindow` wide,
 * advancing `windowStep` each time. The final window takes whatever remains
 * when that is at least two sentences; a single trailing sentence is folded
 * into the previous window instead of becoming a one-sentence excerpt.
 */
function planWindows(
  count: number,
  { maxSentencesPerWindow, windowStep }: ResolvedOptions,
): WindowPlan[] {
  const windows: WindowPlan[] = [];
  for (let start = 0; start < count; start += windowStep) {
    const end = Math.min(start + maxSentencesPerWindow, count);
    const isLast = end === count;
    const previous = windows[windows.length - 1];
    if (isLast && count - start < 2 && previous) {
      previous.end = count;
      break;
    }
    windows.push({ start, end });
    if (isLast) break;
  }
  return windows;
}

type ResolvedOptions = Required<Omit<ChunkOptions, "locale">> & {
  locale: string;
};

function resolveOptions(options: ChunkOptions): ResolvedOptions {
  const maxSentencesPerWindow =
    options.maxSentencesPerWindow ??
    DEFAULT_CHUNK_OPTIONS.maxSentencesPerWindow;
  const windowStep = options.windowStep ?? DEFAULT_CHUNK_OPTIONS.windowStep;
  const minSentencesForWindows =
    options.minSentencesForWindows ??
    DEFAULT_CHUNK_OPTIONS.minSentencesForWindows;
  assertPositiveInteger("maxSentencesPerWindow", maxSentencesPerWindow);
  assertPositiveInteger("windowStep", windowStep);
  assertPositiveInteger("minSentencesForWindows", minSentencesForWindows);
  if (windowStep > maxSentencesPerWindow) {
    throw new RangeError(
      "chunkReview: windowStep must not exceed maxSentencesPerWindow " +
        "(windows would skip sentences)",
    );
  }
  return {
    locale: options.locale ?? DEFAULT_CHUNK_OPTIONS.locale,
    maxSentencesPerWindow,
    windowStep,
    minSentencesForWindows,
  };
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `chunkReview: ${name} must be a positive integer, got ${String(value)}`,
    );
  }
}

/**
 * `Intl.Segmenter` for `locale`, falling back to English when the tag is
 * not a structurally valid BCP 47 tag (the constructor throws RangeError).
 * Sentence segmentation is UAX #29 and barely locale-sensitive, so the
 * fallback costs nothing in practice.
 */
function createSegmenter(locale: string | null | undefined): Intl.Segmenter {
  const candidate = locale?.trim() || DEFAULT_CHUNK_OPTIONS.locale;
  try {
    return new Intl.Segmenter(candidate, { granularity: "sentence" });
  } catch (error) {
    if (error instanceof RangeError) {
      return new Intl.Segmenter(DEFAULT_CHUNK_OPTIONS.locale, {
        granularity: "sentence",
      });
    }
    throw error;
  }
}

/** Shrink `[start, end)` past leading and trailing whitespace; null if empty. */
function trimSpan(
  text: string,
  start: number,
  end: number,
): SentenceSpan | null {
  let s = start;
  let e = end;
  while (s < e && isWhitespace(text, s)) s++;
  while (e > s && isWhitespace(text, e - 1)) e--;
  return s < e ? { start: s, end: e } : null;
}

const WHITESPACE = /\s/;

function isWhitespace(text: string, index: number): boolean {
  return WHITESPACE.test(text.charAt(index));
}
