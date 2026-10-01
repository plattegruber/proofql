import { describe, expect, it } from "vitest";

import {
  assertVerbatimChunks,
  type Chunk,
  ChunkInvariantError,
  chunkReview,
  DEFAULT_CHUNK_OPTIONS,
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

function sentences(n: number): string {
  return Array.from({ length: n }, (_, i) => `Sentence ${i + 1}.`).join(" ");
}

describe("chunkReview", () => {
  it("emits only the full chunk for a short review", () => {
    const text = "Great service. Would recommend. Five stars.";
    const chunks = chunkReview(text);

    expect(chunks).toEqual([{ kind: "full", text, startOffset: 0 }]);
    expectVerbatim(text, chunks);
  });

  it("emits the full chunk first, as the whole text at offset 0", () => {
    const text = sentences(7);
    const [full] = chunkReview(text);

    expect(full).toEqual({ kind: "full", text, startOffset: 0 });
  });

  it("four sentences → full + two windows with correct offsets", () => {
    const text = "One. Two! Three? Four.";
    const chunks = chunkReview(text);

    expect(chunks).toEqual([
      { kind: "full", text, startOffset: 0 },
      { kind: "window", text: "One. Two! Three?", startOffset: 0 },
      { kind: "window", text: "Three? Four.", startOffset: 10 },
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

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("full");
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
      // Windows are in text order and never empty.
      const offsets = windows(chunks).map((c) => c.startOffset);
      expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    }
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
