# ProofQL — scope and architecture

- **Status:** Accepted, 2026-10-01. Revised 2026-10-01 after the product chat: fresh codebase, free-tier economics drive the architecture; see §2.
- **Owner:** @plattegruber

This is the founding document. It records what ProofQL is, what v0 ships, the API contract, the data model, the engineering decisions and the reasoning behind them, and the milestone plan the backlog follows. Well-Regarded has a reference implementation of several pieces; agents may borrow from it when it helps, but this is a fresh codebase and nothing is a port for its own sake. When issues and this document disagree, fix whichever is wrong.

## 1. Product

**One sentence:** a hosted API that turns a business's reviews into a semantically searchable corpus, so their website can show the reviews relevant to each page instead of the same five everywhere.

**Customer:** web developers and agencies building sites for local and small businesses, and the businesses themselves via the dashboard. Horizontal from day one. The example vertical in docs is dental because that is where the idea came from, not because anything is dental-specific.

**Business model: foot in the door.** The free tier is generous enough that basically anyone can use it. The free snippet carries a small "Reviews by ProofQL" badge, which is the growth loop: every customer site advertises the product. Paid removes the badge, raises limits, and later unlocks features. This has one engineering consequence that drives everything in §2: **the marginal cost of a free tenant must be approximately zero.** No LLM in the hot path, no per-tenant infrastructure, aggressive caching.

**Onboarding is the product.** Sign up → import reviews (CSV, push API, or Google) → watch a progress bar for a few seconds → copy the snippet → done. If that takes more than five minutes or one page of docs, it is a bug.

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

Made as a principal engineer would for a free-tier-first, many-small-tenants product on Cloudflare. Each has a reason; relitigate only with new information.

### Shape of the data

The defining fact: **tenants are small and numerous.** A typical business has 50 to 2,000 reviews. Even a chain has tens of thousands. There will be thousands of tenants and almost none of them are large. Everything below follows from that.

| Concern | Decision | Why |
|---|---|---|
| Platform | Cloudflare Workers. Hono. Queues for ingest. KV for cache and config. Cron Triggers for polling. R2 for uploaded CSVs. | Edge-fast reads for the snippet; one vendor for compute; cheap at free-tier scale. |
| Database | **Postgres on Neon** via Hyperdrive, Drizzle ORM, append-only migrations. pgvector for vectors, Postgres FTS for keywords. | One store holds rows, vectors, and text, so the publication policy and the ranking run in one SQL statement. Postgres has no size ceiling we will hit and makes cross-tenant admin and analytics trivial. Neon is just hosted Postgres with scale-to-zero and a free tier that covers launch; nothing is Neon-specific and any pgvector-capable Postgres works. The all-Cloudflare alternative (Vectorize + D1, or a Durable Object per tenant) was considered and rejected: D1 caps at 10 GB per database, Vectorize caps indexes at 5M vectors and adds a second store to keep consistent, and both are less familiar to the agents doing the work. Boring wins. |
| Vector search | **Exact per-tenant scan, no HNSW index.** Filter by `project_id` via btree, compute cosine over that tenant's vectors. | A tenant with 2,000 reviews has maybe 4,000 vectors; exact scan is single-digit milliseconds and always correct. A global HNSW index with a tenant post-filter is the classic multi-tenant pgvector failure mode (small tenants get starved results). Add an index per large tenant, or partition, only when a tenant actually exceeds ~50k vectors. Store as `halfvec(1024)` to halve storage. |
| Embeddings | Workers AI `@cf/baai/bge-m3`, 1024 dimensions, multilingual. | Effectively free, no vendor, no key, 8k token context so a whole review always fits. |
| Chunking | **Deterministic, no LLM.** Every review gets one vector for its full text. Reviews longer than ~3 sentences also get sentence-window vectors (2 to 3 sentences, overlapping by one). The best-matching chunk is the excerpt. | Verbatim by construction. Most reviews are short and need no splitting. The LLM excerpt splitter in Well-Regarded cost ~$0.0015 per review, which at 500 reviews per free signup is real money for zero revenue. |
| Sentiment gate | **Rating-based.** Default policy hides reviews rated 3 stars or below from query results. For sources with no rating, a Workers AI classifier (`@cf/huggingface/distilbert-sst-2-int8`) fills `sentiment` at ingest. | Reviews almost always carry a star rating; it is the sentiment signal, and it is free. The classifier is near-zero cost and only runs when needed. |
| LLMs | **None in v0.** No Claude in the pipeline or query path. | Keeps free-tenant cost at zero and removes a vendor, a key, a ledger, a kill switch, and an eval harness from the backlog. Paid features later (AI summaries of matching reviews, review response drafts) are where Claude earns its place, and paying customers cover it. |
| Dashboard | React Router v7 in framework mode on Workers. Tailwind v4, shadcn/ui. | Known quantity; runs on the same platform. |
| Auth | Clerk. A Clerk Organization is an account. API keys are ours, hashed at rest. | Best signup UX, Google sign-in out of the box (which pairs with the Google connector), free to 10k monthly active users. |
| Billing | Stripe. Not before M3. | Standard. |
| Tooling | pnpm, Turborepo, TypeScript strict, Vitest, Biome, GitHub Actions, docker compose Postgres (`pgvector/pgvector:pg16`) locally. | Same as Well-Regarded, so conventions and CI carry over. |

### Free tier (v0 numbers, tune with data)

| | Free | Paid (shape only, price later) |
|---|---|---|
| Projects | 1 | Many |
| Reviews per project | 5,000 | 100,000 |
| Queries | 50,000 / month (cached hits are free) | Metered |
| Sources | CSV, push API, Google | Same, plus priority polling |
| Snippet badge | Yes | Removable |
| Keys | Live and test | Same |

Marginal cost of a free tenant at 500 reviews: ~1,000 halfvec vectors ≈ 2 MB storage, one-time embedding on Workers AI (fractions of a cent), Google polling inside the free API quota, queries served from KV. Rounds to zero.

### Not carried over from Well-Regarded

- **Consent management.** Patient testimonials in a HIPAA-shaped product needed it. Public reviews already published under a platform's terms do not. A per-review `hidden_at` and a per-project policy are the whole publication model.
- **Facts vs. judgments as separate tables.** Sentiment is a column on the chunk with `sentiment_source` (`rating` | `model`) beside it.
- **Claude in the pipeline**, and with it the AI call ledger, kill switch, budget caps, and eval harness.
- **Recovery, response drafting, coverage, messaging, PMS integration.** Different products.
- **Healthcare vocabulary.** Practices become projects. Patients become authors. Signals become reviews.

## 3. API contract (v0)

The OpenAPI spec at [docs/api/openapi.yaml](api/openapi.yaml) is the source of truth; this section is the narrative. Base URL `https://api.proofql.com`. JSON everywhere, `snake_case` fields, versioned by path prefix. Every response carries an `x-request-id` header. Standard error envelope on every non-2xx response:

```json
{ "error": { "code": "validation_failed", "message": "…", "doc_url": "https://docs.proofql.com/errors#validation_failed",
             "request_id": "…", "details": [{ "path": "0.rating", "message": "…" }] } }
```

`code` is a short stable string to switch on; `message` is for a human and may change; `doc_url` points at the docs anchor for the code; `request_id` is the same value as the header; `details` is present for `validation_failed` only. Codes and their statuses: `unauthorized` 401, `forbidden` 403, `not_found` 404, `payload_too_large` 413, `validation_failed` and `review_limit_reached` 422, `rate_limited` and `query_quota_exceeded` 429, `internal` 500, `embedding_unavailable` 503. Unknown fields anywhere — body or query string — are a `422 validation_failed` naming the field, never ignored.

### Keys

Two kinds, both per project, both prefixed so they are greppable and so a leaked key's blast radius is obvious:

| Prefix | Kind | Can | Where it lives |
|---|---|---|---|
| `pq_sk_live_…` / `pq_sk_test_…` | Secret | Everything: ingest, manage, query | Servers only |
| `pq_pk_live_…` / `pq_pk_test_…` | Publishable | Query only, CORS-restricted to the project's allowed origins | Browser, the snippet |

Keys are hashed at rest with SHA-256; the plaintext is shown once. Test keys hit the same database with a `test` environment column on every row so a project can wipe test data without touching live. A publishable key on a secret-only route is a `403 forbidden`, decided before any lookup.

**Rate limits**, per key: 300 requests per minute for a secret key, 120 per minute for a publishable key, advertised on every authenticated response in `RateLimit-Policy` and `RateLimit-Limit`; a refused request is a `429 rate_limited` with `Retry-After`. Separately, `/v1/query` is subject to the project's monthly quota of *uncached* queries (free tier: 50,000, §2); at the quota a cache miss is a `429 query_quota_exceeded` with `Retry-After` set to the seconds until the next UTC month, while cached answers keep being served.

### Ingest

`POST /v1/reviews` with a secret key. Body is one review or an array (1 to 100), at most 1 MiB (`413 payload_too_large`). Upsert keyed on `(project, environment, source, external_id)`, where project and environment come from the key.

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

`source` is a closed enum: `google`, `yelp`, `facebook`, `trustpilot`, `custom` (`custom` is the escape hatch; a new value is a code change). `rating` is nullable for sources without stars. `metadata` is a flat string-to-string map the customer can filter on at query time. The response is `200` with `{ "reviews": [{ "id", "external_id", "source", "status" }] }` in request order — a receipt, not the full review — where `status` is `"indexing"` until the pipeline has embedded the review, then `"indexed"`. Indexing is asynchronous; a review is queryable within seconds. The plan's review cap (free: 5,000 per project) is checked before anything is written, so a batch lands whole or not at all: `422 review_limit_reached`.

Also: `GET /v1/reviews` (cursor-paginated, `limit` 1–100, filters `source`, `min_rating`, `hidden`), `GET /v1/reviews/:id`, `PATCH /v1/reviews/:id` (hide, unhide, replace metadata; body at most 64 KiB), `DELETE /v1/reviews/:id`. These return the full review resource (text, rating, author, source, sentiment, hidden state, index status, timestamps). Deleting a review purges its excerpts and the query cache. A review in another project or the other environment is a `404`, indistinguishable from one that never existed.

### Query

`POST /v1/query` (and `GET /v1/query?q=…` for the snippet, since GET caches at the edge) with either key kind.

```json
{
  "q": "dental implants",
  "limit": 5,
  "mode": "excerpts",
  "include": ["text"],
  "filters": { "min_rating": 4, "source": ["google"], "metadata.location": "north", "since": "2025-01-01" }
}
```

- `q` optional, at most 500 characters. Without it, results are the newest publishable reviews and every `score` is `null`. With it, hybrid search. `limit` is 1–20 (default 5).
- Keys: `Authorization: Bearer …` for either kind. On `GET /v1/query` **only**, a **publishable** key may instead be passed as `?key=pq_pk_…`, which is what the snippet does: a GET with no custom headers is a CORS simple request, so the browser skips the preflight, and a preflight — when one does happen — cannot carry an `Authorization` header anyway. On `POST /v1/query` a `?key=` is a `401 unauthorized` pointing at the header: a POST already needs a body and can carry one, and a key in a POST URL is surface with no caller. Secret keys are never accepted in the URL on any method. Publishable requests must carry an `Origin` listed in the project's allowed origins (exact scheme + host + port); otherwise 403.
- `filters.metadata` is an object (`{ "metadata": { "location": "north" } }`); the flat spelling `"metadata.location": "north"` inside `filters` is accepted too and is the GET form (`metadata.location=north`). Unknown fields anywhere are a 422 `validation_failed`, never ignored.
- `mode` is `excerpts` (default: the matching slice, best for placement) or `reviews` (whole review, deduplicated, scored by its best excerpt, with `review.text` present). `include` (optional, `["text"]`) adds `review.text` to every result in `excerpts` mode too; GET `include=text`.
- Response: `{ "results": [{ "score", "excerpt", "excerpt_id", "highlight", "review": { … } }], "took_ms", "cached", "badge" }`. `score` is in [0, 1] and is the cosine similarity of the returned excerpt to the query, not the fused rank, so it is comparable across queries. `excerpt` is always a verbatim slice of the review's text, and `highlight` says where: `{ "start", "end" }` as UTF-16 code-unit offsets into `review.text`, `end` exclusive, so `review.text.slice(start, end) === excerpt` (the digital highlighter, #85 — the review is returned untouched and the developer wraps the span); `null` without `q` and when the match is the whole review. `cached` says whether `results` came from KV (also `x-cache: HIT|MISS|BYPASS`). `badge` mirrors the project's plan: `true` means the snippet must render the "Reviews by ProofQL" badge (free tier).
- Relevance floor: candidates below the project's threshold (default 0.55 cosine, tunable per project and per environment) are dropped. The endpoint returns `results: []` rather than padding. Full-text-only hits with no vector proximity above the floor are dropped when `q` is present.
- Policy applied in the same SQL as ranking: `hidden_at IS NULL`, `rating >= project.min_rating` (default 4), and for unrated reviews `sentiment <> 'negative'`. A request's `filters.min_rating` can only tighten the project's policy, never loosen it. "The implant consult was a waste of money" matches `q=implants` hard; the one-star rating on it is why it never renders.
- If the embedding service is down the response is a `503 embedding_unavailable`, deliberately not a degraded full-text-only answer — that is exactly what the floor exists to prevent. Retry shortly.
- Rate limited per key (above). Cached in KV keyed on `(project, environment, normalized query, mode, include, filters, policy)`; purged on ingest, delete, hide, or policy change for that project. `Cache-Control: no-cache` on the request bypasses the lookup and still stores the fresh result.

### Snippet

```html
<div data-proofql data-query="dental implants" data-limit="3"></div>
<script async src="https://cdn.proofql.com/v1.js" data-key="pq_pk_live_…"></script>
```

A pure client of `GET /v1/query`. Under 5 KB, no dependencies, renders nothing on empty results or error, ships with a default stylesheet that is easy to override and a `data-template` escape hatch. `data-highlight="true"` renders the whole review with the API's `highlight` span in `<mark class="pq-mark">` (DOM-built, never `innerHTML`). Free-tier projects render a small "Reviews by ProofQL" badge; the API tells the snippet whether to show it. The snippet is the demo and the first thing a developer sees; it must look good out of the box.

## 4. Data model

Tenancy: `accounts` (mirrors a Clerk Organization) → `projects` (one per website or business; API keys, policy, allowed origins, environment separation) → everything else carries `project_id` and `environment`.

```
accounts         id, clerk_org_id, name, plan (free|paid), stripe_customer_id, created_at
projects         id, account_id, name, slug, allowed_origins[], min_rating (default 4),
                 similarity_floor (default 0.55), show_badge (derived from plan), review_count,
                 created_at
api_keys         id, project_id, kind (secret|publishable), environment (live|test),
                 key_hash, prefix, last_used_at, revoked_at
reviews          id, project_id, environment, source, external_id, rating, text, author_name,
                 author_avatar_url, occurred_at, url, language, metadata jsonb,
                 sentiment (positive|neutral|negative|null), sentiment_source (rating|model|null),
                 hidden_at, indexed_at, created_at, updated_at
                 UNIQUE (project_id, environment, source, external_id)
review_chunks    id, review_id, project_id, environment, kind (full|window),
                 text (verbatim slice), start_offset, embedding halfvec(1024), tsv (generated)
                 INDEX btree (project_id, environment), GIN (tsv)   -- no HNSW, see §2
connections      id, project_id, kind (google), credentials (AES-GCM), status, cursor, metadata
ingest_runs      id, project_id, kind (api|csv|google|places), counts, status, error, artifact_key
usage            project_id, month, queries, cache_hits   -- for limits and billing
```

Chunk text is always a verbatim slice of the review: `review.text.slice(start_offset, start_offset + text.length) === text`, enforced by a constraint test. A fabricated quote cannot exist because nothing generates text.

## 5. Reference material in Well-Regarded

Fresh codebase. These exist in `github.com/plattegruber/well-regarded` and are worth reading before writing the equivalent here, but copy only what fits the decisions in §2.

| Piece | Where | Worth borrowing |
|---|---|---|
| Monorepo scaffold, Biome, Turbo, CI, docker compose, `scripts/setup.sh` | repo root, `.github/`, `scripts/` | Yes, nearly verbatim with the scope renamed |
| Embedding provider with Workers AI + deterministic fake | `packages/ai/src/embedding.ts` | Yes |
| Hybrid search with RRF fusion | `packages/db/src/queries/hybridSearch.ts` | The fusion and FTS parts; drop the HNSW assumptions |
| Generated tsvector column type | `packages/db/src/schema/tsvector.ts` | Yes |
| API key prefix, hashing, pattern | `packages/core/src/apiKeys.ts` | Yes, add the `sk`/`pk` kind |
| GBP OAuth, location discovery, polling, adapter, fake GBP server, ADR 0002 | `packages/sources/src/google/*`, `docs/adr/0002-*` | Yes for M3; drop reply publishing |
| CSV import column mapping | `packages/sources/src/csv`, `docs/csv-import.md` | The mapping UX; drop patient PII handling |
| Design tokens, frontend conventions, observability conventions | `design/`, `docs/frontend-conventions.md`, `docs/observability.md` | Yes |

## 6. Milestones

Each milestone is a GitHub milestone; each epic is an issue labeled `epic`; tasks reference their epic and close via PR.

- **M0 Foundations.** Monorepo scaffold, local Postgres, CI, the `db`/`core`/`ai` packages with schema, search, embeddings, and keys tested, Neon and Cloudflare provisioned. Exit: `pnpm run setup && pnpm test` green on a fresh clone; a seeded demo project exists.
- **M1 Ingest and search.** Push API, pipeline (chunk + embed + sentiment), query API with floor and policy, keys, rate limits, KV cache with purge. Exit: a curl-driven demo from ingest to a relevant query result against local and against deployed staging.
- **M2 Snippet and dashboard.** The JS snippet with badge, the dashboard (sign up, guided onboarding, projects, keys, CSV upload, review browser with hide, query playground, policy settings), free-tier limits, OpenAPI spec and docs page. Exit: a stranger can sign up, upload a CSV, paste the snippet into a static page, and see relevant reviews, in under five minutes with no help.
- **M3 Connectors and launch.** Google connector gated on API access approval, Places API bootstrap, Stripe billing, abuse hardening, load test, launch checklist. Exit: public signup open.

## 7. User-gated items

These need a human with the real accounts. They gate production, not development.

1. **Google Business Profile API access.** File from a SkipStatic address, citing the SkipStatic Business Profile and website as eligibility, with ProofQL's production Google Cloud project number. Use case: "a review search API: with each business's OAuth consent, we read their Google reviews so they can display them on their own website." Approval shows as quota flipping 0 → 300 QPM. Lead time 1 to 6 weeks. Full detail in Well-Regarded ADR 0002.
2. **Google OAuth sensitive-scope verification.** Needed before the public can connect Google accounts. Needs privacy policy, homepage, demo video. Start when the connect flow is demoable (M3).
3. **Cloudflare account and Neon project** for staging and production, and wrangler secrets. One Neon account serves both ProofQL and Well-Regarded as separate projects.
4. **Clerk application** and keys.
5. **Google Places API key** for the five-review onboarding bootstrap (ordinary Cloud Console key, no approval).
6. **Domain:** `proofql.com` (or whatever is owned) with `api.` and `cdn.` subdomains.
7. **Stripe account** (M3).

## 8. Open questions

Recorded so they are not re-asked; answer in an ADR when they matter.

- Per-excerpt vs per-review deduplication when one review dominates a query. Likely: `mode=excerpts` caps at one excerpt per review by default, overridable.
- Multilingual queries. bge-m3 is multilingual, so a Spanish query over English reviews should mostly work. Verify in the eval harness before claiming it.
- Whether to offer `mode=summary`, a one-paragraph AI summary of the matching reviews with citations, as the first paid-only feature. Compelling, and the natural place Claude enters the product; decide with data.
- When deterministic chunking is not enough. If long multi-topic reviews produce poor excerpts in practice, an LLM splitter for paid tenants is the fix; measure first.
- Pricing shape. Per-query with a free tier is the default assumption.
