/**
 * Pure side of the guided onboarding (#53): the step list and its paths,
 * the suggested first query derived from a project's chunks, the snippet
 * tag prefilled with a real key, the hosted-demo link, and the ready-to-run
 * ingest curl. No I/O, so every rule is unit-tested (onboarding.test.ts)
 * and the module is safe in the browser bundle.
 */
import { SNIPPET_DEFAULT_API } from "./playground";

// --- Steps and paths ---------------------------------------------------------

export const ONBOARDING_PATH = "/app/onboarding";

export type OnboardingStep = "project" | "reviews" | "indexing" | "snippet";

export const ONBOARDING_STEPS: readonly {
  id: OnboardingStep;
  label: string;
}[] = [
  { id: "project", label: "Name your project" },
  { id: "reviews", label: "Add your reviews" },
  { id: "indexing", label: "Indexing" },
  { id: "snippet", label: "Your snippet" },
];

export function onboardingStepNumber(step: OnboardingStep): number {
  return ONBOARDING_STEPS.findIndex((s) => s.id === step) + 1;
}

/** `/app/onboarding` for step 1; `/app/onboarding/<slug>/<step>` after. */
export function onboardingPath(
  step: Exclude<OnboardingStep, "project">,
  slug: string,
  query?: Record<string, string>,
): string {
  const search = query ? `?${new URLSearchParams(query)}` : "";
  return `${ONBOARDING_PATH}/${slug}/${step}${search}`;
}

/** The two resource routes under a step-2+ slug: the iframe page and the counts. */
export function onboardingResourcePath(
  resource: "preview" | "status",
  slug: string,
): string {
  return `${ONBOARDING_PATH}/${slug}/${resource}`;
}

/** The query-string flag the import wizard carries back into onboarding. */
export const ONBOARDING_FLAG = "onboarding";

// --- Suggested first query ---------------------------------------------------

/**
 * Words that carry no topic. English function words (a superset of the
 * fake embedder's list in packages/ai, which is not exported — it is a test
 * double), honorifics, and the adjectives and verbs that appear in almost
 * every review of anything ("great", "recommend", "staff"). A heuristic,
 * not a tokenizer: the goal is that the two most frequent words left are a
 * query worth suggesting, like "implant" or "parking".
 */
export const QUERY_STOP_WORDS: ReadonlySet<string> = new Set([
  // function words
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "aren't",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "can't",
  "cannot",
  "could",
  "couldn't",
  "did",
  "didn't",
  "do",
  "does",
  "doesn't",
  "doing",
  "don't",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "hadn't",
  "has",
  "hasn't",
  "have",
  "haven't",
  "having",
  "he",
  "he'd",
  "he'll",
  "he's",
  "her",
  "here",
  "here's",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "how's",
  "i",
  "i'd",
  "i'll",
  "i'm",
  "i've",
  "if",
  "in",
  "into",
  "is",
  "isn't",
  "it",
  "it's",
  "its",
  "itself",
  "let's",
  "me",
  "more",
  "most",
  "mustn't",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "ought",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "same",
  "shan't",
  "she",
  "she'd",
  "she'll",
  "she's",
  "should",
  "shouldn't",
  "so",
  "some",
  "such",
  "than",
  "that",
  "that's",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "there's",
  "these",
  "they",
  "they'd",
  "they'll",
  "they're",
  "they've",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "wasn't",
  "we",
  "we'd",
  "we'll",
  "we're",
  "we've",
  "were",
  "weren't",
  "what",
  "what's",
  "when",
  "when's",
  "where",
  "where's",
  "which",
  "while",
  "who",
  "who's",
  "whom",
  "why",
  "why's",
  "with",
  "won't",
  "would",
  "wouldn't",
  "you",
  "you'd",
  "you'll",
  "you're",
  "you've",
  "your",
  "yours",
  "yourself",
  "yourselves",
  // contractions split by the tokenizer
  "s",
  "t",
  "d",
  "ll",
  "m",
  "re",
  "ve",
  "im",
  "ive",
  "dont",
  "didnt",
  // honorifics and quantities
  "dr",
  "mr",
  "mrs",
  "ms",
  "one",
  "two",
  "three",
  "first",
  "second",
  // words every review of anything contains
  "always",
  "also",
  "amazing",
  "awesome",
  "back",
  "best",
  "better",
  "came",
  "come",
  "day",
  "definitely",
  "even",
  "ever",
  "every",
  "everyone",
  "everything",
  "excellent",
  "experience",
  "feel",
  "felt",
  "friendly",
  "get",
  "got",
  "give",
  "gave",
  "go",
  "going",
  "good",
  "great",
  "highly",
  "just",
  "know",
  "like",
  "little",
  "long",
  "lot",
  "made",
  "make",
  "much",
  "never",
  "new",
  "nice",
  "now",
  "office",
  "people",
  "place",
  "really",
  "recommend",
  "recommended",
  "said",
  "say",
  "see",
  "since",
  "someone",
  "something",
  "staff",
  "still",
  "take",
  "team",
  "thank",
  "thanks",
  "thing",
  "things",
  "think",
  "time",
  "told",
  "took",
  "way",
  "well",
  "went",
  "wonderful",
  "year",
  "years",
  // evaluative filler that is not a topic
  "appreciate",
  "appreciated",
  "overall",
  "honestly",
  "remember",
  "remembered",
  "explained",
  "explain",
  "turned",
  "none",
  "clear",
  "nervous",
  "pressure",
  "forgot",
  "week",
  "weeks",
  "month",
  "months",
  "morning",
  "afternoon",
  "asking",
  "asked",
  "ask",
  "visit",
  "visits",
  "coming",
  "left",
  "right",
  "same",
  "step",
  "fixed",
  "problem",
  "issue",
  "surprises",
  "starting",
  "within",
  "last",
  "next",
  "today",
  "yesterday",
]);

const TOKEN_PATTERN = /[\p{L}\p{N}']+/gu;

/** Lowercase content words of one text, in order, duplicates kept. */
export function contentWords(
  text: string,
  stopWords: ReadonlySet<string> = QUERY_STOP_WORDS,
): string[] {
  const tokens = text.toLowerCase().match(TOKEN_PATTERN) ?? [];
  const words: string[] = [];
  for (const raw of tokens) {
    const token = raw.replace(/^'+|'+$/g, "").replace(/'s$/, "");
    if (token.length < 3) continue;
    if (/^\d+$/.test(token)) continue;
    if (stopWords.has(token)) continue;
    words.push(token);
  }
  return words;
}

/**
 * The two content words that best describe a corpus, as a query.
 *
 * The first is the word found in the most texts (ties: most occurrences,
 * then the longer word). The second is the word
 * that most often shares a text with it — so the pair is a topic
 * ("implant" + "patel"), not two unrelated frequent words — falling back to
 * the second most frequent word overall when nothing co-occurs twice. The
 * pair keeps the order they usually appear in. Null when no text has a
 * content word; a single word when there is only one.
 */
export function suggestQueryFromTexts(
  texts: readonly string[],
  stopWords: ReadonlySet<string> = QUERY_STOP_WORDS,
): string | null {
  const docs = texts
    .map((t) => contentWords(t, stopWords))
    .filter((w) => w.length > 0);
  if (docs.length === 0) return null;

  const df = new Map<string, number>();
  const tf = new Map<string, number>();
  for (const words of docs) {
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    for (const w of new Set(words)) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const first = top(df, tf);
  if (first === undefined) return null;

  const withFirst = docs.filter((w) => w.includes(first));
  const co = new Map<string, number>();
  for (const words of withFirst) {
    for (const w of new Set(words)) {
      if (w !== first) co.set(w, (co.get(w) ?? 0) + 1);
    }
  }
  let second = top(co, tf);
  if (second === undefined || (co.get(second) ?? 0) < 2) {
    const rest = new Map(df);
    rest.delete(first);
    second = top(rest, tf);
  }
  if (second === undefined) return first;

  // Keep the order the pair usually appears in.
  let firstLeads = 0;
  for (const words of docs) {
    const a = words.indexOf(first);
    const b = words.indexOf(second);
    if (a === -1 || b === -1) continue;
    firstLeads += a < b ? 1 : -1;
  }
  return firstLeads >= 0 ? `${first} ${second}` : `${second} ${first}`;
}

/**
 * Highest count. Ties break on total occurrences, then on length (a longer
 * word is more likely a topic than a short one), then alphabetically — so
 * the result is deterministic for a given corpus.
 */
function top(
  counts: Map<string, number>,
  tf: Map<string, number> = new Map(),
): string | undefined {
  let best: string | undefined;
  for (const [word, n] of counts) {
    if (best === undefined) {
      best = word;
      continue;
    }
    const bestN = counts.get(best) ?? 0;
    if (n !== bestN) {
      if (n > bestN) best = word;
      continue;
    }
    const tfDiff = (tf.get(word) ?? 0) - (tf.get(best) ?? 0);
    if (tfDiff !== 0) {
      if (tfDiff > 0) best = word;
      continue;
    }
    if (word.length !== best.length) {
      if (word.length > best.length) best = word;
      continue;
    }
    if (word < best) best = word;
  }
  return best;
}

/**
 * Below this many indexed reviews the co-occurrence suggestion is arbitrary
 * — on the three-review API sample or a five-review Places import it picks
 * whatever two words happen to repeat ("afternoon asking") — so step 4
 * prefills the tag with no `data-query` instead (#106). Recency mode always
 * renders something; a bad query renders nothing or nonsense.
 */
export const MIN_REVIEWS_FOR_SUGGESTION = 20;

/**
 * The query step 4 prefills: `suggestQueryFromTexts` over the project's
 * `full` chunks (one per indexed review), or null when there are fewer than
 * MIN_REVIEWS_FOR_SUGGESTION of them.
 */
export function suggestQuery(
  chunks: readonly string[],
  minReviews: number = MIN_REVIEWS_FOR_SUGGESTION,
): string | null {
  if (chunks.length < minReviews) return null;
  return suggestQueryFromTexts(chunks);
}

// --- The snippet tag, the demo, the curl -------------------------------------

function attr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

export const SNIPPET_LIMIT_DEFAULT = 3;

export interface SnippetTagInput {
  /** The suggested query; omitted ⇒ the newest publishable reviews. */
  query: string | null;
  /** The live publishable key, or a placeholder when it is no longer known. */
  key: string;
  /** Where the snippet loads from (`SNIPPET_SRC`). */
  snippetSrc: string;
  /** The api origin; `data-api` is added only when it is not the default. */
  apiUrl?: string;
}

/**
 * The one-tag embed exactly as packages/snippet/README.md documents it,
 * prefilled for this project. Same shape `snippetFor` in ./playground.ts
 * emits; this one carries a real key instead of a placeholder.
 */
export function onboardingSnippet(input: SnippetTagInput): string {
  const attrs = ["data-proofql"];
  if (input.query) attrs.push(`data-query="${attr(input.query)}"`);
  attrs.push(`data-limit="${SNIPPET_LIMIT_DEFAULT}"`);
  const script = [
    `src="${attr(input.snippetSrc)}"`,
    `data-key="${attr(input.key)}"`,
  ];
  const api = (input.apiUrl ?? SNIPPET_DEFAULT_API).replace(/\/$/, "");
  if (api !== SNIPPET_DEFAULT_API) script.push(`data-api="${attr(api)}"`);
  return [
    `<div ${attrs.join(" ")}></div>`,
    `<script async ${script.join(" ")}></script>`,
  ].join("\n");
}

/**
 * The hosted demo (workers/cdn `/demo/`) against this project: it reads the
 * publishable key — and the api origin, when not the default — from its URL.
 */
export function demoUrl(
  snippetSrc: string,
  key: string | null,
  apiUrl: string = SNIPPET_DEFAULT_API,
): string {
  const url = new URL("/demo/", snippetSrc);
  if (key) url.searchParams.set("key", key);
  const api = apiUrl.replace(/\/$/, "");
  if (key && api !== SNIPPET_DEFAULT_API) url.searchParams.set("api", api);
  return url.toString();
}

/** Three sample reviews for the "use the API" path; generic on purpose. */
export const INGEST_SAMPLE: readonly Record<string, unknown>[] = [
  {
    external_id: "sample-1",
    source: "custom",
    rating: 5,
    text: "They fixed the problem the same afternoon and explained every step before starting. Fair price, no surprises on the invoice.",
    author_name: "Dana K.",
    occurred_at: "2026-02-01T09:00:00Z",
  },
  {
    external_id: "sample-2",
    source: "custom",
    rating: 5,
    text: "Easy to book online, free parking behind the building, and the front desk remembered my name on the second visit.",
    author_name: "Marcus T.",
    occurred_at: "2026-03-14T18:20:00Z",
  },
  {
    external_id: "sample-3",
    source: "custom",
    rating: 4,
    text: "Gentle with my four-year-old, who left asking when we could come back. Saturday hours made it work for us.",
    author_name: "Priya S.",
    occurred_at: "2026-05-02T15:45:00Z",
  },
];

/** Single-quote a string for a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `POST /v1/reviews` with the live secret key and the three samples. */
export function ingestCurl(input: {
  apiUrl: string;
  /** The live secret key, or a placeholder when no longer known. */
  secretKey: string;
}): string {
  const body = JSON.stringify(INGEST_SAMPLE, null, 2);
  return [
    `curl -s -X POST ${shellQuote(`${input.apiUrl.replace(/\/$/, "")}/v1/reviews`)} \\`,
    `  -H ${shellQuote(`Authorization: Bearer ${input.secretKey}`)} \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d ${shellQuote(body)}`,
  ].join("\n");
}

// --- Progress --------------------------------------------------------------

export interface IndexingCounts {
  /** Live reviews in the project. */
  reviews: number;
  /** Of those, how many the pipeline has indexed / still has to. */
  indexed: number;
  indexing: number;
  /** Some have waited past two minutes: indexing is delayed (#162; app/lib/indexing.ts). */
  deferred: boolean;
}

/** Every review indexed and at least one review: the indexing step is done. */
export function indexingSettled(counts: IndexingCounts): boolean {
  return counts.reviews > 0 && counts.indexing === 0;
}

/** How long step 3 waits with zero reviews before offering a way back. */
export const NO_REVIEWS_HINT_AFTER_MS = 60_000;
