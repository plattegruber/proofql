/**
 * The word-match rules (#147) against Postgres's English text search, so
 * stemming and stop words are the corpus's own.
 */

import { LEXICAL_RULES } from "@proofql/core";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { setupTestDb } from "../../test/harness.js";
import { genericLexemesFor, lexicalMatchSql } from "./lexicalMatch.js";

/** A dental project's derived terms, as `ts_stat` lexemes (#149). */
const DENTAL_TERMS = ["dental", "dentist", "offic", "teeth"];

describe("lexicalMatchSql", () => {
  const t = setupTestDb();

  async function matches(chunk: string, q: string, terms = DENTAL_TERMS) {
    const out: Record<string, boolean> = {};
    for (const rule of LEXICAL_RULES) {
      const tsv = sql`to_tsvector('english', ${chunk})`;
      const [row] = await t.db.execute<{ m: boolean }>(
        sql`SELECT ${lexicalMatchSql(tsv, q, rule, genericLexemesFor(terms))} AS m`,
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

  it("the universal words are generic in every project, stemmed", async () => {
    // "experience" → `experi`; no project terms at all.
    expect(
      await matches("A calm experience overall.", "experience parking", []),
    ).toMatchObject({ half: true, "half-specific": false });
  });

  it("a word is only generic in the project whose terms say so", async () => {
    // A cafe's "coffee" is filler; for a dental project it is a topic.
    const chunk = "Coffee in the waiting room.";
    expect(await matches(chunk, "coffee cake", ["coffe"])).toMatchObject({
      "half-specific": false,
    });
    expect(await matches(chunk, "coffee cake")).toMatchObject({
      "half-specific": true,
    });
  });
});
