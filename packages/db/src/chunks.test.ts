import { describe, expect, it } from "vitest";

import {
  assertVerbatimSlice,
  isVerbatimSlice,
  VerbatimSliceError,
} from "./chunks.js";

const review = {
  text: "Dr. Patel did my implant. I forgot it wasn't my own tooth within a week. Parking was easy.",
};

describe("isVerbatimSlice", () => {
  it("accepts the full text at offset 0", () => {
    expect(isVerbatimSlice(review, { text: review.text, startOffset: 0 })).toBe(
      true,
    );
  });

  it("accepts an interior window at its real offset", () => {
    const text = "I forgot it wasn't my own tooth within a week.";
    const startOffset = review.text.indexOf(text);
    expect(isVerbatimSlice(review, { text, startOffset })).toBe(true);
  });

  it("rejects a slice at the wrong offset", () => {
    expect(
      isVerbatimSlice(review, { text: "Parking was easy.", startOffset: 0 }),
    ).toBe(false);
  });

  it("rejects text that is not in the review at all (a fabricated quote)", () => {
    expect(
      isVerbatimSlice(review, {
        text: "Dr. Patel is the best dentist in town.",
        startOffset: 0,
      }),
    ).toBe(false);
  });

  it("rejects a slice that differs by one character", () => {
    expect(
      isVerbatimSlice(review, {
        text: "Dr. Patel did my implant!",
        startOffset: 0,
      }),
    ).toBe(false);
  });

  it("rejects a slice that runs past the end of the review", () => {
    expect(
      isVerbatimSlice(review, {
        text: "Parking was easy. Would recommend.",
        startOffset: review.text.indexOf("Parking"),
      }),
    ).toBe(false);
  });

  it("rejects empty chunks, negative and fractional offsets", () => {
    expect(isVerbatimSlice(review, { text: "", startOffset: 0 })).toBe(false);
    expect(isVerbatimSlice(review, { text: "Dr.", startOffset: -1 })).toBe(
      false,
    );
    expect(isVerbatimSlice(review, { text: "Dr.", startOffset: 0.5 })).toBe(
      false,
    );
  });

  it("counts offsets in UTF-16 code units, like String.prototype.slice", () => {
    const emoji = { text: "Great 😀 service." };
    const text = "service.";
    const startOffset = emoji.text.indexOf(text); // 9, not 8
    expect(startOffset).toBe(9);
    expect(isVerbatimSlice(emoji, { text, startOffset })).toBe(true);
    expect(isVerbatimSlice(emoji, { text, startOffset: 8 })).toBe(false);
  });
});

describe("assertVerbatimSlice", () => {
  const parkingOffset = review.text.indexOf("Parking was easy.");

  it("returns silently for a verbatim slice", () => {
    expect(() =>
      assertVerbatimSlice(review, {
        text: "Parking was easy.",
        startOffset: parkingOffset,
      }),
    ).not.toThrow();
  });

  it("throws VerbatimSliceError naming the offset for a non-slice", () => {
    const chunk = { text: "Parking was free.", startOffset: parkingOffset };
    expect(() => assertVerbatimSlice(review, chunk)).toThrow(
      VerbatimSliceError,
    );
    try {
      assertVerbatimSlice(review, chunk);
    } catch (error) {
      const e = error as VerbatimSliceError;
      expect(e.message).toContain(`offset ${parkingOffset}`);
      expect(e.message).toContain('"Parking was easy."');
      expect(e.chunk).toBe(chunk);
    }
  });
});
