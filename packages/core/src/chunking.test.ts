import { describe, expect, it } from "vitest";

import {
  ALWAYS_MERGE_ABBREVIATIONS,
  assertVerbatimChunks,
  type Chunk,
  ChunkInvariantError,
  chunkReview,
  DEFAULT_CHUNK_OPTIONS,
  SENTENCE_ABBREVIATIONS,
  segmentSentences,
} from "./chunking.js";

/** The invariant every chunk must satisfy, stated directly. */
function expectVerbatim(text: string, chunks: readonly Chunk[]): void {
  for (const chunk of chunks) {
    expect(chunk.text.length).toBeGreaterThan(0);
    expect(
      text.slice(chunk.startOffset, chunk.startOffset + chunk.text.length),
    ).toBe(chunk.text);
  }
  expect(() => assertVerbatimChunks(text, chunks)).not.toThrow();
}

function windows(chunks: readonly Chunk[]): Chunk[] {
  return chunks.filter((c) => c.kind === "window");
}

function sentenceChunks(chunks: readonly Chunk[]): Chunk[] {
  return chunks.filter((c) => c.kind === "sentence");
}

function sentences(n: number): string {
  return Array.from({ length: n }, (_, i) => `Sentence ${i + 1}.`).join(" ");
}

describe("chunkReview", () => {
  it("emits the full chunk and one sentence chunk per sentence for a short review", () => {
    const text = "Great service. Would recommend. Five stars.";
    const chunks = chunkReview(text);

    expect(chunks).toEqual([
      { kind: "full", text, startOffset: 0 },
      { kind: "sentence", text: "Great service.", startOffset: 0 },
      { kind: "sentence", text: "Would recommend.", startOffset: 15 },
      { kind: "sentence", text: "Five stars.", startOffset: 32 },
    ]);
    expectVerbatim(text, chunks);
  });

  it("a single-sentence review is the full chunk alone", () => {
    const text = "Great service from start to finish!";
    expect(chunkReview(text)).toEqual([{ kind: "full", text, startOffset: 0 }]);
  });

  it("emits the full chunk first, as the whole text at offset 0", () => {
    const text = sentences(7);
    const [full] = chunkReview(text);

    expect(full).toEqual({ kind: "full", text, startOffset: 0 });
  });

  it("four sentences → full + two windows + four sentences with correct offsets", () => {
    const text = "One. Two! Three? Four.";
    const chunks = chunkReview(text);

    expect(chunks).toEqual([
      { kind: "full", text, startOffset: 0 },
      { kind: "window", text: "One. Two! Three?", startOffset: 0 },
      { kind: "window", text: "Three? Four.", startOffset: 10 },
      { kind: "sentence", text: "One.", startOffset: 0 },
      { kind: "sentence", text: "Two!", startOffset: 5 },
      { kind: "sentence", text: "Three?", startOffset: 10 },
      { kind: "sentence", text: "Four.", startOffset: 17 },
    ]);
    expectVerbatim(text, chunks);
  });

  it("seven sentences → windows [0-2], [2-4], [4-6]", () => {
    const text = sentences(7);
    const w = windows(chunkReview(text));

    expect(w.map((c) => c.text)).toEqual([
      "Sentence 1. Sentence 2. Sentence 3.",
      "Sentence 3. Sentence 4. Sentence 5.",
      "Sentence 5. Sentence 6. Sentence 7.",
    ]);
    expect(w.map((c) => c.startOffset)).toEqual([0, 24, 48]);
    expectVerbatim(text, chunkReview(text));
  });

  it("the last window takes the remainder when it is at least two sentences", () => {
    const text = sentences(6);
    const w = windows(chunkReview(text));

    expect(w.map((c) => c.text)).toEqual([
      "Sentence 1. Sentence 2. Sentence 3.",
      "Sentence 3. Sentence 4. Sentence 5.",
      "Sentence 5. Sentence 6.",
    ]);
  });

  it("folds a single trailing sentence into the previous window", () => {
    // Non-overlapping windows of two leave one sentence over.
    const text = sentences(5);
    const w = windows(
      chunkReview(text, { maxSentencesPerWindow: 2, windowStep: 2 }),
    );

    expect(w.map((c) => c.text)).toEqual([
      "Sentence 1. Sentence 2.",
      "Sentence 3. Sentence 4. Sentence 5.",
    ]);
    expectVerbatim(text, chunkReview(text));
  });

  it("drops a lone window that would duplicate the full chunk", () => {
    const text = sentences(4);
    const chunks = chunkReview(text, { maxSentencesPerWindow: 10 });

    expect(windows(chunks)).toHaveLength(0);
    expect(chunks.map((c) => c.kind)).toEqual([
      "full",
      "sentence",
      "sentence",
      "sentence",
      "sentence",
    ]);
  });

  it("respects minSentencesForWindows", () => {
    const text = sentences(3);

    expect(windows(chunkReview(text))).toHaveLength(0);
    expect(
      windows(
        chunkReview(text, {
          minSentencesForWindows: 3,
          maxSentencesPerWindow: 2,
          windowStep: 1,
        }),
      ).map((c) => c.text),
    ).toEqual(["Sentence 1. Sentence 2.", "Sentence 2. Sentence 3."]);
  });

  it("text with no sentence boundary is the full chunk only", () => {
    const text = "no punctuation and no boundaries anywhere in here";

    expect(chunkReview(text)).toEqual([{ kind: "full", text, startOffset: 0 }]);
  });

  it("throws RangeError for empty or whitespace-only text", () => {
    expect(() => chunkReview("")).toThrow(RangeError);
    expect(() => chunkReview("   \n\t ")).toThrow(RangeError);
  });

  it("rejects nonsensical options", () => {
    expect(() => chunkReview("a. b. c. d.", { windowStep: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      chunkReview("a. b. c. d.", { maxSentencesPerWindow: 2, windowStep: 3 }),
    ).toThrow(RangeError);
    expect(() =>
      chunkReview("a. b. c. d.", { minSentencesForWindows: 1.5 }),
    ).toThrow(RangeError);
  });

  describe("verbatim slices across scripts and whitespace", () => {
    it("emoji with skin-tone modifiers and accented Latin", () => {
      const text =
        "Great 👍🏽 service from the café. Crème brûlée was perfect! " +
        "Staff 🙏 were kind. Would go again 👍🏽👍🏽. Really.";
      const chunks = chunkReview(text);

      expect(windows(chunks).length).toBeGreaterThan(0);
      expectVerbatim(text, chunks);
      // Offsets are UTF-16 code units: the surrogate pairs before the second
      // window shift it further than its code-point index would suggest.
      const second = windows(chunks)[1];
      expect(second?.text.startsWith("Staff")).toBe(true);
      expect(second?.startOffset).toBe(text.indexOf("Staff"));
    });

    it("CJK with the ja locale", () => {
      const text = "こんにちは。元気ですか？はい。元気です。また来ます。";
      const chunks = chunkReview(text, { locale: "ja" });

      expect(windows(chunks).map((c) => c.text)).toEqual([
        "こんにちは。元気ですか？はい。",
        "はい。元気です。また来ます。",
      ]);
      expectVerbatim(text, chunks);
    });

    it("CRLF newlines between sentences", () => {
      const text = "Line one.\r\nLine two.\r\nLine three.\r\nLine four.";
      const chunks = chunkReview(text);

      expect(windows(chunks).map((c) => c.text)).toEqual([
        "Line one.\r\nLine two.\r\nLine three.",
        "Line three.\r\nLine four.",
      ]);
      expectVerbatim(text, chunks);
    });

    it("leading whitespace stays in the full chunk and out of the windows", () => {
      const text = "   Leading. Second. Third. Fourth.";
      const chunks = chunkReview(text);

      expect(chunks[0]).toEqual({ kind: "full", text, startOffset: 0 });
      expect(windows(chunks)[0]).toEqual({
        kind: "window",
        text: "Leading. Second. Third.",
        startOffset: 3,
      });
      expectVerbatim(text, chunks);
    });

    it("falls back to English for an unparseable locale", () => {
      const text = sentences(4);

      expect(chunkReview(text, { locale: "not a tag!!" })).toEqual(
        chunkReview(text, { locale: "en" }),
      );
      expect(chunkReview(text, { locale: null })).toEqual(chunkReview(text));
    });
  });

  it("holds the verbatim invariant over generated texts", () => {
    // Deterministic LCG so a failure reproduces; mixes scripts, emoji,
    // CRLF, runs of whitespace, and sentence terminators.
    let seed = 20_260_923;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
      return seed % n;
    };
    const words = [
      "great",
      "café",
      "naïve",
      "👍🏽",
      "🙏",
      "東京",
      "implant",
      "Dr.",
      "e.g.",
      "staff",
      "日本語",
      "Ωmega",
    ];
    const terminators = [". ", "! ", "? ", ".\r\n", ".\n\n", "。", "   ", ". "];

    for (let i = 0; i < 50; i++) {
      const sentenceCount = 1 + rand(9);
      let text = rand(4) === 0 ? "  " : "";
      for (let s = 0; s < sentenceCount; s++) {
        const wordCount = 1 + rand(6);
        const ws = Array.from(
          { length: wordCount },
          () => words[rand(words.length)],
        );
        text += ws.join(" ") + (terminators[rand(terminators.length)] ?? ". ");
      }
      const chunks = chunkReview(text, {
        locale: rand(3) === 0 ? "ja" : "en",
        maxSentencesPerWindow: 2 + rand(3),
        windowStep: 1 + rand(2),
      });
      expect(chunks[0]).toEqual({ kind: "full", text, startOffset: 0 });
      expectVerbatim(text, chunks);
      // Windows are in text order and never empty; so are sentences, and
      // the kinds come out in blocks: full, windows, sentences.
      const offsets = windows(chunks).map((c) => c.startOffset);
      expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
      const sentenceOffsets = sentenceChunks(chunks).map((c) => c.startOffset);
      expect([...sentenceOffsets].sort((a, b) => a - b)).toEqual(
        sentenceOffsets,
      );
      expect(chunks.map((c) => c.kind).join(",")).toMatch(
        /^full(,window)*(,sentence)*$/,
      );
      // No chunk duplicates the full text.
      for (const c of chunks.slice(1)) expect(c.text).not.toBe(text);
    }
  });

  describe("sentence chunks (#127)", () => {
    it.each([
      [1, 0, 0],
      [2, 0, 2],
      [3, 0, 3],
      [4, 2, 4],
      [7, 3, 7],
    ])("%i sentences → %i windows and %i sentence chunks", (count, windowCount, sentenceCount) => {
      const text = sentences(count);
      const chunks = chunkReview(text);

      expect(chunks[0]).toEqual({ kind: "full", text, startOffset: 0 });
      expect(windows(chunks)).toHaveLength(windowCount);
      expect(sentenceChunks(chunks)).toHaveLength(sentenceCount);
      expect(chunks).toHaveLength(1 + windowCount + sentenceCount);
      expectVerbatim(text, chunks);
    });

    it("emits full, then windows, then sentences, each block in text order", () => {
      const text = sentences(7);
      const kinds = chunkReview(text).map((c) => c.kind);

      expect(kinds).toEqual([
        "full",
        "window",
        "window",
        "window",
        ...Array.from({ length: 7 }, () => "sentence" as const),
      ]);
    });

    it("every sentence chunk is exactly a segmentSentences span", () => {
      const text =
        "  Dr. Patel did my implant. It was painless! Would I go back? Yes.  ";
      const chunks = chunkReview(text);
      const spans = segmentSentences(text);

      expect(sentenceChunks(chunks)).toEqual(
        spans.map((s) => ({
          kind: "sentence",
          text: text.slice(s.start, s.end),
          startOffset: s.start,
        })),
      );
      expect(sentenceChunks(chunks).map((c) => c.text)).toEqual([
        "Dr. Patel did my implant.",
        "It was painless!",
        "Would I go back?",
        "Yes.",
      ]);
      expectVerbatim(text, chunks);
    });

    it("never duplicates the full chunk, even when the text is one trimmed sentence", () => {
      for (const text of [
        "Just one sentence.",
        "  padded single sentence  ",
        "no terminator at all",
        "こんにちは。",
      ]) {
        const chunks = chunkReview(text);
        expect(chunks, text).toEqual([{ kind: "full", text, startOffset: 0 }]);
      }
    });

    it("emoji before the sentence shift its UTF-16 offset, not its text", () => {
      const text =
        "Great 👍🏽 service. Crème brûlée 🙏 was perfect! Would go again.";
      const chunks = chunkReview(text);
      const s = sentenceChunks(chunks);

      expect(s.map((c) => c.text)).toEqual([
        "Great 👍🏽 service.",
        "Crème brûlée 🙏 was perfect!",
        "Would go again.",
      ]);
      // Two surrogate pairs in the first sentence: the code-unit offset of
      // the second sentence is larger than its code-point index.
      expect(s[1]?.startOffset).toBe(text.indexOf("Crème"));
      expect([...text.slice(0, s[1]?.startOffset)].length).toBeLessThan(
        s[1]?.startOffset ?? 0,
      );
      expectVerbatim(text, chunks);
    });

    it("CJK with the ja locale: one chunk per 。/？ sentence", () => {
      const text = "こんにちは。元気ですか？はい。元気です。また来ます。";
      const chunks = chunkReview(text, { locale: "ja" });

      expect(sentenceChunks(chunks).map((c) => c.text)).toEqual([
        "こんにちは。",
        "元気ですか？",
        "はい。",
        "元気です。",
        "また来ます。",
      ]);
      expect(windows(chunks)).toHaveLength(2);
      expectVerbatim(text, chunks);
    });

    it("CRLF between sentences stays out of the sentence chunks", () => {
      const text = "Line one.\r\nLine two.\r\nLine three.";
      const chunks = chunkReview(text);

      expect(sentenceChunks(chunks)).toEqual([
        { kind: "sentence", text: "Line one.", startOffset: 0 },
        { kind: "sentence", text: "Line two.", startOffset: 11 },
        { kind: "sentence", text: "Line three.", startOffset: 22 },
      ]);
      expectVerbatim(text, chunks);
    });

    it("sentenceChunks: false reproduces the full + windows output", () => {
      for (const count of [1, 2, 3, 4, 5, 6, 7]) {
        const text = sentences(count);
        const legacy = chunkReview(text, { sentenceChunks: false });
        const current = chunkReview(text);

        expect(legacy.some((c) => c.kind === "sentence")).toBe(false);
        expect(legacy).toEqual(
          current.filter((c) => c.kind === "full" || c.kind === "window"),
        );
      }
      expect(
        chunkReview("Great service. Would recommend. Five stars.", {
          sentenceChunks: false,
        }),
      ).toEqual([
        {
          kind: "full",
          text: "Great service. Would recommend. Five stars.",
          startOffset: 0,
        },
      ]);
      expect(DEFAULT_CHUNK_OPTIONS.sentenceChunks).toBe(true);
    });
  });
});

describe("segmentSentences", () => {
  it("excludes surrounding whitespace from every span", () => {
    const text = "  First one.  \n Second one.\r\nThird.";
    const spans = segmentSentences(text);

    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual([
      "First one.",
      "Second one.",
      "Third.",
    ]);
  });

  it("returns no spans for whitespace-only text", () => {
    expect(segmentSentences(" \n ")).toEqual([]);
  });

  it("uses the default locale when none is given", () => {
    expect(DEFAULT_CHUNK_OPTIONS.locale).toBe("en");
    expect(segmentSentences("A. B.")).toEqual(segmentSentences("A. B.", "en"));
  });

  describe("abbreviations (#77)", () => {
    const texts = (text: string, locale?: string) =>
      segmentSentences(text, locale).map((s) => text.slice(s.start, s.end));

    it("the always-merge set is a subset of the abbreviation list", () => {
      for (const abbreviation of ALWAYS_MERGE_ABBREVIATIONS) {
        expect(SENTENCE_ABBREVIATIONS).toContain(abbreviation);
      }
    });

    it.each([
      ...ALWAYS_MERGE_ABBREVIATIONS,
    ])("does not split after %s. even when a capital follows", (abbreviation) => {
      // Title-case the token the way it appears in prose ("Dr.", "E.g.").
      const shown =
        abbreviation.charAt(0).toUpperCase() + abbreviation.slice(1);
      const text = `I went with ${shown}. Patel today. It was fine.`;
      // Sanity: the raw segmenter does split here, so the merge is doing
      // the work (except for e.g./i.e., where engines vary).
      expect(texts(text)).toEqual([
        `I went with ${shown}. Patel today.`,
        "It was fine.",
      ]);
      // Case-insensitive: the lowercase/uppercase spellings merge too.
      expect(
        texts(`I went with ${abbreviation.toUpperCase()}. Patel today.`),
      ).toHaveLength(1);
    });

    it("Dr. Patel did my implant. It was painless. → two sentences", () => {
      expect(texts("Dr. Patel did my implant. It was painless.")).toEqual([
        "Dr. Patel did my implant.",
        "It was painless.",
      ]);
    });

    it("still splits after an unlisted abbreviation followed by a capital", () => {
      expect(texts("I waited 20 min. Then left.")).toEqual([
        "I waited 20 min.",
        "Then left.",
      ]);
    });

    it("etc. followed by a capital letter is a real sentence end", () => {
      expect(
        texts(
          "They do cleanings, fillings, and so on, etc. The staff were kind.",
        ),
      ).toEqual([
        "They do cleanings, fillings, and so on, etc.",
        "The staff were kind.",
      ]);
    });

    it.each([
      "etc",
      "inc",
      "no",
      "co",
      "rd",
    ])("%s. merges only when lowercase follows", (abbreviation) => {
      const shown =
        abbreviation.charAt(0).toUpperCase() + abbreviation.slice(1);
      expect(texts(`Acme ${shown}. opened a new office.`)).toHaveLength(1);
      expect(texts(`Acme ${shown}. Opened a new office.`)).toHaveLength(2);
    });

    it("Acme Inc. opened a new office. → one sentence", () => {
      expect(texts("Acme Inc. opened a new office.")).toEqual([
        "Acme Inc. opened a new office.",
      ]);
    });

    it("merges initials: J. R. Smith was great. → one sentence", () => {
      expect(texts("J. R. Smith was great.")).toEqual([
        "J. R. Smith was great.",
      ]);
      // An initial after an honorific keeps merging through to the surname.
      expect(texts("Thanks to Dr. J. Smith. Great visit.")).toEqual([
        "Thanks to Dr. J. Smith.",
        "Great visit.",
      ]);
    });

    it("repeats the merge across consecutive abbreviations", () => {
      expect(texts("Dr. Mr. Smith came by. Then left.")).toEqual([
        "Dr. Mr. Smith came by.",
        "Then left.",
      ]);
    });

    it("only matches the abbreviation as a whole word", () => {
      // "ladder." ends in "dr" but is not the abbreviation.
      expect(texts("He fell off the ladder. Then got up.")).toHaveLength(2);
      // "Elm St." merges; a sentence ending in "first." does not.
      expect(texts("We parked on Elm St. Then walked.")).toHaveLength(1);
      expect(texts("We came first. Then walked.")).toHaveLength(2);
    });

    it("never merges the last span and keeps spans trimmed and verbatim", () => {
      const text = "  Dr.   Patel was great.  See Dr.  ";
      const spans = segmentSentences(text);
      expect(spans.map((s) => text.slice(s.start, s.end))).toEqual([
        "Dr.   Patel was great.",
        "See Dr.",
      ]);
      for (const span of spans) {
        expect(span.start).toBeLessThan(span.end);
        expect(
          /^\S[\s\S]*\S$|^\S$/.test(text.slice(span.start, span.end)),
        ).toBe(true);
      }
    });

    it("Dr. no longer pushes a short review over the window threshold", () => {
      // Three sentences to a reader; four to the raw segmenter before #77.
      const text =
        "Dr. Patel did my implant. Zero pain after day two. Would recommend.";
      expect(segmentSentences(text)).toHaveLength(3);
      expect(chunkReview(text).filter((c) => c.kind === "window")).toEqual([]);
      expect(chunkReview(text, { sentenceChunks: false })).toEqual([
        { kind: "full", text, startOffset: 0 },
      ]);
    });

    it("windows never end in a bare honorific", () => {
      const text =
        "First visit was with Dr. Patel. She was gentle. Dr. Kim did my scan. " +
        "Carla booked the follow-up. Parking was easy. Five stars.";
      const chunks = chunkReview(text);
      expectVerbatim(text, chunks);
      for (const w of windows(chunks)) {
        expect(w.text).not.toMatch(/\bDr\.$/);
        expect(w.text).not.toMatch(/^(Patel|Kim)\b/);
      }
    });

    it("leaves CJK text with the ja locale unaffected", () => {
      const text = "こんにちは。元気ですか？はい。元気です。また来ます。";
      expect(texts(text, "ja")).toEqual([
        "こんにちは。",
        "元気ですか？",
        "はい。",
        "元気です。",
        "また来ます。",
      ]);
    });
  });
});

describe("assertVerbatimChunks", () => {
  const text = "Alpha. Beta. Gamma.";

  it("accepts real slices", () => {
    expect(() =>
      assertVerbatimChunks(text, [
        { kind: "full", text, startOffset: 0 },
        { kind: "window", text: "Beta.", startOffset: 7 },
      ]),
    ).not.toThrow();
  });

  it("rejects a wrong offset, altered text, an empty chunk, and a bad offset", () => {
    const cases: Chunk[] = [
      { kind: "window", text: "Beta.", startOffset: 6 },
      { kind: "window", text: "beta.", startOffset: 7 },
      { kind: "window", text: "", startOffset: 0 },
      { kind: "window", text: "Alpha.", startOffset: -1 },
      { kind: "window", text: "Alpha.", startOffset: 0.5 },
    ];
    for (const chunk of cases) {
      expect(() => assertVerbatimChunks(text, [chunk])).toThrow(
        ChunkInvariantError,
      );
    }
  });
});
