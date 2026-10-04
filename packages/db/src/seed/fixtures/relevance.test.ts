/**
 * The relevance fixtures (#138) reference the corpus in ./reviews.ts by
 * key; pin that every reference resolves and that the labels agree with
 * the default publication policy (min_rating 4, negative unrated hidden),
 * so a corpus edit cannot silently orphan a label.
 */

import { describe, expect, it } from "vitest";

import { RELEVANCE_QUERIES, type RelevanceQuery } from "./relevance.js";
import { DEMO_LIVE_REVIEWS } from "./reviews.js";

const byKey = new Map(DEMO_LIVE_REVIEWS.map((f) => [f.key, f]));

/** The default policy: rated 4+ or unrated and not negative. */
function publishable(key: string): boolean {
  const fixture = byKey.get(key);
  if (fixture === undefined) throw new Error(`unknown review key ${key}`);
  return fixture.rating === null
    ? fixture.sentiment !== "negative"
    : fixture.rating >= 4;
}

function ofKind(kind: RelevanceQuery["kind"]) {
  return RELEVANCE_QUERIES.filter((q) => q.kind === kind);
}

describe("relevance fixtures", () => {
  it("has ~30 positives and ~15 in-domain queries that must return nothing", () => {
    expect(ofKind("positive").length).toBeGreaterThanOrEqual(30);
    expect(
      ofKind("negative").length + ofKind("policy-filtered").length,
    ).toBeGreaterThanOrEqual(15);
    expect(ofKind("policy-filtered").length).toBeGreaterThanOrEqual(3);
  });

  it("has unique ids and non-empty queries", () => {
    const ids = RELEVANCE_QUERIES.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const q of RELEVANCE_QUERIES) {
      expect(q.q.trim(), q.id).not.toBe("");
      expect(q.id, q.id).toMatch(
        q.kind === "positive"
          ? /^p\d\d$/
          : q.kind === "negative"
            ? /^n\d\d$/
            : /^f\d\d$/,
      );
    }
  });

  it("references only live review keys that exist", () => {
    for (const q of RELEVANCE_QUERIES) {
      for (const key of [...q.expect, ...(q.acceptable ?? [])]) {
        expect(byKey.has(key), `${q.id} references unknown review ${key}`).toBe(
          true,
        );
      }
    }
  });

  it("never lists a review as both expected and acceptable", () => {
    for (const q of RELEVANCE_QUERIES) {
      const expected = new Set(q.expect);
      for (const key of q.acceptable ?? []) {
        expect(expected.has(key), `${q.id}: ${key} in both lists`).toBe(false);
      }
      expect(new Set(q.expect).size, `${q.id} repeats a key`).toBe(
        q.expect.length,
      );
    }
  });

  it("expects only publishable reviews for positives", () => {
    for (const q of ofKind("positive")) {
      expect(q.expect.length, `${q.id} expects nothing`).toBeGreaterThan(0);
      for (const key of [...q.expect, ...(q.acceptable ?? [])]) {
        expect(publishable(key), `${q.id}: ${key} is hidden by policy`).toBe(
          true,
        );
      }
    }
  });

  it("expects nothing for negatives", () => {
    for (const q of ofKind("negative")) {
      expect(q.expect).toEqual([]);
      expect(q.acceptable ?? []).toEqual([]);
    }
  });

  it("names only policy-hidden reviews for policy-filtered queries", () => {
    for (const q of ofKind("policy-filtered")) {
      expect(q.expect.length, `${q.id} names no hidden review`).toBeGreaterThan(
        0,
      );
      for (const key of q.expect) {
        expect(publishable(key), `${q.id}: ${key} is publishable`).toBe(false);
      }
    }
  });

  it("includes paraphrases that share no content word with their answers", () => {
    const paraphrases = RELEVANCE_QUERIES.filter((q) =>
      q.tags?.includes("paraphrase"),
    );
    expect(paraphrases.length).toBeGreaterThanOrEqual(5);
    // At least one paraphrase has an expected review with zero shared
    // content words — the case the fake embedder cannot score and the
    // reason the floor is tuned on real embeddings.
    const words = (text: string) =>
      new Set(
        (text.toLowerCase().match(/[\p{L}']+/gu) ?? []).filter(
          (w) => w.length > 3,
        ),
      );
    const disjoint = paraphrases.some((q) => {
      const qw = words(q.q);
      return q.expect.some((key) => {
        const rw = words(byKey.get(key)?.text ?? "");
        return [...qw].every((w) => !rw.has(w));
      });
    });
    expect(disjoint).toBe(true);
  });
});
