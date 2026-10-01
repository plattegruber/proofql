# ProofQL — scope and architecture

- **Status:** Accepted, 2026-10-01
- **Owner:** @plattegruber

This is the founding document. It records what ProofQL is, what v0 ships, the API contract, the data model, what is ported from Well-Regarded and what is deliberately left behind, and the milestone plan the backlog follows. When issues and this document disagree, fix whichever is wrong.

## 1. Product

**One sentence:** a hosted API that turns a business's reviews into a semantically searchable corpus, so their website can show the reviews relevant to each page instead of the same five everywhere.

**Customer:** web developers and agencies building sites for local and small businesses, and the businesses themselves via the dashboard. Horizontal from day one. The example vertical in docs is dental because that is where the idea came from, not because anything is dental-specific.

**Core loop:**

```
reviews in  ──►  split into excerpts, embed  ──►  query by meaning  ──►  rendered on the customer's site
(push API,       (pipeline)                      (query API)            (JS snippet or their own code)
 CSV, Google)
```

**What makes it a product rather than a vector database with a form:**

- Reviews, not documents. The ingest shape, excerpt splitting, publication policy, and response contract all know what a review is: rating, author, source, date, attribution rules.
- Empty beats irrelevant. A relevance floor is a first-class, tunable part of the contract. The snippet renders nothing rather than nonsense. This is the single most important quality property and is enforced in tests.
- Publication policy at query time. Hidden reviews, minimum rating, and a negative-sentiment gate are applied in the same SQL as the ranking, never as a post-filter in JavaScript.
- Edge-fast. Query embedding on Workers AI, results cached in KV, purged on new reviews or policy change.

**Explicitly out of scope for v0:** review response drafting, review solicitation or request campaigns, sentiment analytics dashboards, multi-language UI, white-label snippets, self-hosting. Several of these are natural follow-ons; none are needed to prove the core loop.

## 2. Decisions

Stack is inherited from Well-Regarded so the port is a move, not a rewrite. These are decided; do not relitigate in issues.

| Concern | Decision |
|---|---|
| Platform | Cloudflare Workers. Hono for HTTP. Queues for the pipeline. KV for query cache and config. Cron Triggers for connector polling. R2 for raw CSV artifacts. |
| Database | Neon Postgres via Hyperdrive (direct connection locally). Drizzle ORM and drizzle-kit migrations, append-only. pgvector with HNSW for vectors, Postgres FTS with GIN for keywords. Everything in one Postgres so policy predicates sit next to the vectors. |
| Embeddings | Workers AI `@cf/baai/bge-m3`, 1024 dimensions. Swappable in principle; a model change is a migration. |
| Excerpt splitting and sentiment | Claude API, `claude-haiku-4-5-20251001`, structured output validated with zod. Every AI judgment carries model, confidence, and prompt version. Kill switch and budget caps carry over. |
| Dashboard | React Router v7 in framework mode on Workers. Tailwind v4 and shadcn/ui. |
| Auth | Clerk for the dashboard. A Clerk Organization is an account. API keys are ours, hashed at rest. |
| Billing | Stripe, usage-based on queries. Not before M3. |
| Tooling | pnpm workspaces, Turborepo, TypeScript strict, Vitest, Biome, GitHub Actions, docker compose Postgres (`pgvector/pgvector:pg16`) locally. |

### Dropped from Well-Regarded, on purpose

- **Consent management.** Well-Regarded's append-only consents table, patient tokens, and the "no publishable boolean" invariant exist because it handles patient testimonials in a HIPAA-shaped context. ProofQL serves reviews the reviewer already published under a platform's terms. A per-review `hidden_at` and a per-project policy are the whole publication model.
- **Facts vs. judgments as separate tables.** Kept in spirit (AI output is labeled with confidence and model), dropped as a schema pattern. Sentiment lives as nullable columns on the excerpt with `sentiment_model` and `sentiment_confidence` beside it. Re-running the model overwrites them; there is no need for history.
- **Recovery, response, coverage, messaging, PMS integration.** Different products.
- **Healthcare vocabulary.** Practices become projects. Patients become authors. Signals become reviews.

## 3. API contract (v0)

Base URL `https://api.proofql.com`. JSON everywhere. Standard error envelope `{ "error": { "code", "message", "doc_url" } }`. Versioned by path prefix.

### Keys

Two kinds, both per project, both prefixed so they are greppable and so a leaked key's blast radius is obvious:

| Prefix | Kind | Can | Where it lives |
|---|---|---|---|
| `pq_sk_live_…` / `pq_sk_test_…` | Secret | Everything: ingest, manage, query | Servers only |
| `pq_pk_live_…` / `pq_pk_test_…` | Publishable | Query only, CORS-restricted to the project's allowed origins | Browser, the snippet |

Keys are hashed at rest with SHA-256; the plaintext is shown once. Test keys hit the same database with a `test` environment column on every row so a project can wipe test data without touching live.

### Ingest

`POST /v1/reviews` with a secret key. Body is one review or an array (max 100). Upsert keyed on `(project, source, external_id)`.

```json
{
  "external_id": "accounts/1/locations/2/reviews/abc",
  "source": "google",
  "rating": 5,
  "text": "…",
  "author_name": "Marcus T.",
  "author_avatar_url": null,
  "occurred_at": "2026-03-14T18:20:00Z",
  "url": "https://maps.google.com/…",
  "language": "en",
  "metadata": { "location": "north" }
}
```

`source` is a free string from a known set (`google`, `yelp`, `facebook`, `trustpilot`, `custom`). `rating` is nullable for sources without stars. `metadata` is a flat string-to-string map the customer can filter on at query time. Response returns the stored reviews with `id` and `status: "indexing" | "indexed"`. Indexing is asynchronous via the pipeline; a review is queryable within seconds.

Also: `GET /v1/reviews`, `GET /v1/reviews/:id`, `PATCH /v1/reviews/:id` (hide, unhide, edit metadata), `DELETE /v1/reviews/:id`. Deleting a review purges its excerpts and the query cache.

### Query

`POST /v1/query` (and `GET /v1/query?q=…` for the snippet, since GET caches at the edge) with either key kind.

```json
{
  "q": "dental implants",
  "limit": 5,
  "mode": "excerpts",
  "filters": { "min_rating": 4, "source": ["google"], "metadata.location": "north", "since": "2025-01-01" }
}
```

- `q` optional. Without it, results are the newest publishable reviews. With it, hybrid search.
- `mode` is `excerpts` (default: the matching slice, best for placement) or `reviews` (whole review, deduplicated, scored by its best excerpt).
- Response: `{ "results": [{ "score", "excerpt", "excerpt_id", "review": { … } }], "took_ms", "cached" }`. `score` is in [0, 1] and is the normalized vector similarity of the returned excerpt, not the fused rank, so it is comparable across queries.
- Relevance floor: candidates below the project's threshold (default 0.55 cosine, tunable per project and per environment) are dropped. The endpoint returns `results: []` rather than padding. Full-text-only hits with no vector proximity above the floor are dropped when `q` is present.
- Policy applied in the same SQL as ranking: `hidden_at IS NULL`, `rating >= project.min_rating`, and when `project.exclude_negative = true`, excerpts whose sentiment is negative above a confidence threshold are excluded even when topically on-point. "The implant consult was a waste of money" matches `q=implants` hard; the gate is why it never renders.
- Rate limited per key. Cached in KV keyed on `(project, environment, normalized query, filters)`; purged on ingest, delete, hide, or policy change for that project.

### Snippet

```html
<div data-proofql data-query="dental implants" data-limit="3"></div>
<script async src="https://cdn.proofql.com/v1.js" data-key="pq_pk_live_…"></script>
```

A pure client of `GET /v1/query`. Under 5 KB, no dependencies, renders nothing on empty results or error, ships with a default stylesheet that is easy to override and a `data-template` escape hatch. The snippet is the demo and the first thing a developer sees; it must look good out of the box.

## 4. Data model

Tenancy: `accounts` (mirrors a Clerk Organization) → `projects` (one per website or business; API keys, policy, allowed origins, environment separation) → everything else carries `project_id` and `environment`.

```
accounts         id, clerk_org_id, name, plan, created_at
projects         id, account_id, name, slug, allowed_origins[], min_rating, exclude_negative,
                 similarity_floor, created_at
api_keys         id, project_id, kind (secret|publishable), environment (live|test),
                 key_hash, prefix, last_used_at, revoked_at
reviews          id, project_id, environment, source, external_id, rating, text, author_name,
                 author_avatar_url, occurred_at, url, language, metadata jsonb,
                 hidden_at, indexed_at, created_at, updated_at
                 UNIQUE (project_id, environment, source, external_id)
review_excerpts  id, review_id, project_id (denormalized for HNSW post-filter), environment,
                 text (verbatim slice), start_offset, embedding vector(1024), tsv (generated),
                 sentiment (positive|neutral|negative|null), sentiment_confidence,
                 sentiment_model, created_at
                 INDEX hnsw (embedding vector_cosine_ops), GIN (tsv)
ai_calls         model, prompt_version, tokens, cost, latency, project_id, purpose  (budget caps)
connections      id, project_id, kind (google), credentials (AES-GCM), status, cursor, metadata
ingest_runs      id, project_id, kind (api|csv|google), counts, status, error, artifact_key
```

Excerpt text is always a verbatim slice of the review: `review.text.slice(start_offset, start_offset + text.length) === text`, enforced server-side. A fabricated quote is never stored. Short reviews (under ~200 characters) become a single excerpt without an AI call.

## 5. What ports from Well-Regarded

Paths are in the Well-Regarded repo. "Port" means copy, rename vocabulary, drop the parts marked, keep the tests.

| Well-Regarded | ProofQL | Changes |
|---|---|---|
| `packages/db/src/schema/proofExcerpts.ts` | `review_excerpts` | rename, add sentiment columns, add `environment` |
| `packages/db/src/queries/hybridSearch.ts` | hybrid search | add policy predicates as CTE input, environment filter |
| `packages/db/src/schema/tsvector.ts` | same | none |
| `packages/ai/src/embedding.ts` | same | none |
| `packages/ai/src/prompts/excerpts.ts` | excerpt splitter | strip healthcare framing from the prompt, add sentiment to the same call |
| `packages/ai/src/prompts/judgments.ts` | sentiment only | drop urgency, response risk, publication suitability |
| `packages/core/src/apiKeys.ts` | same | add `kind` (secret/publishable) to the prefix scheme |
| AI kill switch, budget caps, `ai_calls` | same | none |
| `packages/sources/src/google/*`, fake GBP server, ADR 0002 | Google connector (M3) | practice → project; drop reply publishing |
| CSV import (`docs/csv-import.md`, `packages/sources/src/csv`) | CSV upload | drop PII handling specific to patients; keep column mapping |
| Monorepo scaffold, biome, turbo, CI, docker compose, `scripts/setup.sh` | same | rename scope to `@proofql/*` |
| Design tokens and dashboard conventions (`design/`, `docs/frontend-conventions.md`) | dashboard | reuse the design language; new screens |

Not ported: consent (all of it), patient tokens, derivations table, signals pipeline stages beyond normalize, recovery, responses, templates, coverage, messaging, staff permissions beyond Clerk roles.

## 6. Milestones

Each milestone is a GitHub milestone; each epic is an issue labeled `epic`; tasks reference their epic and close via PR.

- **M0 Foundations.** Monorepo scaffold, local Postgres, CI, the ported `db`/`core`/`ai` packages with their tests green, Neon and Cloudflare provisioned. Exit: `pnpm run setup && pnpm test` green on a fresh clone; a seeded demo project exists.
- **M1 Ingest and search.** Push API, pipeline (excerpt + embed + sentiment), query API with floor and policy, keys, rate limits, KV cache with purge. Exit: a curl-driven demo from ingest to a relevant query result against local and against deployed staging.
- **M2 Snippet and dashboard.** The JS snippet, the dashboard (sign up, projects, keys, CSV upload, review browser with hide, query playground, policy settings), OpenAPI spec and docs page. Exit: a stranger can sign up, upload a CSV, paste the snippet into a static page, and see relevant reviews, with no help.
- **M3 Connectors and launch.** Google connector gated on API access approval, Places API bootstrap, Stripe billing, abuse hardening, load test, launch checklist. Exit: public signup open.

## 7. User-gated items

These need a human with the real accounts. They gate production, not development.

1. **Google Business Profile API access.** File from a SkipStatic address, citing the SkipStatic Business Profile and website as eligibility, with ProofQL's production Google Cloud project number. Use case: "a review search API: with each business's OAuth consent, we read their Google reviews so they can display them on their own website." Approval shows as quota flipping 0 → 300 QPM. Lead time 1 to 6 weeks. Full detail in Well-Regarded ADR 0002.
2. **Google OAuth sensitive-scope verification.** Needed before the public can connect Google accounts. Needs privacy policy, homepage, demo video. Start when the connect flow is demoable (M3).
3. **Cloudflare account and Neon project** for staging and production, and wrangler secrets.
4. **Clerk application** and keys.
5. **Anthropic API key** for the pipeline and eval harness.
6. **Domain:** `proofql.com` (or whatever is owned) with `api.` and `cdn.` subdomains.
7. **Stripe account** (M3).

## 8. Open questions

Recorded so they are not re-asked; answer in an ADR when they matter.

- Per-excerpt vs per-review deduplication when one review dominates a query. Likely: `mode=excerpts` caps at one excerpt per review by default, overridable.
- Multilingual queries. bge-m3 is multilingual, so a Spanish query over English reviews should mostly work. Verify in the eval harness before claiming it.
- Whether to offer `mode=summary`, a one-paragraph AI summary of the matching reviews with citations. Compelling, but it changes the product from "serve the customer's words" to "generate words"; defer and decide with data.
- Pricing shape. Per-query with a free tier is the default assumption.
