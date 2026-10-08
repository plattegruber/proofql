/**
 * Five reviews for a fictional bike shop, each about one thing, with no
 * vocabulary in common, so real embeddings (bge-m3 on Workers AI) and the
 * local bag-of-words fake agree on what matches what.
 *
 * The target review has four sentences, so the pipeline also indexes each
 * sentence on its own (packages/core chunking.ts): a query about one of
 * them must come back as that sentence, with a `highlight` span inside the
 * whole text rather than the whole review.
 */
import type { IngestReview } from "./api";

export const TARGET_INDEX = 0;
/** The sentence the query should land on (and the snippet should mark). */
export const TARGET_SENTENCE =
  "The mechanic trued my warped rear wheel and replaced two broken spokes while I waited.";
export const TARGET_QUERY = "trued a warped rear wheel and replaced spokes";
/** A word only the target sentence contains, for loose UI assertions. */
export const TARGET_MARKER = "warped rear wheel";

const TEXTS: { rating: number; text: string; author: string }[] = [
  {
    rating: 5,
    text: `Dropped my commuter off on a Tuesday morning. ${TARGET_SENTENCE} They also oiled the chain without being asked. Friendly people all round.`,
    author: "Acceptance Rider One",
  },
  {
    rating: 5,
    text: "Plenty of free parking right behind the building, even on a Saturday afternoon.",
    author: "Acceptance Rider Two",
  },
  {
    rating: 4,
    text: "The quote was itemised in writing and the invoice matched it to the cent.",
    author: "Acceptance Rider Three",
  },
  {
    rating: 5,
    text: "Their kids' balance bikes come in bright colours and my daughter learned in one weekend.",
    author: "Acceptance Rider Four",
  },
  {
    rating: 5,
    text: "Espresso machine in the waiting area makes a surprisingly good flat white.",
    author: "Acceptance Rider Five",
  },
];

export function acceptanceReviews(runId: string): IngestReview[] {
  const now = Date.now();
  return TEXTS.map((r, i) => ({
    external_id: `at-${runId}-${i + 1}`,
    source: "custom",
    rating: r.rating,
    text: r.text,
    author_name: r.author,
    occurred_at: new Date(now - (i + 1) * 60_000).toISOString(),
    metadata: { acceptance_run: runId },
  }));
}
