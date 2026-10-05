---
title: Relevance and the floor
description: What score measures, why an empty result beats an irrelevant one, how to highlight the matching sentence inside the untouched review, how to fall back to recent reviews without lying about it, how min_rating, the similarity floor, and the sentiment gate interact, and how to tune the floor from query.completed logs.
---

## Relevance

Every result from [`/v1/query`](/api/operations/queryreviews) carries a `score`: the **cosine similarity between your query and the returned excerpt**, in `[0, 1]`. Both are embedded with the same multilingual model (`bge-m3`, 1,024 dimensions), so the number means the same thing across queries, across projects, and across time. A `score` of `0.8` or more is a review that is plainly about what you asked; around `0.7` is a clear match; `0.55`–`0.65` is the neighbourhood, the same domain and often a different topic (a parking review against an implants query lands there); below `0.5` is unrelated.

Two things `score` is not:

- It is not the rank. Results are ordered by a fusion of vector similarity and a full-text rank (reciprocal rank fusion), so a review that matches your exact words can sit above one with a slightly higher `score`. The fused rank is only meaningful inside one result set and stays internal.
- It is not present without `q`. With no query the endpoint returns the newest publishable reviews and every `score` is `null`.

An `excerpt` is always a verbatim slice of the review's text. At index time every review is embedded whole, every review of two or more sentences is also embedded one sentence at a time, and longer reviews get overlapping two-to-three-sentence windows as well; the best-matching chunk is what you get back, so a review that covers four topics can answer four different pages with four different excerpts, each as narrow as one sentence. Nothing generates or rewrites text.

## Highlighting

A four-paragraph review usually answers your page's question in one sentence. Rather than rewriting the review, the API returns it untouched and tells you where that sentence is: every result carries `highlight`, the excerpt's `{ start, end }` offsets within `review.text`, so you can put a highlighter over the exact sentence and leave the author's punctuation alone. Highlights are sentence-precise: each sentence of a review is indexed on its own, so when one sentence answers the query, that sentence is the excerpt and the span covers it and nothing around it.

The offsets are **UTF-16 code units** with `end` exclusive, the unit `String.prototype.slice` uses, so `review.text.slice(highlight.start, highlight.end) === excerpt` holds in every browser and runtime, with emoji and CJK ahead of the span included. `review.text` is present in `mode=reviews`, or in `mode=excerpts` when you ask for it with `include: ["text"]` (`include=text` on GET). `highlight` is `null` when there is nothing to mark: without `q`, and when the match is the review as a whole — which is always the case for a single-sentence review, since its one sentence *is* the review. Render those plain; there is no narrower span to show.

```js
const { results } = await (await fetch(url)).json();
for (const { review, highlight } of results) {
  const el = document.createElement("blockquote");
  if (!highlight) el.textContent = review.text;
  else el.append(review.text.slice(0, highlight.start), Object.assign(document.createElement("mark"), { textContent: review.text.slice(highlight.start, highlight.end) }), review.text.slice(highlight.end));
  document.querySelector("#reviews").append(el);
}
```

Three nodes, no `innerHTML`: a review can contain `<script>` and it stays text. The snippet does exactly this with [`data-highlight="true"`](/snippet#highlighting-the-match), and the dashboard's Playground shows the mark on every card.

## Empty beats irrelevant

A testimonials block that shows a review about parking on the implants page does more damage than an empty block: the visitor learns that the quotes are decoration. So ProofQL never pads. Candidates whose `score` is below the project's **similarity floor** (`similarity_floor`, default `0.66`) are dropped inside the search statement, and when nothing clears it the response is `results: []` with a `200`. The floor has a second, lower tier for **word matches**: an excerpt that contains at least half of the query's words, not counting generic ones like "dental" or "dentist", passes at the floor minus `0.13`, so `0.53` by default. A `score` under the floor on a result is that tier at work. The snippet renders nothing on an empty result and leaves whatever the element already contained.

The same rule holds under failure. If the embedding service is unavailable the endpoint answers `503 embedding_unavailable` rather than falling back to a keyword-only search, because a keyword hit with no vector proximity is exactly the irrelevant result the floor exists to drop. Full-text-only hits are dropped for the same reason when a `q` is present: a word match still has to clear the word-match tier, so a shared word with no semantic proximity never carries a result.

## Honest fallback

Sometimes an empty block is still the wrong answer: a contractor's roofing page before the first roofing review has arrived. The temptation is to show five-star reviews about something else under the roofing heading, and that is the one thing ProofQL will not do silently. Ask for a fallback and the API gives you recent reviews **and tells you that is what they are**:

```json
{ "q": "roofing", "fallback": "recent", "limit": 3 }
```

- `fallback` is `"none"` (default; `results: []` when nothing clears the floor) or `"recent"`: when nothing clears the floor, the newest publishable reviews under the same policy and filters come back instead. GET: `?fallback=recent`.
- `match` on every response is the verdict: `"query"` (real matches), `"fallback"` (the newest reviews, because nothing matched and you asked), `"none"` (nothing matched, `results` empty), or `"recent"` (no `q` was sent). Every result also carries `matched`, `true` only for a real match; fallback rows have `score: null` and `highlight: null`.
- A response is all matches or all fallback, never a mix. Only an empty result falls back; a page with two real matches is not topped up with three recent reviews, because a mixed list has no honest label.

The point of the label is the heading. Your UI reads `match` and changes "What patients say about insurance" to "What patients say about working with us": never tricking the visitor, never rendering a broken empty box.

```js
const { results, match } = await (await fetch(url)).json();
heading.textContent = match === "fallback"
  ? "What patients say about working with us"
  : "What patients say about insurance";
```

The snippet does this with [`data-fallback="recent"`](/snippet#honest-fallback) and the two heading attributes, and marks its container `data-pq-match="fallback"` so your CSS can restyle it. `query.completed` logs `fallback` and `match`, so the fallback rate is a number you can watch while [tuning the floor](#tuning-the-floor).

## Three gates, one statement

Three independent rules decide what can appear, and all three run in the same SQL as the ranking, never as a post-filter:

| Gate | Default | What it does |
|---|---|---|
| **Hidden** | — | A review hidden in the dashboard or via `PATCH /v1/reviews/{id}` (`hidden_at IS NOT NULL`) never appears, however well it matches. |
| **`min_rating`** | `4` | `rating >= min_rating`. A request's `filters.min_rating` (the snippet's `data-min-rating`) is combined as `max(project.min_rating, filters.min_rating)`: a caller can tighten the policy for one query, never loosen it. |
| **Sentiment** | `negative` excluded | For reviews **without** a rating, a classifier fills `sentiment` at ingest and `negative` ones are excluded. Rated reviews use their stars as the signal and skip the classifier. |

Then the **floor** decides which of the surviving candidates are relevant enough to show. The order matters for reasoning about results: "The implant consult was a waste of money" matches `q=implants` hard and would clear any floor, and the one-star rating on it is why it never renders. Conversely, a glowing five-star review about parking clears every policy gate and is dropped by the floor on the implants page. Policy decides *what may be shown anywhere*; the floor decides *what belongs here*.

Changing any of the three, or hiding a review, bumps the project's cache generation, so the next query is a real miss and reflects the change.

## Tuning the floor

`0.66` is the default because it is the lowest floor at which **an in-domain query with no answer in the corpus returns nothing**. It was measured, not guessed (#138): a set of labelled queries against the demo dental corpus, embedded with the same `bge-m3` model the API uses, with every returned review's `score` recorded at a scratch floor of `0.30`. The queries are of three kinds: 35 a dental practice's page would ask and the corpus answers (labelled with the reviews that answer them, many of them paraphrases that share no words, like "scared of needles" for the anxiety reviews); 17 that sound like the same practice but have no answer ("orthodontic headgear", "the lobby coffee kiosk swallowed my coins"); and 5 whose only answers are low-rated reviews the policy hides, where showing a five-star review about something else would be the failure.

| Floor | Answerable queries with a genuine answer | Queries that must be empty but are not | Pooled precision |
|---|---|---|---|
| `0.55` (previous default) | 97% | 64% | 30% |
| `0.60` | 91% | 45% | 49% |
| `0.63` | 77% | 23% | 58% |
| `0.66` flat | 66% | 0% | 67% |
| `0.66`, every word must match at `0.53` | 77% | 0% | 73% |
| **`0.66`, half the specific words at `0.53`** (default) | **86%** | **5%** | **70%** |
| `0.70` | 37% | 0% | 70% |

The two populations overlap: the best score an unanswerable query gets has a median of `0.59` and reaches `0.65`, while the reviews that genuinely answer a query have a median of `0.62`. No single floor gives both, so the default takes the side the product is built on, *empty beats irrelevant*. A flat `0.66` blanks a third of answerable queries, mostly short keyword ones: `bge-m3` scores a bare keyword low against a sentence ("veneers" tops out at `0.633` against the one veneer review). That is what the word-match tier is for. An excerpt counts as a word match when it contains at least half of the query's content words, ignoring stop words and a short list of words too generic to mean anything in a dental corpus ("dental", "dentist", "teeth", "review", "office"); an excerpt with every word always counts. With the tier at `0.53`, "Invisalign", "veneers", "root canal", "no surprise bills", "dental implants" (the implant reviews never say "dental"), "do they take my insurance", and "pediatric dentist for my toddler" are answered. The cost on the fixtures was one must-be-empty query of 22: "vending machine in the waiting room" shows a review that mentions the waiting room. Requiring every word kept all 22 empty but answered three fewer queries, and counting any single shared word let half of them through. The tier follows your floor when you move it. What is left empty is mostly paraphrase ("being put to sleep for an extraction", "clear aligners for a teenager"); a longer phrasing of the page's topic usually clears the floor, and [`fallback: "recent"`](#honest-fallback) turns the empty block into an honestly labelled one. Two reasons to move it for your project:

- **Too many empties** on pages that *should* match: short page queries, a multilingual corpus (cross-language similarities sit lower than monolingual ones), or very short reviews. Lower it `0.02` at a time; in the measurements above, `0.63` keeps three quarters of answerable queries answered at the cost of an unrelated quote on roughly one unanswerable page in four.
- **Irrelevant excerpts rendering** on pages with a narrow topic. Raise it `0.02` at a time until the empties start, then back off one step.

The measurement is repeatable. `pnpm db:tune-floor` (in `packages/db`) runs the labelled fixtures against a deployed API, saves every score to `docs/floor-tuning/<date>.json`, and prints precision, recall, the share of answerable queries answered, and the false-positive rate on the must-be-empty queries for every floor from `0.50` to `0.80`, with the lowest floor that keeps that rate at or under 5%. `--annotate <file>` records which returned excerpts are word matches (`--lexical-rule all|any|half|half-specific` measures the alternatives), and `--replay <file> --two-tier` grid-searches the two tiers (floor `0.62`–`0.70`, word-match tier `0.50`–`0.60`) and ranks the pairs that keep the must-be-empty rate at or under 5% by answered queries. `--replay <file>` recomputes the flat report from a saved run without the API. Re-run it when the embedding model or the chunker changes.

Tune from data, not from one query. Every answered query writes one `query.completed` log line with the knobs that shaped it and what came of them:

```json
{"event":"query.completed","project_id":"…","has_q":true,"q_length":15,"limit":3,
 "min_rating":4,"similarity_floor":0.66,"returned":2,"cached":"MISS",
 "took_ms":41,"embedding_ms":28,"search_ms":6}
```

Over a window of real traffic for one project (`has_q = true`, `cached != HIT`, since hits repeat a miss's result), look at:

1. **Empty rate**: the share of lines with `returned = 0`. High, on a project whose pages ask about things the business has reviews about, means the floor is too high for that corpus.
2. **Saturation**: the share with `returned = limit`. Near 100% with a low floor means the floor is doing no work and irrelevant excerpts may be rendering.
3. **Before and after**: a floor change shows up as two populations in `similarity_floor`; compare their `returned` distributions for the same `q_length` band.

Never the query text, never an excerpt: the line carries `q_length`, not `q`.

## Where the knobs are

Both live on the project's **Settings** tab in the dashboard (`/app/projects/<slug>/settings`): the minimum rating as a pick list, the floor as a number between its bounds, each with the tradeoff spelled out. Saving bumps the project's cache generation, so the next query anywhere, in the snippet or the playground, reflects the change.

Before touching either, run the query in the **Playground** (`/app/projects/<slug>/playground`). It runs the exact policy the API runs and draws the floor as a line through the ranked candidates: everything above it is what `/v1/query` returns, everything greyed out below it is what the floor dropped, with its `score`. One look usually settles whether the floor is too high for a corpus or an irrelevant excerpt is sneaking through.
