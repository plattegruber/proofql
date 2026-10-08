import { describe, expect, it } from "vitest";

import {
  BUSINESS_CATEGORIES,
  CATEGORY_TABLE,
  categoryFromGoogleType,
  genericQueryWords,
  isBusinessCategory,
  UNIVERSAL_GENERIC_WORDS,
} from "./categories.js";

const words = (category: string | null | undefined) =>
  genericQueryWords(category).split(" ");

describe("genericQueryWords (#151)", () => {
  it("keeps every word of the #147 dental list for a dental project", () => {
    // The demo project's measured numbers (docs/performance.md §5) rest on
    // these five; the issue requires the dental behaviour to hold.
    for (const word of ["dental", "dentist", "teeth", "review", "office"]) {
      expect(words("dental")).toContain(word);
    }
  });

  it("is the universal list plus the category's own words", () => {
    expect(words("dental")).toEqual([
      "review",
      "reviews",
      "company",
      "service",
      "business",
      "office",
      "team",
      "dental",
      "dentist",
      "teeth",
    ]);
    expect(words("roofing")).toEqual([
      ...UNIVERSAL_GENERIC_WORDS,
      "roof",
      "roofing",
      "roofer",
      "roofers",
      "contractor",
    ]);
  });

  it("falls back to the universal list when the category is unset or unknown", () => {
    expect(words(null)).toEqual([...UNIVERSAL_GENERIC_WORDS]);
    expect(words(undefined)).toEqual([...UNIVERSAL_GENERIC_WORDS]);
    expect(words("")).toEqual([...UNIVERSAL_GENERIC_WORDS]);
    expect(words("spaceport")).toEqual([...UNIVERSAL_GENERIC_WORDS]);
    // Not an own key of the table: prototype names are not categories.
    expect(words("constructor")).toEqual([...UNIVERSAL_GENERIC_WORDS]);
  });

  it("never repeats a word", () => {
    for (const category of BUSINESS_CATEGORIES) {
      const list = words(category);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("does not treat a roofer's category words as generic for a dentist", () => {
    expect(words("dental")).not.toContain("roof");
    expect(words("roofing")).not.toContain("dentist");
  });
});

describe("the category table", () => {
  it("covers the common local-business categories", () => {
    expect(BUSINESS_CATEGORIES).toEqual(
      expect.arrayContaining([
        "dental",
        "roofing",
        "plumbing",
        "hvac",
        "legal",
        "medical",
        "salon",
        "restaurant",
        "auto_repair",
        "remodeling",
        "real_estate",
        "veterinary",
        "fitness",
      ]),
    );
  });

  it.each(BUSINESS_CATEGORIES)("%s is well formed", (category) => {
    const entry = CATEGORY_TABLE[category];
    expect(category).toMatch(/^[a-z][a-z_]*$/);
    expect(entry.label.trim()).not.toBe("");
    expect(entry.words.length).toBeGreaterThan(0);
    for (const word of entry.words) {
      // One lowercase token each: the SQL stems a space-separated list.
      expect(word).toMatch(/^\p{Ll}+$/u);
      // The universal list already applies everywhere.
      expect(UNIVERSAL_GENERIC_WORDS).not.toContain(word);
    }
    expect(new Set(entry.words).size).toBe(entry.words.length);
    expect(entry.googleTypes.length).toBeGreaterThan(0);
    for (const type of entry.googleTypes) {
      expect(type).toMatch(/^[a-z][a-z_]*$/);
    }
  });

  it("maps each Google type to exactly one category", () => {
    const seen = new Map<string, string>();
    for (const category of BUSINESS_CATEGORIES) {
      for (const type of CATEGORY_TABLE[category].googleTypes) {
        expect(seen.get(type), type).toBeUndefined();
        seen.set(type, category);
        expect(categoryFromGoogleType(type)).toBe(category);
      }
    }
  });

  it("keeps the universal list lowercase and short", () => {
    for (const word of UNIVERSAL_GENERIC_WORDS) {
      expect(word).toMatch(/^[a-z]+$/);
    }
    expect(UNIVERSAL_GENERIC_WORDS.length).toBeLessThanOrEqual(10);
  });

  it("recognises its own keys only", () => {
    expect(isBusinessCategory("roofing")).toBe(true);
    expect(isBusinessCategory("Roofing")).toBe(false);
    expect(isBusinessCategory("roofing_contractor")).toBe(false);
    expect(isBusinessCategory("toString")).toBe(false);
    expect(isBusinessCategory(null)).toBe(false);
    expect(isBusinessCategory(3)).toBe(false);
  });
});

describe("categoryFromGoogleType", () => {
  it("reads a Places primaryType", () => {
    expect(categoryFromGoogleType("dentist")).toBe("dental");
    expect(categoryFromGoogleType("roofing_contractor")).toBe("roofing");
    expect(categoryFromGoogleType("general_contractor")).toBe("remodeling");
    expect(categoryFromGoogleType("veterinary_care")).toBe("veterinary");
    expect(categoryFromGoogleType("car_repair")).toBe("auto_repair");
  });

  it("reads a Business Profile category name", () => {
    expect(categoryFromGoogleType("categories/gcid:roofing_contractor")).toBe(
      "roofing",
    );
    expect(categoryFromGoogleType("gcid:dentist")).toBe("dental");
    expect(categoryFromGoogleType("gcid:hvac_contractor")).toBe("hvac");
  });

  it("maps every *_restaurant type to restaurant", () => {
    expect(categoryFromGoogleType("italian_restaurant")).toBe("restaurant");
    expect(categoryFromGoogleType("fast_food_restaurant")).toBe("restaurant");
  });

  it("ignores case and surrounding whitespace", () => {
    expect(categoryFromGoogleType("  Roofing_Contractor ")).toBe("roofing");
  });

  it("is null for a type the table does not know, or none", () => {
    expect(categoryFromGoogleType("tourist_attraction")).toBeNull();
    expect(categoryFromGoogleType("")).toBeNull();
    expect(categoryFromGoogleType(null)).toBeNull();
    expect(categoryFromGoogleType(undefined)).toBeNull();
  });
});
