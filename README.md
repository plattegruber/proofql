# ProofQL

**Review search as an API.** Send us your reviews, ask us a question, get back the ones that answer it.

```http
POST /v1/query
Authorization: Bearer pq_pk_live_…

{ "q": "dental implants", "limit": 3 }
```

```json
{
  "results": [
    {
      "score": 0.91,
      "excerpt": "Dr. Patel did my implant and I honestly forgot it wasn't my own tooth within a week.",
      "review": { "rating": 5, "author_name": "Marcus T.", "source": "google", "occurred_at": "2026-03-14" }
    }
  ]
}
```

Businesses have hundreds of genuine reviews and show visitors the same five, picked by hand, on one testimonials page. ProofQL makes the whole corpus queryable so every page can show the reviews relevant to *that* page: the implants page shows implant reviews, the pricing page shows reviews about value, the location page shows reviews that mention parking. Topics are emergent. Nothing is tagged by hand; matching is semantic.

ProofQL is horizontal. The search core does not know or care what industry a review is about.

## What it does

1. **Ingest.** A push API accepts reviews in a normalized shape from any source. A Google Business Profile connector follows once Google approves API access. CSV upload in the dashboard covers everyone else on day one.
2. **Index.** Every review is embedded whole, and longer reviews also get sentence-window chunks so a review that covers four topics matches four queries. Vectors and a full-text index live in Postgres. No LLM touches your reviews.
3. **Serve.** A query API runs hybrid search (vector similarity fused with full-text rank), applies a relevance floor and the project's publication policy, and returns ranked excerpts with their parent reviews. An empty result beats an irrelevant one. A tiny JS snippet renders results on any site with one script tag.

## Status

Pre-code. The scope, architecture, API contract, and milestone plan are in [docs/scope.md](docs/scope.md). The backlog lives in GitHub issues; the roadmap issue is pinned.

The idea comes from [well-regarded](https://github.com/plattegruber/well-regarded), where review placement was one feature of a larger healthcare product. ProofQL is that feature as a standalone, horizontal product with a free tier generous enough for anyone, built fresh.

## Quickstart

Not yet. The first milestone sets up the monorepo, local Postgres, and CI; the README gains a real quickstart when it lands.
