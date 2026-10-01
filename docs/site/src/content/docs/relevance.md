---
title: Relevance and the floor
description: What score measures, why an empty result beats an irrelevant one, how min_rating, the similarity floor, and the sentiment gate interact, and how to tune the floor from query.completed logs.
---

## Relevance

Every result from [`/v1/query`](/api/operations/queryreviews) carries a `score`: the **cosine similarity between your query and the returned excerpt**, in `[0, 1]`. Both are embedded with the same multilingual model (`bge-m3`, 1,024 dimensions), so the number means the same thing across queries, across projects, and across time. A `score` of `0.9` is a review that is plainly about what you asked; `0.6` is in the neighbourhood; `0.4` shares a few words at most.

Two things `score` is not:

- It is not the rank. Results are ordered by a fusion of vector similarity and a full-text rank (reciprocal rank fusion), so a review that matches your exact words can sit above one with a slightly higher `score`. The fused rank is only meaningful inside one result set and stays internal.
- It is not present without `q`. With no query the endpoint returns the newest publishable reviews and every `score` is `null`.

An `excerpt` is always a verbatim slice of the review's text. Longer reviews are split into overlapping sentence windows at index time, each window gets its own vector, and the best-matching window is what you get back, so a review that covers four topics can answer four different pages with four different excerpts. Nothing generates or rewrites text.

## Empty beats irrelevant

A testimonials block that shows a review about parking on the implants page does more damage than an empty block: the visitor learns that the quotes are decoration. So ProofQL never pads. Candidates whose `score` is below the project's **similarity floor** (`similarity_floor`, default `0.55`) are dropped inside the search statement, and when nothing clears it the response is `results: []` with a `200`. The snippet renders nothing on an empty result and leaves whatever the element already contained.

The same rule holds under failure. If the embedding service is unavailable the endpoint answers `503 embedding_unavailable` rather than falling back to a keyword-only search, because a keyword hit with no vector proximity is exactly the irrelevant result the floor exists to drop. Full-text-only hits are dropped for the same reason when a `q` is present.

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

`0.55` is a deliberate default for English reviews queried in English, chosen so that a page with a real topic shows two or three excerpts and a page with no matching reviews shows none. Two reasons to move it:

- **Too many empties** on pages that *should* match, typically a multilingual corpus (cross-language similarities sit lower than monolingual ones) or very short reviews. Try `0.50`.
- **Irrelevant excerpts rendering** on pages with a narrow topic. Raise it in steps of `0.05` until the empties start, then back off one step.

Tune from data, not from one query. Every answered query writes one `query.completed` log line with the knobs that shaped it and what came of them:

```json
{"event":"query.completed","project_id":"…","has_q":true,"q_length":15,"limit":3,
 "min_rating":4,"similarity_floor":0.55,"returned":2,"cached":"MISS",
 "took_ms":41,"embedding_ms":28,"search_ms":6}
```

Over a window of real traffic for one project (`has_q = true`, `cached != HIT`, since hits repeat a miss's result), look at:

1. **Empty rate**: the share of lines with `returned = 0`. High, on a project whose pages ask about things the business has reviews about, means the floor is too high for that corpus.
2. **Saturation**: the share with `returned = limit`. Near 100% with a low floor means the floor is doing no work and irrelevant excerpts may be rendering.
3. **Before and after**: a floor change shows up as two populations in `similarity_floor`; compare their `returned` distributions for the same `q_length` band.

Never the query text, never an excerpt: the line carries `q_length`, not `q`.

:::caution[Coming soon]
The per-project form for `min_rating` and `similarity_floor` in the dashboard is [#41](https://github.com/plattegruber/proofql/issues/41), and the query playground that shows scores for a query against your own reviews is [#40](https://github.com/plattegruber/proofql/issues/40). Until then both knobs sit at their defaults.
:::
