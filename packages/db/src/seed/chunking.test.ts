import { describe, expect, it } from "vitest";

import { isVerbatimSlice } from "../chunks.js";
import { chunkReviewText, splitSentences } from "./chunking.js";

const FIVE =
  "Dr. Patel did my implant and I honestly forgot it wasn't my own tooth within a week. " +
  "The front desk explained every charge before I paid. " +
  "Parking behind the building was easy — the garage on Elm St. is a trap, don't use it. " +
  "Tasha, the hygienist, was gentle with my sensitive gums. " +
  "Would I go back? Absolutely.";

describe("splitSentences", () => {
  it("returns trimmed spans whose offsets point into the text", () => {
    const text = "  First one.   Second one!  Third?  ";
    const spans = splitSentences(text);
    expect(spans.map((s) => s.text)).toEqual([
      "First one.",
      "Second one!",
      "Third?",
    ]);
    for (const span of spans) {
      expect(
        text.slice(span.startOffset, span.startOffset + span.text.length),
      ).toBe(span.text);
    }
  });

  it("does not split after honorifics like Dr. or St.", () => {
    const spans = splitSentences(FIVE);
    expect(spans).toHaveLength(6); // "Would I go back?" and "Absolutely." are two.
    expect(spans[0]?.text).toMatch(/^Dr\. Patel did my implant/);
    expect(spans[2]?.text).toMatch(/Elm St\. is a trap, don't use it\.$/);
  });

  it("counts UTF-16 code units, like String.prototype.slice", () => {
    const text = "Loved it 😀. Came back twice. Will return.";
    const spans = splitSentences(text);
    expect(spans.map((s) => s.text)).toEqual([
      "Loved it 😀.",
      "Came back twice.",
      "Will return.",
    ]);
    expect(spans[1]?.startOffset).toBe("Loved it 😀. ".length);
  });
});

describe("chunkReviewText", () => {
  it("gives a short review only its full chunk", () => {
    const text = "Quick cleaning, no upsell. In and out in forty minutes.";
    expect(chunkReviewText(text)).toEqual([
      { kind: "full", text, startOffset: 0 },
    ]);
  });

  it("gives a three-sentence review only its full chunk (threshold is > 3)", () => {
    const text = "Great hygienist. Fair prices. Easy parking.";
    expect(chunkReviewText(text).map((c) => c.kind)).toEqual(["full"]);
  });

  it("adds 2–3 sentence windows overlapping by one for longer reviews", () => {
    const chunks = chunkReviewText(FIVE);
    const windows = chunks.filter((c) => c.kind === "window");
    expect(chunks[0]).toEqual({ kind: "full", text: FIVE, startOffset: 0 });
    // 6 sentences → [0,1,2] [2,3,4] [4,5]
    expect(windows).toHaveLength(3);
    expect(windows[0]?.text).toMatch(/^Dr\. Patel .* don't use it\.$/);
    expect(windows[1]?.text).toMatch(/^Parking behind .* Would I go back\?$/);
    expect(windows[2]?.text).toBe("Would I go back? Absolutely.");
    // Overlap: each window starts with the previous window's last sentence.
    expect(windows[1]?.text.startsWith("Parking behind the building")).toBe(
      true,
    );
    expect(windows[0]?.text.endsWith("don't use it.")).toBe(true);
  });

  it("never ends with a one-sentence window", () => {
    const four = "One here. Two here. Three here. Four here.";
    const windows = chunkReviewText(four).filter((c) => c.kind === "window");
    expect(windows.map((w) => w.text)).toEqual([
      "One here. Two here. Three here.",
      "Three here. Four here.",
    ]);
  });

  it("produces only verbatim slices", () => {
    for (const chunk of chunkReviewText(FIVE)) {
      expect(isVerbatimSlice({ text: FIVE }, chunk)).toBe(true);
    }
  });

  it("rejects empty text", () => {
    expect(() => chunkReviewText("   ")).toThrow(/empty/);
  });
});
