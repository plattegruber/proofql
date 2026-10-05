import { describe, expect, it } from "vitest";

import {
  DEFAULT_SIMILARITY_FLOOR,
  GENERIC_TERM_DOC_SHARE,
  GENERIC_TERMS_MAX,
  GENERIC_TERMS_MIN_REVIEWS,
  genericTermsFloor,
  LEXICAL_FLOOR_OFFSET,
  LEXICAL_RULE,
  LEXICAL_RULES,
  lexicalFloorFor,
  selectGenericTerms,
  UNIVERSAL_GENERIC_WORDS,
} from "./relevance.js";

describe("relevance floors", () => {
  it("defaults to the measured 0.66 with a 0.53 lexical tier", () => {
    expect(DEFAULT_SIMILARITY_FLOOR).toBe(0.66);
    expect(LEXICAL_FLOOR_OFFSET).toBe(0.13);
    expect(lexicalFloorFor(DEFAULT_SIMILARITY_FLOOR)).toBe(0.53);
  });

  it("follows the project's floor without float noise and never goes negative", () => {
    expect(lexicalFloorFor(0.7)).toBe(0.57);
    expect(lexicalFloorFor(0.3)).toBe(0.17);
    expect(lexicalFloorFor(0.1)).toBe(0);
  });
});

describe("lexical rule (#147)", () => {
  it("is the measured partial-match rule with the universal generic words", () => {
    expect(LEXICAL_RULES).toContain(LEXICAL_RULE);
    expect(LEXICAL_RULE).toBe("half-specific");
    expect(UNIVERSAL_GENERIC_WORDS.split(" ")).toEqual([
      "review",
      "place",
      "service",
      "experience",
    ]);
  });
});

describe("per-project generic terms (#149)", () => {
  it("uses a quarter of the reviews from 30 reviews up, nothing below", () => {
    expect(GENERIC_TERM_DOC_SHARE).toBe(0.25);
    expect(GENERIC_TERMS_MIN_REVIEWS).toBe(30);
    expect(genericTermsFloor(0)).toBeNull();
    expect(genericTermsFloor(29)).toBeNull();
    expect(genericTermsFloor(30)).toBe(7.5);
    expect(genericTermsFloor(40)).toBe(10);
    expect(genericTermsFloor(80)).toBe(20);
    expect(genericTermsFloor(Number.NaN)).toBeNull();
  });

  it("keeps lexemes strictly above the cut", () => {
    const stats = [
      { word: "coffe", ndoc: 34 },
      { word: "cake", ndoc: 11 },
      { word: "tea", ndoc: 10 },
      { word: "scone", ndoc: 3 },
    ];
    // 40 reviews: the cut is 10, so "tea" in exactly a quarter is not generic.
    expect(selectGenericTerms(stats, 40)).toEqual(["cake", "coffe"]);
    // 30 reviews: 7.5, an odd count's half-review rounds nobody in.
    expect(selectGenericTerms(stats, 30)).toEqual(["cake", "coffe", "tea"]);
  });

  it("returns nothing below the minimum, however common a word is", () => {
    expect(selectGenericTerms([{ word: "coffe", ndoc: 29 }], 29)).toEqual([]);
  });

  it("caps at the most frequent terms and returns them sorted", () => {
    const stats = Array.from({ length: GENERIC_TERMS_MAX + 5 }, (_, i) => ({
      word: `w${String(i).padStart(2, "0")}`,
      ndoc: 100 - i,
    }));
    const terms = selectGenericTerms(stats, 100);
    expect(terms).toHaveLength(GENERIC_TERMS_MAX);
    expect(terms).toEqual([...terms].sort());
    expect(terms).not.toContain("w30");
    expect(terms).toContain("w29");
  });

  it("breaks frequency ties at the cap by word, deterministically", () => {
    const stats = Array.from({ length: GENERIC_TERMS_MAX + 1 }, (_, i) => ({
      word: String.fromCharCode(122 - i),
      ndoc: 50,
    }));
    const terms = selectGenericTerms(stats, 100);
    expect(terms).toHaveLength(GENERIC_TERMS_MAX);
    expect(terms).not.toContain("z");
  });
});
