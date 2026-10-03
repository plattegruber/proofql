# Query path performance

Load-test results for `GET /v1/query` (#50, part of #9), the Postgres side
of the exact per-tenant scan (scope.md §2), and what to do about what was
found. The tooling is in [`load/`](../load/README.md); re-run it after any
change to the query route, the search statement, or the cache.

Targets from #50: **warm (KV hit) p95 under 50 ms, cold (miss) p95 under
400 ms**, plus error rate under 0.1 % and no 5xx. The search statement's own
target from #16 is **under 20 ms** for tenants below the ~50k-vector line.

## 1. Local baseline (2026-10-02/03)

Staging is not provisioned yet (#14, owner-gated), so this is the **local**
run: k6 → `wrangler dev` → the docker compose Postgres, all on one laptop.
What that leaves out, and why the staging numbers will differ:

- **No Workers AI.** Locally the embedder is the deterministic fake
  (`embedding_ms` 0–1 ms). On staging every cache miss pays a `bge-m3`
  call, typically tens of milliseconds.
- **No KV network hop.** Miniflare's KV is on-disk SQLite; a HIT's
  `took_ms` is 1 ms here and will be a network round trip there.
- **No Hyperdrive.** The worker connects straight to Postgres with no
  pooler in front, which is what makes §3 below a local artefact in shape
  (but not in substance).
- Everything shares one machine's CPU: k6, workerd, Postgres.

So the numbers below are the floor the staging run cannot beat, and the
right way to read them is "how much of the budget does our own code use".
When staging exists: `BASE_URL=https://… pnpm load:run` with a database
seeded by `DATABASE_URL=… pnpm load:seed -- --force`, and add a column.

### Setup

| | |
|---|---|
| Machine | Apple-silicon laptop (arm64), Docker Desktop |
| Postgres | `pgvector/pgvector:pg16`, defaults: `shared_buffers` 128 MB, `max_connections` 100 |
| Worker | `wrangler dev` 4.145.0 on :8797, fake embedder, Miniflare KV, local rate-limit bindings, per-request `createDb` (`max: 5`) |
| Load tool | k6 v2.3.0, `constant-arrival-rate`, 60 s per scenario |
| Data | `pnpm load:seed`: 20 projects × 1,000 reviews (2,000 chunks each) + 1 project of 25,000 reviews (50,000 chunks); 90,173 `review_chunks` rows, 564 MB with indexes; one paid-plan account; 12 publishable keys per project |
| Requests | `GET /v1/query?key=pq_pk_…&q=…&limit=5` with `Origin: http://localhost:3000`, round-robin over the project's keys; every query returns 5 results |

Commands, in order:

```sh
pnpm run setup                                   # compose Postgres, migrations
pnpm load:seed                                   # 15 s
pnpm --filter @proofql/api exec wrangler dev --port 8797 --inspector-port 9339
K6=~/.local/bin/k6 pnpm load:run                 # warm cold mixed multi large
```

### Results per scenario

End-to-end as k6 sees it (`http_req_duration`, includes the wrangler dev
proxy). All thresholds passed; 0 failed requests, 0 × 5xx, 0 × 429 in every
scenario.

| Scenario | Target rate | Requests | p50 | p95 | p99 | max | Error rate | `x-cache` HIT |
|---|---|---|---|---|---|---|---|---|
| `warm` — 1 project, 12 primed queries | 100 /s | 6,014 | 11.6 ms | **28.1 ms** | 89.7 ms | 169 ms | 0 % | 100.0 % |
| `cold` — 1 project, unique query per request | 50 /s | 3,002 | 32.7 ms | **42.3 ms** | 87.6 ms | 225 ms | 0 % | 0.0 % |
| `mixed` — 1 project, 80/20 primed/unique | 100 /s | 5,981 | 12.3 ms | **79.5 ms** | 813 ms | 1.14 s | 0 % | 80.0 % |
| `multi` — 20 projects round-robin, 80/20 | 100 /s | 6,201 | 13.2 ms | **125.2 ms** | 872 ms | 1.22 s | 0 % | 80.0 % |
| `large` — 50,000-chunk tenant, unique queries | 20 /s | 1,201 | 134.5 ms | **148.2 ms** | 188.4 ms | 312 ms | 0 % | 0.0 % |

Thresholds: warm p95 < 50 ms ✓ (28.1), cold p95 < 400 ms ✓ (42.3), large
p95 < 400 ms ✓ (148.2), error rate < 0.1 % ✓, zero 5xx ✓.

What the worker measured for the same requests (`query.completed` lines,
`docs/observability.md`; percentiles over every line in the scenario's
window):

| Scenario | Lines | HIT `took_ms` p50 / p95 / p99 | MISS `took_ms` p50 / p95 / p99 | MISS `search_ms` p50 / p95 / p99 | `embedding_ms` |
|---|---|---|---|---|---|
| `warm` | 6,001 HIT | 1 / 1 / 4 | — | — | — |
| `cold` | 3,001 MISS | — | 21 / 25 / 38 | 18 / 22 / 31 | 0–1 |
| `mixed` | 4,774 HIT / 1,194 MISS | 1 / 2 / 14 | 19 / 42 / 179 | 18 / 31 / 96 | 0–1 |
| `multi` | 4,768 HIT / 1,192 MISS | 1 / 2 / 14 | 19 / 61 / 150 | 17 / 42 / 96 | 0–1 |
| `large` | 1,200 MISS | — | 119 / 130 / 153 | 117 / 127 / 146 | 0–1 |

Reading the two tables together:

- **A HIT costs ~1 ms inside the handler and ~11 ms end to end.** The gap is
  the per-request Postgres connection the key lookup needs (TCP + SCRAM +
  one SELECT) plus the dev proxy. The cache removes the search from a hit,
  not the database: every request, hit or miss, still opens a connection
  and runs ~4 transactions (key lookup, `last_used_at` refresh, usage
  upsert; `pg_stat_database.xact_commit` grew by 4.0 per warm request and
  6.0 per cold one).
- **A MISS on a 2,000-chunk tenant is ~21 ms in the handler**, of which
  `search_ms` is 18 ms — nearly all of it the one SQL statement, and that
  statement is slower than the 12.8 ms the two-tenant bench reports for a
  tenant 2.5× the size. §2 explains why (it is not the vector scan).
- **The 50,000-chunk tenant is 117 ms of search per miss**, a clean 6× over
  the 20 ms target and the whole of the 134 ms end to end. The exact scan
  is linear; see §2 for where it crosses the line.
- **`mixed` / `multi` were measured on a different day and a busier
  machine**, and it shows. Their medians (12–13 ms) and hit ratios (an
  exact 80.0 %) are what the mix predicts, and their MISS `search_ms` p50
  (17–18 ms) matches `cold`, but their tails are not comparable with the
  rows above: p99 ~0.8 s against ~0.1 s, `hit took_ms` p99 14 ms against
  3 ms, 33–41 dropped iterations, VUs climbing to 83–90. The host was at
  load average ~5.5 with three other worktrees' dev servers running
  (2026-10-03), versus a quiet machine for the first three rows
  (2026-10-02). The thresholds still passed, but read those two p95s as
  "under 400 ms on a contended laptop", not as the cost of the 80/20 mix.
  A third `mixed` run on the same contended host, against a freshly
  started worker, went further and tipped into the connection feedback
  loop of §3 at only 100 req/s (299 × 53300, 5.1 % 5xx, p95 1.7 s) — the
  knee is set by how fast requests complete, not by the arrival rate
  alone. Re-run both on a quiet machine before quoting their tails.
- An earlier `mixed`/`multi` pass reported 90 % and 85 % hit ratios
  instead of 80 %: its "unique" queries reused the iteration counter from
  the `cold` run, and KV keeps entries for 24 h, so half of them were hits.
  The script now salts unique queries with a per-run nonce; the rows above
  are from the corrected run.

## 2. The Postgres side

### The exact scan: where it stops meeting 20 ms

`packages/db/scripts/bench-search.ts` (two tenants of the given size,
hybrid query, limit 5, floor 0.3, 39 warm runs from Node). Same machine,
same day (2026-10-02, before #111); the last three columns are the same
rows re-measured after #111 landed (2026-10-03):

| Chunks per tenant | Hybrid median | Hybrid p95 | Vector-only median | `EXPLAIN ANALYZE` execution | Hybrid median, after #111 | Hybrid p95, after #111 | Vector-only, after #111 |
|---|---|---|---|---|---|---|---|
| 5,000 | 12.8 ms | 13.2 ms | 10.3 ms | 12.8 ms | 12.4 ms | 13.1 ms | 10.1 ms |
| 7,500 | 22.6 ms | 26.0 ms | 17.1 ms | | 17.5 ms | 19.3 ms | 14.2 ms |
| 10,000 | 24.1 ms | 27.1 ms | 19.7 ms | | 23.1 ms | 30.1 ms | 18.1 ms |
| 15,000 | 34.1 ms | 36.6 ms | 27.2 ms | | | | |
| 20,000 | 42.7 ms | 43.6 ms | 34.0 ms | | | | |
| 30,000 | 64.7 ms | 70.8 ms | 52.1 ms | | | | |
| 50,000 | 154.0 ms | 163.6 ms | 130.1 ms | 183.3 ms | | | |

```sh
DATABASE_URL=postgres://proofql:proofql@localhost:54323/proofql \
  pnpm --filter @proofql/db exec tsx scripts/bench-search.ts <chunks> --explain
```

The cost is linear in the tenant's vectors at roughly **2.5–3 ms per 1,000
chunks** (half-precision cosine over 1024 dims, no index), on top of a few
ms of fixed work. Before #111 the hybrid statement crossed 20 ms between
5,000 and 7,500 chunks; with the `reviews` join fixed it **crosses 20 ms
between 7,500 and 10,000 chunks** (about 8,500 by interpolation — i.e.
around 4,000–4,500 reviews), not at 50,000. Even in the two-tenant
database the fix is worth 5 ms at 7,500 chunks, because the old plan hashed
every publishable review of *both* tenants. The 50k line in scope.md §2 is
where the exact scan becomes *untenable* (150 ms+); the 20 ms *target* is
lost an order of magnitude earlier. The free tier's 5,000-review cap is
~10,000 chunks, so a maxed-out free tenant sits at ~23 ms today.

Plans, both sizes (`--explain`): the vector branch and the text branch each
start from `review_chunks_project_id_environment_idx` — a **Bitmap Index
Scan** on the btree, then a Bitmap Heap Scan filtered on `embedding IS NOT
NULL`; the text branch ANDs in `review_chunks_tsv_gin_idx`. At 5,000 chunks
in a 10,000-row table the planner instead chose a Seq Scan for the vector
branch (the tenant *is* half the table), which is the correct call and not a
missing index. Top-N heapsort on the fused score, `LIMIT 5`. No HNSW or
IVFFlat is involved, as designed; the `harness.integration.test.ts` guard
still holds.

### What the two-tenant bench cannot see: the `reviews` join

On the load database (21 tenants, 45,143 reviews, 90,173 chunks) the same
statement for a **2,000-chunk tenant** takes **15.8 ms** warm — slower than
the bench's 5,000-chunk tenant. `EXPLAIN (ANALYZE, BUFFERS)`:

```
Hash Join  (actual time=7.473..15.403 rows=1328 loops=1)
  Hash Cond: (c.review_id = r_1.id)
  ->  Seq Scan on reviews r_1  (actual time=0.018..10.623 rows=30058 loops=1)
        Filter: ((hidden_at IS NULL) AND CASE WHEN (rating IS NULL) THEN … ELSE (rating >= '4') END)
        Rows Removed by Filter: 15085
  ->  Hash  (rows=2000)
        ->  Bitmap Heap Scan on review_chunks c  (actual time=0.034..0.258 rows=2000 loops=1)
              ->  Bitmap Index Scan on review_chunks_project_id_environment_idx  (rows=2000)
Execution Time: 15.842 ms
```

The `candidates` CTE restricts `review_chunks` to the tenant but joins
`reviews r ON r.id = c.review_id` with only the policy predicates on `r`,
so the planner seq-scans and hashes **every publishable review in the
table** (30,058 rows, 10.6 of the 15.8 ms) to serve a tenant with 1,000 of
them. The final result join does the same. The cost grows with the table,
not the tenant — the cross-tenant leak the exact-scan design exists to
avoid, hiding on the other side of the join.

Experiment (2026-10-03, #50 PR) — the rendered statement with `AND
r.project_id = $1 AND r.environment = $2` added to both `reviews` joins, 24
warm runs each:

| Tenant | Current | With tenant predicate on `reviews` | `reviews` access path |
|---|---|---|---|
| 2,000 chunks | **14.7 ms** median (p95 19.5) | **3.9 ms** median (p95 4.1) | Seq Scan 30,058 rows → Bitmap Index Scan on `reviews_project_id_environment_idx`, 664 rows |
| 50,000 chunks | 92.4 ms (p95 94.9) | 95.8 ms (p95 110.8) | unchanged; the vector scan dominates |

3.8× for the small tenant, which is every free tenant. Filed as **#111**.

**Landed (#111, 2026-10-03).** `searchChunks` now carries the tenant
predicate on every `reviews` join (`candidates`, both result joins, and the
recency statement through one shared `tenant()` helper), and
`bench-search.ts --project <slug>` times a named project in an existing
database so the load database can be benched without a clone. Before and
after, back to back on the same (busier than 10-02) host, 39 warm runs:

| Tenant, load database | Before | After #111 | Server-side (`EXPLAIN ANALYZE`) |
|---|---|---|---|
| 2,000 chunks, hybrid | **18.3 ms** median (p95 19.8) | **7.4 ms** median (p95 9.5) | 35.6 → 5.8 ms; `reviews` Seq Scan 30,064 rows (21.1 ms) → Bitmap Index Scan `reviews_project_id_environment_idx` 1,000 rows, 664 after the policy filter |
| 2,000 chunks, vector only | 15.6 ms | 5.1 ms | |
| 2,000 chunks, hybrid + metadata filter | 23.2 ms | 6.0 ms | |
| 2,000 chunks, hybrid, `includeBelowFloor` | 34.6 ms | 8.6 ms | |
| 50,000 chunks, hybrid | 213.5 ms (p95 352.5) | 122.2 ms (p95 204.6) | contended host; the 10-02 experiment above (92 → 96 ms) is the cleaner read: the vector scan dominates |

2.5× for the 2k tenant on this host (3.8× in the quieter experiment). The
text branch and the final result join were already pkey nested loops in
both plans; the Seq Scan was the vector branch's `candidates` CTE alone.
`searchChunks.integration.test.ts` now asserts, with other tenants in the
table, that every `reviews` access in the hybrid plans is an index scan on
a tenant-prefixed btree and never a Seq Scan (the test's data shape is
discussed under #117 below).

Two things measured and **not** changed:

- **A partial index for the policy predicate** — `reviews (project_id,
  environment) WHERE hidden_at IS NULL` — created on the load database and
  benched: 2k tenant 7.4 → 7.2 ms, 50k tenant 122 → 133 ms, both inside
  run-to-run noise. The existing btree already narrows `reviews` to the
  tenant's 1,000 rows and the policy filter on those is microseconds, so no
  migration.
- **The recency (no-query) statement** is 9.5 ms for the 2k tenant on the
  load database and did not move: it already carried the tenant predicate,
  and the planner answers "newest five" with a *Parallel Seq Scan* over the
  whole table plus a top-N sort rather than the tenant index. A
  `(project_id, environment, occurred_at DESC)` index would make it an
  index scan that stops after `limit` rows. Filed as **#117**, landed below.

**Landed (#117, 2026-10-03).** Migration 0006 adds
`reviews_project_id_environment_occurred_at_idx` on `reviews (project_id,
environment, occurred_at DESC NULLS LAST, id)` — the recency statement's
tenant predicate followed by its exact ORDER BY — and drops
`reviews_project_id_environment_idx`, which was that index's prefix. Before
and after, back to back on the same host, `bench-search.ts --project`, 39
warm runs:

| Tenant, load database | Before | After #117 | `reviews` access path (`EXPLAIN (ANALYZE, BUFFERS)`) |
|---|---|---|---|
| 2,000 chunks, no query (recency) | **8.2 ms** median (p95 9.2) | **1.0 ms** median (p95 1.3) | Parallel Seq Scan, 2 workers, 44,598 rows removed by filter, top-N sort, 4,311 buffers → Index Scan on the new index, 5 rows, 30 buffers; server-side 0.03 ms warm |
| 50,000 chunks, no query (recency) | **9.7 ms** median (p95 10.5) | **0.8 ms** median (p95 0.9) | same shape; Index Scan stops after 17 rows (12 fail the policy filter) |
| 2,000 chunks, hybrid | 6.7 ms (p95 11.6) | 6.3 ms (p95 8.8) | `candidates` still a Bitmap Index Scan, now on the new index (1,000 rows, 664 after the policy filter); unchanged, as it should be |
| 50,000 chunks, hybrid | 120.2 ms (p95 135.5) | 121.5 ms (p95 128.1) | unchanged; the vector scan dominates |

8× for the small tenant, 12× for the large one, and the cost no longer
grows with the table: the old plan read every page of `reviews` (4,200
buffers) for any tenant; the new one reads the index pages for the tenant's
newest rows and stops. Recency is now the cheapest statement in the module,
where before #117 it was slower than the hybrid search for the same tenant.

Measured and decided along the way:

- **Partial on `hidden_at IS NULL`?** No. Created both variants on the load
  database: recency was 0.8 ms under either, and the partial index can no
  longer serve the CRUD and dashboard list routes' "hidden only" filter
  (they fell back to a bitmap scan on the upsert key's unique index). The
  policy predicate on the rows the index scan visits is microseconds, as the
  #111 partial-index experiment above already showed.
- **Drop `reviews_project_id_environment_idx`?** Yes, in the same migration
  (create first, drop second). Every query that used it — the search
  statements' joins, `GET /v1/reviews` and the dashboard review browser
  (equality on the tenant, ordered by a `date_trunc` expression the old
  index could not serve either), the onboarding and import counts, the
  pipeline's per-review lookups — is an equality lookup on `(project_id,
  environment)`, which is the new index's prefix, and `EXPLAIN` on the load
  database with the old index dropped shows each of them on the new index
  (list shape 1.1 ms, count 0.35 ms). The `(project_id, environment,
  source, external_id)` unique index carries the same prefix too, so
  `reviews` keeps two tenant-prefixed btrees rather than three.
- **The plan-shape test's data.** With four equal tenants of 500 reviews in a
  47-page table, dropping the narrower index flipped the hybrid plans'
  `reviews` access from a bitmap scan to a Seq Scan: a bitmap heap scan is
  costed as touching every page once a tenant has more rows than the table
  has pages, so the seq-scan/index-scan call there came down to six index
  pages — not a property of the statement. The test now pads the table with
  twenty 1,000-review tenants (reviews only, one `generate_series` insert
  each; 20,500 rows, the tenant ~2.5 % like `load-01`), where an index is
  decisively cheaper and a Seq Scan means the statement lost its predicate
  or its index. It runs faster than before (0.4 s vs 0.7 s) and additionally
  asserts the recency plan: Index Scan on the new index, no sort on
  `occurred_at`, no `Gather Merge`.

Still to do after #111: re-run `pnpm load:run cold` on a quiet machine and
refresh the §1 `cold` row; the expectation is `search_ms` p50 around
5–8 ms for 2k-chunk tenants.

### Large tenant on the load database

Warm `EXPLAIN (ANALYZE, BUFFERS)` for the 50,000-chunk tenant: **147 ms**,
`Seq Scan on review_chunks` (50,000 of 90,173 rows — again the planner's
correct choice at 55 % of the table; in a database with thousands of
tenants it would be the bitmap scan the bench shows), 31,913 rows removed
by the similarity floor, two seq scans of `reviews` (25.7 ms + 11.6 ms) for
the join above. Under k6 at 20 req/s the same statement was `search_ms`
p50 117 / p95 127 ms — concurrency did not degrade it; Postgres had the
cores.

## 3. Connections under load

The api opens one postgres-js client per request (`workers/api/src/db.ts`;
`createDb` → `max: 5`, `prepare: false`) and ends it after the response.
Measured with `pg_stat_database.sessions` before and after each scenario
(`load/run.sh` prints the delta) and a 0.3 s `pg_stat_activity` sampler
during the probe runs:

| Run | Requests | Sessions opened | Sessions / request | Peak client backends | 5xx |
|---|---|---|---|---|---|
| `warm` 100 /s | 6,014 | 6,067 | 1.01 | not sampled (48 at 150 /s, so below that) | 0 |
| `cold` 50 /s | 3,002 | 3,044 | 1.01 | | 0 |
| `large` 20 /s | 1,201 | 1,243 | 1.03 | | 0 |
| `warm` **150 /s** (30 s probe) | 4,471 | | | 48 sampled (spikes missed) | 16 (0.36 %); p95 146 ms, p99 902 ms |
| `warm` **200 /s** (30 s probe) | 5,565 | | | 98 | 1,898 (34 %); p50 545 ms |
| `warm` **300 /s** (30 s probe) | 7,676 | | | 95 | 6,563 (85 %); p50 2.1 s |
| `mixed` 100 /s, **contended host** (load avg ~5.5) | 5,837 | 5,602 | 0.96 | not sampled | 299 (5.1 %); p95 1.7 s |

So: **~1 connection per request, and the pool's `max: 5` is never
reached** — no statement on the hot path runs concurrently with another;
the only overlap is the post-response `waitUntil` work (usage upsert,
`last_used_at`, `sql.end()`), which is where the extra 1–3 % comes from.

**Connections exhaust between 100 and 150 requests/s per worker process on
a quiet machine — and at 100 /s on a busy one.** At 100 /s the quiet run is
clean; the same scenario on a host at load average ~5.5 produced 5 % 53300. At 150 /s the first `sorry, too many clients
already` (SQLSTATE 53300) appears; at 200 /s a third of requests fail. Every
failure is the **key lookup** in `requireApiKey` (9,774 of 9,811
`request.failed` lines; the other 37 are the quota read), surfaced as
**500 `internal`**, never the search itself. The mechanism is a feedback
loop: more in-flight requests → more connections → slower requests → more
in flight, until `max_connections` (100, minus reserved) refuses new ones.
A cache HIT does not help, because a HIT still needs the connection for
auth.

In preview/prod the client goes through Hyperdrive, which pools upstream
and *queues* rather than refusing, so the failure should change shape into
queueing latency — but Hyperdrive's origin connection limit and Neon's
compute-size `max_connections` move the ceiling rather than remove it.
Filed as **#108** with the numbers; the decision (503 + `Retry-After`
instead of 500, `max: 1`, serving the key lookup without a database
connection) waits for a staging measurement. Not fixed here.

## 4. Recommendations

1. **Fix the `reviews` join first (#111) — done.** It was the only finding
   that affected every tenant, it was a two-line SQL change, and it was
   worth more to the free tier than any index: 14.7 → 3.9 ms (18.3 → 7.4 ms
   on a busier host) for a 2k-chunk tenant. The recency statement's own
   table scan was the follow-up (#117, done): a `(project_id, environment,
   occurred_at DESC NULLS LAST, id)` index, 8.2 → 1.0 ms.
2. **Per-tenant partial HNSW index: not yet, and not at 50k.** The exact
   scan is ~2.5–3 ms per 1,000 chunks. With #111 in, the 20 ms `search_ms`
   target holds to roughly 8,500 chunks (~4,000 reviews); the free cap
   (5,000 reviews ≈ 10,000 chunks) lands around 15–20 ms; a paid tenant at
   50,000 chunks is ~120 ms and at 100,000 reviews (the paid cap, ~200,000
   chunks) would be ~500 ms. The trigger for a partial index
   (`CREATE INDEX … USING hnsw (embedding halfvec_cosine_ops) WHERE
   project_id = …`) should therefore be a **`search_ms` p50 above ~50 ms
   for one `project_id`** in the `query.completed` logs, which with the
   current statement is about 15,000–20,000 chunks — not the 50k in scope.md
   §2, which should be read as "where the exact scan is unacceptable", not
   "where to start thinking". A partial HNSW index keeps the tenant filter
   as the index predicate, so the multi-tenant post-filter failure mode
   does not apply. Build it with the tenant's own `ef_search` in mind; it is
   an operational step, not a schema change for every tenant.
3. **KV TTL (24 h): leave it.** With queries primed, the hit ratio is 100 %
   at steady state and the 80/20 scenarios land exactly where their mix
   says, so the TTL is not what bounds the hit ratio — the query vocabulary
   is. Invalidation is already generation-based, so a longer TTL would buy
   nothing and a shorter one would only add misses. Revisit if staging
   shows the KV read itself (not the TTL) dominating `took_ms` on hits.
4. **The cache hit is not free of the database.** A HIT is 1 connection
   and 4 transactions; under connection pressure a 100 % hit ratio still
   fails at the same rate as a 0 % one (§3). Serving the key lookup from a
   cache (and batching `last_used_at` / usage) would make a HIT genuinely
   database-free, which is the only change that moves the §3 ceiling
   without touching Postgres. Tracked in #108.
5. **Re-run on staging** (#14) and add a column: the two numbers to watch
   are the Workers AI share of `took_ms` on misses and whether 53300 ever
   surfaces behind Hyperdrive.

## Appendix: raw k6 output

`pnpm load:run` leaves `load/results/<scenario>.txt` (k6's summary),
`<scenario>.summary.json`, and the Postgres snapshots; they are gitignored.
The figures above are from the files produced on 2026-10-02 (`warm`,
`cold`, `large`, the bench) and 2026-10-03 (connection probes, the
corrected `mixed`/`multi` run, the load-database `EXPLAIN`s).
