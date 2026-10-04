# @proofql/db

Drizzle ORM schema, migrations, and the connection factory for ProofQL's
Postgres (pgvector + full-text search). The schema is scope.md §4; the
decisions behind it are scope.md §2. Each module under `src/schema` opens
with the *why* for its table.

Works in both runtimes with the same driver (postgres-js):

- **Cloudflare Workers** — Neon Postgres via a Hyperdrive binding
- **Node (local dev, CI, scripts)** — direct connection to the compose Postgres

## Usage

```ts
import { createDb, schema, assertVerbatimSlice } from "@proofql/db";

// Workers: create per request, pass the Hyperdrive connection string.
const { db, sql } = createDb(env.HYPERDRIVE.connectionString);

// Node: pass DATABASE_URL yourself — the factory never reads globals and
// never connects at module scope.
const { db, sql } = createDb(process.env.DATABASE_URL);
```

- `db` is the typed Drizzle client (`PostgresJsDatabase<typeof schema>`).
- `sql` is the raw postgres-js client for hand-written SQL (hybrid search
  needs `<=>`, `ts_rank`, and RRF fusion, which read better as SQL).
- `assertVerbatimSlice(review, chunk)` is the gate on the chunk write path
  (see "Verbatim slices" below).

## Migration workflow

Run from the repo root. `db:migrate` reads `DATABASE_URL`; `db:generate`
needs no database, but it loads the schema, which takes its enum values from
`@proofql/core` (#61) via that package's `dist/` — build it first
(`pnpm --filter "@proofql/db^..." build`), as CI's migration-check does.

| Command | What it does |
| --- | --- |
| `pnpm db:generate` | Diff `src/schema` against the last snapshot and emit SQL into `migrations/` |
| `pnpm db:migrate` | Apply pending migrations from `migrations/` to `DATABASE_URL` (`scripts/migrate.ts`, drizzle's migrator; idempotent) |
| `pnpm db:set-plan -- --account <uuid\|org_…> --plan free\|paid` | Ops (#54): change an account's plan and rewrite its projects' `show_badge` mirror in one transaction (`scripts/set-plan.ts` → `setAccountPlan`). `--sync` instead of `--plan` only repairs the mirror. The only way a plan changes until billing (M3). |
| `pnpm db:reindex -- --project <slug\|uuid> \| --all [--environment live\|test] [--dry-run]` | Ops (#127): mark reviews for re-indexing after a chunker change. Sets `indexed_at = NULL` and `index_attempts = 0` on the selected (non-hidden) reviews; the pipeline's five-minute sweep (#72) re-enqueues them 500 per tick and `indexReview` replaces each review's chunks, so it is idempotent. Prints the count and the expected time. See "Re-indexing" below. |

Local dev: start Postgres (`docker compose up -d`, #11), then
`DATABASE_URL=postgres://proofql:proofql@localhost:54323/proofql pnpm db:migrate`.
Re-running is a no-op.

The `--` in `pnpm db:set-plan -- --account …` is what pnpm needs to pass
flags through to the script; pnpm 10 also forwards it, and `parseArgs`
would read it as the end of options (#128), so every script here parses
through `scripts/args.ts` (`parseScriptArgs`), which drops that one
leading `--`. The same line works without it, and so does running a script
directly (`pnpm --filter @proofql/db exec tsx scripts/set-plan.ts --account …`).

### Conventions

- **Migrations are append-only.** Never edit or delete a checked-in
  migration; fix forward with a new one. Drizzle records applied migrations
  by hash, so editing an applied file breaks every existing database. CI
  diffs `origin/main...HEAD` and fails on any change to an existing `*.sql`.
- **Schema and migrations must agree.** Every change under `src/schema`
  ships with the migration `pnpm db:generate` emits for it, in the same PR,
  including the `meta/_journal.json` and `meta/*_snapshot.json` updates. CI
  re-runs `generate` and fails if it produces anything.
- **Expand, migrate, contract.** Migrations run before Workers deploy, so
  every migration must be compatible with the code currently deployed. Add
  first, ship code that uses it, remove the old shape later.
- **Generated SQL is reviewed like source.** `db:generate` output is a
  starting point. Hand-written SQL is expected for anything the DSL cannot
  express: `0001` adds `CREATE EXTENSION IF NOT EXISTS vector` above the
  generated statements, which drizzle-kit does not manage. For a migration
  that is entirely hand-written, `pnpm db:generate --custom --name <name>`
  creates the empty journal entry.
- `drizzle-kit` is a Node-only dev tool in `devDependencies`. Nothing under
  `src/` may import it, so it is never bundled into a Worker.

## Demo seed

`pnpm seed` (root) or `pnpm --filter @proofql/db seed` wipes and recreates
the demo account — **Cedar Ridge Dental**, a fictional two-location dental
practice — and prints its API keys. `pnpm run setup` runs it after the
migrations. The seed lives in `src/seed/` (`cli.ts` is the entrypoint,
`run.ts` exports `runSeed(db)`, the corpus is `fixtures/reviews.ts`) and
connects via `DATABASE_URL`, defaulting to the canonical local compose
string.

What the dataset contains:

- **1 account** (`clerk_org_id = org_demo_proofql`, free plan) and **1
  project** (`cedar-ridge-dental`, fixed id `DEMO_PROJECT_ID`,
  `allowed_origins` = the local dashboard (8799), the local cdn worker's
  demo page (8800), and `localhost:3000`; default
  policy: `min_rating 4`, `similarity_floor 0.55`).
- **4 API keys**: a secret + publishable pair for `live` and one for
  `test`. Plaintexts are printed at the end of the run and nowhere else;
  every run mints new ones.
- **80 live reviews** (56 Google, 14 Yelp, 10 custom) and **10 test
  reviews**, `occurred_at` spread over the 18 months before `SEED_ANCHOR`,
  `metadata.location` in `{north, downtown}`, fictional authors. Ratings
  skew 4–5 with **11 reviews rated 1–3 that are topically on-point**
  (implants, Invisalign, billing, parking, front desk, a named hygienist,
  an emergency visit, kids, sedation, insurance) so the policy gate has
  something to exclude. Five custom reviews are unrated and carry a
  hand-labeled `sentiment` (`sentiment_source = 'model'`), two of them
  negative. Text length is ~60% one to two sentences, ~30% three to five,
  ~10% long multi-topic.
- **Chunks for every review**: one `full` chunk, plus 2–3 sentence
  `window` chunks overlapping by one for reviews of four or more
  sentences, plus one `sentence` chunk per sentence for reviews of two or
  more (#127) — 90 full + 30 window + 236 sentence chunks in all (live:
  80 / 28 / 218 = 326 chunks over 80 reviews, ~4.1 per review). Every
  chunk passes `assertVerbatimChunks` before insert. All chunks are embedded with
  `fakeEmbed` from `@proofql/ai`, so a query vector built with the same
  fake lands near the right rows. `indexed_at` is set; `review_count` on
  the project is the live count.

The seed chunks with **the same chunker as the pipeline**: `chunkReview`
from `@proofql/core` (`packages/core/src/chunking.ts`, #23/#68), called
with the review's `language` as the locale exactly as `workers/pipeline`
calls it. A seeded review's chunks are therefore byte-identical to what
ingesting that review would produce — same `full`/`window`/`sentence`
boundaries, same UTF-16 offsets — and `seed.integration.test.ts` asserts
that per review. There is no chunking logic in `src/seed/`. `chunkReview` rejoins
abbreviations and initials that `Intl.Segmenter` would split on (`"Dr."`,
`"St."`, `"e.g."`, `"J."`; #77), so the chunker's sentence count matches a
reader's and no window ends in a bare honorific.

Rules and properties:

- **Scoped and idempotent.** One transaction: delete the account with
  `clerk_org_id = org_demo_proofql` (cascades take projects, keys,
  reviews, chunks, usage) and re-insert. Other tenants are never touched;
  a second run yields identical counts. Data is deterministic (fixed ids
  for account and project, fixture text, `SEED_ANCHOR`-relative dates);
  only the API keys change per run.
- **Guarded.** Refuses a `DATABASE_URL` whose host is not loopback unless
  `--force` is passed (`src/seed/guard.ts`).
- **`SEED_VERSION`** (`src/seed/constants.ts`, currently 5) is written
  into the account name — `"ProofQL Demo (seed v5)"` — so any local
  database shows which fixture set it holds. Bump it with **any** change to
  what the seed produces and call the bump out in the PR: integration
  tests and the playground import `DEMO_REVIEW_FIXTURES` from
  `@proofql/db/seed` and treat the corpus as a contract
  (`src/seed/fixtures/reviews.test.ts` pins its shape).

## Re-indexing

Nothing re-indexes a review on its own: a repeat ingest with identical
text is a no-op by design, and the pipeline only touches a review when a
`review.index` message names it. So when the chunker changes — #127 added
`sentence` chunks, and reviews indexed before migration 0008 have only
`full` and `window` rows, which keeps their highlights window-wide —
existing projects keep their old chunks until something asks for new ones.

```sh
DATABASE_URL=… pnpm db:reindex -- --project <slug|uuid> --dry-run   # counts only
DATABASE_URL=… pnpm db:reindex -- --project <slug|uuid>             # one project
DATABASE_URL=… pnpm db:reindex -- --all --environment live          # every project, live only
```

`scripts/reindex.ts` has no queue binding, so it does not enqueue
anything. It sets `indexed_at = NULL` and `index_attempts = 0` on the
selected reviews (hidden ones excluded; the pipeline skips them anyway) and
leaves the rest to the pipeline's five-minute re-enqueue sweep
(`workers/pipeline/src/sweep.ts`, #72), which picks up reviews with a null
`indexed_at` older than five minutes, oldest `updated_at` first, 500 per
tick. `indexReview` deletes and re-inserts a review's chunks in one
transaction and the embedding stage sets `indexed_at` again, so the whole
operation is idempotent: running it twice costs a second round of
embeddings and nothing else. The script prints how many reviews it marked
and how long the sweep will take (`ceil(n / 500) × 5` minutes).

While it runs: the old chunks keep serving search until the moment a
review is re-chunked; its new rows then carry NULL embeddings for the
second or so the Workers AI call takes, during which that one review is
absent from results. `GET /v1/reviews` reports `status: "indexing"` for a
marked review until its `indexed_at` is set again, and the project's query
cache generation is bumped when it is. Nothing is deleted. A slug is
unique per account, not globally; the script refuses an ambiguous slug and
asks for the project id.

## Vector search: no HNSW, on purpose

`review_chunks.embedding` is `halfvec(1024)` (bge-m3, half precision) with
**no approximate index**. Every search filters by `(project_id,
environment)` through the btree index and computes exact cosine distance
over that tenant's rows. Tenants are small and numerous: 2,000 reviews is
maybe 4,000 vectors, and an exact scan over 4,000 half-precision vectors is
single-digit milliseconds and always correct. A global HNSW index with a
tenant post-filter is the classic multi-tenant pgvector failure mode where
small tenants get starved, wrong results.

**Revisit when a single tenant exceeds ~50k vectors.** The fix at that point
is a partial HNSW index for that tenant or table partitioning by project,
not a global index. A test in `test/harness.integration.test.ts` fails if
anyone adds an HNSW or IVFFlat index without updating this section.

## Hybrid search

`searchChunks(db, params)` in `src/queries/searchChunks.ts` is the query
behind `POST /v1/query`: one SQL statement that filters `review_chunks` to
`(project_id, environment)`, joins `reviews` on the same tenant predicate
(so the join side is an index scan for the tenant, never a scan of every
tenant's reviews — #111), applies the publication policy
(`hidden_at IS NULL`, `rating >= min_rating`, unrated reviews must not be
`negative`) and the caller's `source` / `since` / `metadata` filters, ranks
by exact cosine similarity and by `ts_rank_cd`, fuses the two with
Reciprocal Rank Fusion (k = 60; pure functions in `src/queries/fusion.ts`),
drops anything under the similarity floor, and keeps the best chunk per
review. Without a query embedding it returns the newest publishable
reviews instead. The module header documents the ranking, the score
normalization, and why there is no vector index.

```ts
const results = await searchChunks(db, {
  projectId,
  environment: "live",
  queryEmbedding: await embedder.embedText(q), // omit for newest-first
  queryText: q,
  limit: 5,
  policy: { minRating: project.minRating, similarityFloor: project.similarityFloor },
  filters: { source: ["google"], metadata: { location: "north" } },
  mode: "excerpts",
});
```

Benchmark (`scripts/bench-search.ts`, not a test): exact scan over 5,000
chunks in one of two equal tenants, hybrid query, limit 5 — **12.4 ms
median, 13.1 ms p95** end to end from Node against the compose Postgres on
an Apple-silicon laptop; 11.9 ms server-side per `EXPLAIN ANALYZE`. That
two-tenant database cannot show costs that scale with the *table*: on the
21-tenant load database (`pnpm load:seed`, 45k reviews) a 2,000-chunk
tenant went from **18.3 ms to 7.4 ms median** (server-side 35.6 → 5.8 ms)
when the `reviews` join gained the tenant predicate (#111), and the no-query
recency statement went from **8.2 ms to 1.0 ms** (50k tenant: 9.7 → 0.8 ms)
when `reviews (project_id, environment, occurred_at DESC NULLS LAST, id)`
turned its Parallel Seq Scan into an index scan that stops after `limit`
rows (#117, migration 0006; that index replaced the plain `(project_id,
environment)` one, which was its prefix). The full before/after for both
is in [`docs/performance.md`](../../docs/performance.md) §2. Re-run both
when the statement changes or a tenant approaches the ~50k-vector line
below (`--explain` prints the hybrid and the recency plans):

```sh
DATABASE_URL=postgres://proofql:proofql@localhost:54323/proofql \
  pnpm --filter @proofql/db exec tsx scripts/bench-search.ts 5000 --explain
# against the load database, one named tenant, no seeding:
pnpm load:seed
DATABASE_URL=postgres://proofql:proofql@localhost:54323/proofql \
  pnpm --filter @proofql/db exec tsx scripts/bench-search.ts --project load-01 --explain
```

## Verbatim slices

A chunk's `text` is always a slice of its parent review:

```
review.text.slice(chunk.startOffset, chunk.startOffset + chunk.text.length) === chunk.text
```

This is what makes "a fabricated quote cannot exist" true. It spans two
tables, so it is not a CHECK constraint; `assertVerbatimSlice` in
`src/chunks.ts` is a pure function the pipeline calls before every chunk
insert, unit-tested in `src/chunks.test.ts` and exercised against the real
schema in `test/schema.integration.test.ts`. Offsets are UTF-16 code units,
the same unit `String.prototype.slice` uses.

## Writing DB tests

Integration tests are `*.integration.test.ts` and run under
`pnpm test:integration` with `DATABASE_URL` set (they fail loudly, never
skip, when it is not). The harness gives every test file its own database:

```ts
import { describe, it, expect } from "vitest";
import { setupTestDb, pgError, UNIQUE_VIOLATION } from "../test/harness.js";
import { project, review, chunk } from "../test/factories.js";

describe("my feature", () => {
  const t = setupTestDb(); // private database for this file; dropped afterward

  it("does the thing", async () => {
    const r = await review(t.db);                 // creates account + project too
    const c = await chunk(t.db, { reviewId: r.id });
    const { code } = await pgError(review(t.db, { ...r, id: undefined }));
    expect(code).toBe(UNIQUE_VIOLATION);
  });
});
```

Other workspaces import the same harness from `@proofql/db/test` (the
pipeline worker does) and point their Vitest integration project's
`globalSetup` at `@proofql/db/test/globalSetup`; see
`workers/pipeline/vitest.config.ts` for the layout.

How it works: `test/globalSetup.ts` builds `proofql_template` once per run
by running the real migrations (skipped when the stored fingerprint of the
migrations folder still matches), and `setupTestDb()` clones it with
`CREATE DATABASE ... TEMPLATE` in milliseconds. Factories in
`test/factories.ts` insert real rows with deterministic, collision-free
defaults and create parents on demand; `chunk()` asserts the verbatim-slice
invariant like the pipeline does. `t.sql` is the raw client for SQL the
query builder cannot express (`<=>`, `@@`).

## Hyperdrive caveats

The defaults in `createDb` exist because of how Hyperdrive pools
connections:

- **Create the client per request in Workers and keep the pool small
  (`max: 5`; the api uses `max: 1`, `connectTimeout: 10`, `idleTimeout: 5`
  — `API_DB_OPTIONS` in `workers/api/src/db.ts`, #108).** Hyperdrive pools
  upstream (20 origin connections on preview) and *queues* above that
  rather than refusing, so a wide client-side pool only hoards pooled
  backends and a long connect timeout only turns a queue into a hung
  request. The api also avoids opening a client at all when KV can answer
  (auth cache + query cache); see `docs/performance.md` §6.
- **`prepare: false`, everywhere.** Named prepared statements bind to one
  pooled backend and break under transaction-mode pooling. Off in Node too,
  so local and production behave identically.
- **Keep transactions short.** A long transaction holds a pooled connection
  hostage.
