/**
 * The word-match rules (#147) against Postgres's English text search, so
 * stemming and stop words are the corpus's own.
 */

import { genericQueryWords, LEXICAL_RULES } from "@proofql/core";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { setupTestDb } from "../../test/harness.js";
import { lexicalMatchSql } from "./lexicalMatch.js";

describe("lexicalMatchSql", () => {
  const t = setupTestDb();

  async function matches(chunk: string, q: string, category = "dental") {
    const out: Record<string, boolean> = {};
    for (const rule of LEXICAL_RULES) {
      const tsv = sql`to_tsvector('english', ${chunk})`;
      const words = genericQueryWords(category);
      const [row] = await t.db.execute<{ m: boolean }>(
        sql`SELECT ${lexicalMatchSql(tsv, q, rule, words)} AS m`,
      );
      out[rule] = row?.m as boolean;
    }
    return out;
  }

  it("every term: all rules match", async () => {
    expect(await matches("Veneers look natural.", "veneers")).toEqual({
      all: true,
      any: true,
      half: true,
      "half-specific": true,
    });
  });

  it("one specific word of two: partial rules match, `all` does not", async () => {
    expect(await matches("My implant feels real.", "dental implants")).toEqual({
      all: false,
      any: true,
      half: true,
      "half-specific": true,
    });
  });

  it("only a generic word shared: `half-specific` does not match", async () => {
    expect(
      await matches("The dental team was great.", "dental implants"),
    ).toEqual({ all: false, any: true, half: true, "half-specific": false });
  });

  it("one word of several: `half` and `half-specific` need half", async () => {
    expect(
      await matches(
        "Plenty of parking downtown.",
        "parking near the station entrance",
      ),
    ).toEqual({ all: false, any: true, half: false, "half-specific": false });
  });

  it("a query of generic words only gets no partial credit", async () => {
    expect(await matches("Our dentist is kind.", "dentist office")).toEqual({
      all: false,
      any: true,
      half: true,
      "half-specific": false,
    });
  });

  it("stop words and stemming follow the corpus config", async () => {
    // "the", "for" are stop words; "extractions" stems to "extract".
    expect(
      await matches("Two extractions, no pain.", "extraction for the kids"),
    ).toMatchObject({ half: true, "half-specific": true });
  });

  describe("generic words follow the project's category (#151)", () => {
    const halfSpecific = async (chunk: string, q: string, category: string) =>
      (await matches(chunk, q, category))["half-specific"];

    it("a roofer: the category word alone is no evidence", async () => {
      // "roof" is in the review; "repair" is not.
      expect(
        await halfSpecific(
          "They replaced our roof in two days.",
          "roof repair company",
          "roofing",
        ),
      ).toBe(false);
      // Without the category, "roof" counts and 1 of 2 content words is half.
      expect(
        await halfSpecific(
          "They replaced our roof in two days.",
          "roof repair company",
          "",
        ),
      ).toBe(true);
    });

    it("a roofer: a specific word still matches", async () => {
      expect(
        await halfSpecific(
          "Quick repair after the storm.",
          "roof repair company",
          "roofing",
        ),
      ).toBe(true);
    });

    it("stemming covers the category's word forms", async () => {
      // "roofing" stems to `roof`, "roofers" to `roofer`: all generic.
      expect(
        await halfSpecific(
          "Best roofers in town, the roof looks great.",
          "roofing reviews",
          "roofing",
        ),
      ).toBe(false);
    });

    it("a dentist's words are not generic for a roofer", async () => {
      expect(
        await halfSpecific(
          "The dental team was great.",
          "dental implants",
          "roofing",
        ),
      ).toBe(true);
      expect(
        await halfSpecific(
          "The dental team was great.",
          "dental implants",
          "dental",
        ),
      ).toBe(false);
    });

    it("universal words are generic everywhere, even with no category", async () => {
      // One of two words: `half` would match; both are generic, so no
      // partial credit (the chunk lacks "team", so no every-term match).
      expect(
        await matches("Great service, as always.", "service team", ""),
      ).toMatchObject({ all: false, half: true, "half-specific": false });
    });
  });
});
