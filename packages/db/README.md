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
needs no database.

| Command | What it does |
| --- | --- |
| `pnpm db:generate` | Diff `src/schema` against the last snapshot and emit SQL into `migrations/` |
| `pnpm db:migrate` | Apply pending migrations from `migrations/` to `DATABASE_URL` (`scripts/migrate.ts`, drizzle's migrator; idempotent) |

Local dev: start Postgres (`docker compose up -d`, #11), then
`DATABASE_URL=postgres://proofql:proofql@localhost:54322/proofql pnpm db:migrate`.
Re-running is a no-op.

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
`(project_id, environment)`, joins `reviews`, applies the publication policy
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
chunks in one tenant, hybrid query, limit 5 — **12.1 ms median, 12.4 ms
p95** end to end from Node against the compose Postgres on an Apple-silicon
laptop; 11.8 ms server-side per `EXPLAIN ANALYZE`. Re-run it when a tenant
approaches the ~50k-vector line below:

```sh
DATABASE_URL=postgres://proofql:proofql@localhost:54323/proofql \
  pnpm --filter @proofql/db exec tsx scripts/bench-search.ts 5000 --explain
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
  (`max: 5`).** Hyperdrive pools upstream; a large client-side pool only
  hoards pooled backends.
- **`prepare: false`, everywhere.** Named prepared statements bind to one
  pooled backend and break under transaction-mode pooling. Off in Node too,
  so local and production behave identically.
- **Keep transactions short.** A long transaction holds a pooled connection
  hostage.
