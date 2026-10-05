# Query path performance

Load-test results for `GET /v1/query` (#50, part of #9), the Postgres side
of the exact per-tenant scan (scope.md §2), and what to do about what was
found. The tooling is in [`load/`](../load/README.md); re-run it after any
change to the query route, the search statement, or the cache.

Targets from #50: **warm (KV hit) p95 under 50 ms, cold (miss) p95 under
400 ms**, plus error rate under 0.1 % and no 5xx. The search statement's own
target from #16 is **under 20 ms** for tenants below the ~50k-vector line.

## 1. Local baseline (2026-10-02/03)

Staging was not provisioned when this was measured (#14, owner-gated), so
this is the **local** run: k6 → `wrangler dev` → the docker compose
Postgres, all on one laptop. The first numbers from real infrastructure —
single requests, not a load test — are in §5.
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

### Sentence chunks (#127): chunks per review, and where the 20 ms line lands

#127 made the chunker emit one `sentence` chunk per sentence for every
review of two or more sentences, on top of the `full` chunk and the
3-sentence `window`s, so a highlight can narrow to the one sentence that
answered. The exact scan is linear in *chunks*, so the question is how many
chunks a review now is. Measured on the demo corpus (seed v5, 2026-10-04;
`pnpm seed` then `bench-search.ts --project de300000-…-000000000002`, the
demo project's id — the slug is shared with the dashboard's local stub):

| Demo corpus (80 live reviews; ~60 % one to two sentences, ~30 % three to five, ~10 % long) | Before #127 | After #127 |
|---|---|---|
| Chunks | 80 full + 28 window = **108** | 80 full + 28 window + 218 sentence = **326** |
| Chunks per review | **1.35** | **4.08** (3.0×) |
| Texts embedded per review (Workers AI inputs) | 1.35 | 4.08 |
| Workers AI *calls* per review | 1 | 1 — `embedChunks` sends a review's chunks in batches of 50 (`EMBEDDING_BATCH_SIZE`), so a review needs ~49 sentences before it costs a second call |
| Hybrid search, 326-chunk tenant in the 90k-chunk load table | — | 4.6 ms median, p95 8.3 ms (contended host) |
| Hybrid search, `load-01` (2,000 fixed chunks), same run | 6.3–7.4 ms (#111/#117 rows above) | 6.7 ms median, p95 8.9 ms — unchanged, as it must be: no statement changed |

The load seed is unaffected by #127 — it writes two fixed chunks per review
(`full` + a first-sentence `window`), not `chunkReview`'s output — so its
tenants still have 2,000 and 50,000 chunks and the per-1,000-chunk cost is
what the tables above say. The conversion to reviews changed:

| At the 20 ms line (~8,500 chunks, hybrid, after #111) | Chunks per review | Implied reviews per tenant |
|---|---|---|
| Load seed's fixed shape (the figure the earlier sections quote) | 2.0 | ~4,250 |
| Demo corpus, before #127 | 1.35 | ~6,300 |
| **Demo corpus, after #127** | **4.08** | **~2,100** |

So on the demo mix the 20 ms `search_ms` target now holds to roughly
**2,100 reviews**, and a maxed-out free tenant (5,000 reviews ≈ 20,400
chunks) lands around **50–60 ms** by the 2.5–3 ms per 1,000 chunks slope,
not the 15–20 ms recommendation 2 quotes — which is also where the partial
HNSW trigger (`search_ms` p50 above ~50 ms, 15,000–20,000 chunks) now sits:
**~3,700–4,900 reviews** rather than 7,500–10,000. The 20 ms line does not
clear the free cap for a corpus shaped like the demo's. Two caveats before
acting on that: the demo corpus is written to exercise the chunker (a tenth
of it is long multi-topic reviews), and real Google corpora skew shorter
(a large share are one sentence, which stays a single `full` chunk), so
the real ratio is likely between 1.35 and 4.08 — read it off
`review.indexed` lines (`chunks` per review) once real tenants are
indexing. If a real tenant does approach the line, the knobs are, in order:
drop the `window` chunks where sentence chunks already cover them (windows
are now partly redundant; `sentenceChunks`/`minSentencesForWindows` in
`chunkReview` make this a one-line policy change plus a re-index), then the
per-tenant partial HNSW index of recommendation 2. Existing projects keep
their pre-#127 chunks until re-indexed (`pnpm db:reindex`,
`packages/db/README.md` "Re-indexing"), so the ratio only changes for a
tenant when that runs.

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
Filed as **#108** with the numbers. Measured on preview and fixed in §6:
behind Hyperdrive the failure is queueing rather than 53300, and the fix
made cache HITs database-free (KV auth cache, batched usage), set
`max: 1`, and mapped connection failures to 503.

## 4. Recommendations

1. **Fix the `reviews` join first (#111) — done.** It was the only finding
   that affected every tenant, it was a two-line SQL change, and it was
   worth more to the free tier than any index: 14.7 → 3.9 ms (18.3 → 7.4 ms
   on a busier host) for a 2k-chunk tenant. The recency statement's own
   table scan was the follow-up (#117, done): a `(project_id, environment,
   occurred_at DESC NULLS LAST, id)` index, 8.2 → 1.0 ms.
2. **Per-tenant partial HNSW index: not yet, and not at 50k.** The exact
   scan is ~2.5–3 ms per 1,000 chunks. With #111 in, the 20 ms `search_ms`
   target holds to roughly 8,500 chunks — ~4,000 reviews at the load seed's
   two chunks per review, but only **~2,100 reviews at the ~4 chunks per
   review the #127 sentence chunker produces on the demo corpus** (§2
   "Sentence chunks"); the free cap (5,000 reviews) is ~10,000 chunks and
   15–20 ms at two per review, ~20,000 chunks and 50–60 ms at four; a paid
   tenant at 50,000 chunks is ~120 ms and at 100,000 reviews (the paid cap,
   200,000–400,000 chunks) would be 0.5–1 s. The trigger for a partial index
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
   without touching Postgres. Done in #108 (§6).
5. **Re-run on staging** (#14) and add a column (done on preview, §6): the two numbers to watch
   are the Workers AI share of `took_ms` on misses and whether 53300 ever
   surfaces behind Hyperdrive.

## 5. Preview baseline (2026-10-04)

The first numbers from the real stack — Workers AI `bge-m3`, Workers KV,
Hyperdrive in front of the Neon preview branch — come from
[`scripts/demo.sh`](../scripts/demo.sh) (`pnpm demo`, #31), the M1 exit:
one run, single requests from a laptop, so these are **points, not
percentiles**; the k6 scenarios of §1 have not been run against preview yet
(they have since been, in §6). Same script, same morning, against
the local stack for the pairing.

| | Local (`wrangler dev`, fake embedder) | Preview (Workers AI, KV, Hyperdrive → Neon) |
|---|---|---|
| Cold query `took_ms` (MISS, embed + search) | 29 ms | **391 ms** |
| Cache HIT `took_ms` | 1 ms | **6 ms** |
| Ingest → all 6 `indexed` | 6.5 s | **17.1 s** |
| `POST /v1/reviews` (6 reviews), end to end | 138 ms | 1,038 ms |
| 6 × `DELETE` + 6 × `GET` (404), end to end | 467 ms | 5,530 ms |

Reading it:

- **The cold query is the number to watch: 391 ms against a 400 ms p95
  target.** Locally the same request is 29 ms, and the search statement on
  an 80-review tenant is single-digit milliseconds, so almost all of the
  preview figure is the Workers AI embedding call plus the Hyperdrive round
  trips — exactly the two shares §1 said staging would reveal. A dozen
  probe queries during the same session landed between 204 and 533 ms
  `took_ms`, so the embedding latency is also the variance. Before quoting a
  prod number, run `pnpm load:run cold` against preview and read
  `embedding_ms` from the `query.completed` lines; if it is the bulk, the
  options are a smaller embedding model for queries, or caching query
  vectors by normalized `q` (misses on a *new phrasing* still pay, repeats
  of a phrasing with a purged result cache would not).
- **A HIT is 6 ms in the handler** (1 ms locally): the KV read is a real
  network hop now, and still ~65× cheaper than the miss. The cache is doing
  its job; the 24 h TTL / generation-purge design (§4.3) needs no change.
- **Ingest → indexed is 17 s** for a batch of six, against 6.5 s locally.
  That is queue delivery plus one `bge-m3` call per chunk on the pipeline
  side, well inside the "seconds" the API promises, but the onboarding
  meter (`Indexed N of N`) should expect tens of seconds, not single
  digits, on a real batch.
- **Management calls are ~0.5–1 s each on preview** (the 6 deletes + 6
  gets took 5.5 s): per-request Postgres connection through Hyperdrive plus
  the cache purge. Fine for the dashboard; a reason to keep ingest batched
  (one call per 100 reviews, as the API allows), not per review.
- One finding on the way here is about relevance, not speed: with real
  embeddings the default **0.55 floor is close to bge-m3's baseline for
  unrelated short sentences.** A query phrased like a clinic complaint but
  about nothing in the corpus ("the lobby coffee kiosk swallowed my coins")
  scored 0.55–0.60 against unrelated dental reviews ("knocked out half a
  front tooth playing pickup basketball" at 0.579) and came back as
  `match: "query"`; only a genuinely off-domain phrasing ("guest wifi
  password router kept dropping", "roofing shingles") produced the
  `match: "none"` the script asserts. The script was changed to use the
  off-domain topic; the floor itself (`similarity_floor`, per project) is
  worth re-tuning on real embeddings with the relevance fixtures before
  launch — that is a separate issue, not a §4 recommendation about the
  query path. Done in #138: see "The floor on real embeddings" below; the
  default is now 0.66 and the script's "none" query is back to the kiosk.

### The floor on real embeddings (#138, 2026-10-05)

`pnpm db:tune-floor` ran the 59 labelled fixtures
(`packages/db/src/seed/fixtures/relevance.ts`: 35 answerable, 17 in-domain
with no answer, 5 whose only answers are policy-hidden, 2 cross-language
probes reported separately) against the preview api with the demo
project's floor lowered to 0.30 for the run and restored after. Raw scores:
[`docs/floor-tuning/2026-10-05.json`](floor-tuning/2026-10-05.json);
`pnpm db:tune-floor -- --replay docs/floor-tuning/2026-10-05.json`
reprints the full 0.50–0.80 table.

| Floor | Precision (pooled) | Recall (pooled) | Answerable queries answered | Must-be-empty queries with a row |
|---|---|---|---|---|
| 0.50 | 23.5% | 80.4% | 100.0% | 95.5% (21/22) |
| 0.55 | 29.7% | 66.2% | 97.1% | 63.6% (14/22) |
| 0.60 | 48.7% | 50.0% | 91.4% | 45.5% (10/22) |
| 0.63 | 57.8% | 39.9% | 77.1% | 22.7% (5/22) |
| 0.65 | 60.6% | 27.0% | 68.6% | 13.6% (3/22) |
| **0.66** | **67.3%** | **23.6%** | **65.7%** | **0.0% (0/22)** |
| 0.70 | 69.6% | 10.8% | 37.1% | 0.0% |
| 0.75 | 100.0% | 6.8% | 28.6% | 0.0% |

| Cosine | n | p10 | p50 | p90 | max |
|---|---|---|---|---|---|
| Expected reviews, answerable queries | 120 | 0.527 | 0.624 | 0.734 | 0.830 |
| Unrelated reviews, answerable queries | 505 | 0.465 | 0.546 | 0.618 | 0.745 |
| Best row per must-be-empty query | 22 | 0.503 | 0.589 | 0.651 | 0.654 |

Reading it:

- **The targets conflict.** Negatives' false-positive rate ≤ 5% first holds
  at 0.66; pooled recall ≥ 90% holds nowhere in range (80% at 0.50). The
  default is the lowest floor under the false-positive cap, 0.66, because
  "empty beats irrelevant" is the product's first quality property
  (scope.md §1). Pooled recall overstates the cost — a snippet shows ~3
  quotes, not every matching review — so the per-page number is the one to
  read: two thirds of answerable pages still get a genuine answer.
- **Short queries pay.** 11 of 35 answerable queries are empty at 0.66,
  mostly one- or two-word topics ("dental implants" best 0.655,
  "Invisalign" 0.649, "veneers" 0.633, "root canal" 0.637). bge-m3 scores
  a bare keyword lower against a sentence than a phrase. Pages should
  query with a phrase, and `fallback=recent` exists for the rest.
- **The worst in-domain negatives sit at 0.64–0.65**: "charging station
  for electric cars in the lot" (0.654), "they lost my appointment and I
  drove home" (0.652, policy-filtered: only a 2-star answers it), "the
  appointment ran so late my child had a meltdown" (0.651), "the next
  emergency slot was nine days away" (0.641). A floor of 0.63 would show a
  five-star review under each of those headings.
- **One global cosine floor is near its limit here.** Positive and
  negative score bands overlap by ~0.1. If the empty rate on real traffic
  (`query.completed`, docs/observability.md) is too high at 0.66, the next
  lever is not a lower floor but a better separator (a reranker, or a
  floor relative to the query's own score distribution), measured with the
  same fixtures.

### Two tiers: word matches pass lower (#138 follow-up)

The flat 0.66 blanked "Invisalign", "veneers", and "root canal", short
queries that *literally* match reviews. The two-tier rule keeps the flat
floor and adds one predicate: a chunk also passes at a lower tier when the
hybrid search's full-text branch matched it (`tsv @@
websearch_to_tsquery('english', q)`). Measured offline on a second scratch
run that records each returned excerpt's chunk
([`docs/floor-tuning/2026-10-05-chunks.json`](floor-tuning/2026-10-05-chunks.json),
same 59 queries, identical flat curve), annotated against the preview
database (`--annotate`), grid-searched with `--replay … --two-tier` over
high 0.62–0.70 × low 0.50–0.60:

| | Answerable queries answered | Empty positives | Must-be-empty with a row | Precision | Recall |
|---|---|---|---|---|---|
| Flat 0.66 | 65.7% (23/35) | 11 | 0.0% (0/22) | 67.3% | 23.6% |
| **High 0.66, low 0.53** | **77.1% (27/35)** | **7** | **0.0% (0/22)** | **73.4%** | **31.8%** |
| High 0.65, any low | 80.0% (28/35) | — | 13.6% (3/22) | — | — |

- **Every one of the 21 lexical candidates was a labelled answer**, and
  none of the 22 must-be-empty queries produced one. That is why the low
  tier is free here: it only admits rows the full-text branch vouches for.
- **The low tier is flat from 0.50 to 0.60** (27/35 at every value with
  high 0.66): the lexical rows' lowest similarity is 0.539, so the value
  only matters below it. Shipped as a fixed offset from the project floor
  (`LEXICAL_FLOOR_OFFSET = 0.13`, 0.53 at the default) rather than a second
  column, so a project that tunes its floor moves both tiers and owners
  keep one knob.
- **Recovered**: p04 "Invisalign", p21 "no surprise bills", p24 "veneers",
  p26 "root canal". **Still empty**: p01 "dental implants" (websearch
  ANDs the terms and the implant reviews never say "dental"), p35 "wisdom
  teeth removal" (the answer says "extractions"), and the paraphrases with
  no shared words (p05, p06, p09, p10).
- **Caveat**: the search collapses each review to its best chunk by fused
  rank, so a scratch run sees one chunk per review; a sibling chunk can
  admit a review the replay misses. The live validation below, at the
  shipped setting, is the exact number.

**Live validation** (preview, 2026-10-05 00:30–00:33 UTC, the demo project
at its real floor 0.66, no scratch floor, `Cache-Control: no-cache`): the
flat api, then this branch's api deployed by hand
(`wrangler deploy --env preview` from `workers/api`), same 59 queries.
Raw: [`2026-10-05-live-flat-0.66.json`](floor-tuning/2026-10-05-live-flat-0.66.json),
[`2026-10-05-live-two-tier.json`](floor-tuning/2026-10-05-live-two-tier.json).

| Live, floor 0.66 | Answered | Top-3 clean | Empty positives | Must-be-empty with a row | Precision | Recall |
|---|---|---|---|---|---|---|
| Flat (before) | 65.7% (23/35) | 21/35 | 11 | 0.0% (0/22) | 67.9% | 24.3% |
| Two-tier, word match 0.53 (after) | **77.1% (27/35)** | **25/35** | **7** | **0.0% (0/22)** | **73.4%** | **31.8%** |

The live numbers equal the offline grid's (the flat run finds one more
expected review than the replay, through a sibling chunk); the per-query
diff is exactly p04, p21, p24, p26 answered, nothing else changed, no
must-be-empty query returned anything. `scripts/demo.sh` passed 8/8 on the
two-tier api (kiosk query `match: none`).

### Partial word matches (#147)

`websearch_to_tsquery` requires every term, so "dental implants" stayed
empty: no implant review says "dental". The floor's word-match test is now
its own expression (`lexicalMatchSql`, `packages/db/src/queries/lexicalMatch.ts`);
the full-text *ranking* branch is unchanged. Three rules were measured
offline by re-annotating the scratch run
([`2026-10-05-chunks.json`](floor-tuning/2026-10-05-chunks.json); its
saved chunk ids let any rule be applied against the preview database
without api traffic) with `pnpm db:tune-floor -- --annotate <copy>
--lexical-rule <rule>`, then replayed at the shipped tiers, high 0.66 /
low 0.53. "Content words" are the query's English-config lexemes (stop
words dropped, stemmed like the corpus); every rule also accepts the
every-term match, so each is a superset of `all`.

| Rule (0.66 / 0.53) | Lexical rows | Answered | Top-3 clean | Must-be-empty with a row | Precision | Recall | Changes among p01, p35, p05, p06, p09, p10, p19 |
|---|---|---|---|---|---|---|---|
| `all` (every term; #146) | 21 | 77.1% (27/35) | 25/35 | 0.0% (0/22) | 73.4% | 31.8% | none answered |
| `any` content word | 318 | 91.4% (32/35) | 16/35 | **50.0% (11/22)** | 44.8% | 61.5% | p01, p05, p09, p10, p19 |
| `half` (≥ half of content words) | 101 | 82.9% (29/35) | 23/35 | 4.5% (1/22) | 66.3% | 46.6% | p01, p19 |
| **`half-specific`** (≥ half, ignoring "dental dentist teeth review office") | 97 | **85.7% (30/35)** | **25/35** | **4.5% (1/22)** | 69.8% | **50.0%** | **p01, p10, p19** |

- **Chosen: `half-specific`** (`LEXICAL_RULE` and `GENERIC_QUERY_WORDS` in
  `@proofql/core`): the most answered queries with the must-be-empty rate
  under the 5% cap, and top-3 clean unchanged at 25/35. A query made only of
  generic words gets no partial credit. `any` fails outright: "the office
  dog greets patients" alone returns ten reviews.
- **The cost is one must-be-empty query**: n09 "vending machine in the
  waiting room" now shows g09 at 0.580, which mentions the waiting room
  (2 of 4 content words). Precision falls 73.4% → 69.8%; pooled recall
  rises 31.8% → 50.0%. A partial match only at a higher lexical tier
  (≥ 0.58) would keep 0/22 at 29/35, but that is a third tier for one
  query; the fixed offset stays.
- **Statement cost**: the coverage test runs per row of the vector
  branch, which is only the rows at or above the lexical floor by default.
  `scripts/bench-search.ts` (5,000-chunk tenant, local Docker Postgres, two
  interleaved runs each): hybrid median 13.1 / 13.2 ms on `main` → 14.1 /
  14.1 ms here (+0.9 ms); the playground's `includeBelowFloor` variant,
  which tests every chunk, 16.1 / 16.3 → 21.7 / 21.2 ms. Vector-only and
  no-query are unchanged.
- **Unchanged**: p35 "wisdom teeth removal" (the answer says
  "extractions", and "teeth" is generic), and the paraphrases p05, p06,
  p09 share no specific word with their answers.

**Live validation** (preview, 2026-10-05 00:48 UTC, demo project at 0.66,
`Cache-Control: no-cache`, this branch's api deployed by hand with
`wrangler deploy --env preview` from `workers/api`, version `ad8ea48a`):
[`2026-10-05-live-partial-match.json`](floor-tuning/2026-10-05-live-partial-match.json).

| Live, floor 0.66 / 0.53 | Answered | Top-3 clean | Empty positives | Must-be-empty with a row | Precision | Recall |
|---|---|---|---|---|---|---|
| Every term (#146) | 77.1% (27/35) | 25/35 | 7 | 0.0% (0/22) | 73.4% | 31.8% |
| Half the specific words, as collected | 82.9% (29/35) | 24/35 | 5 | 4.5% (1/22) | 66.3% | 45.3% |

- Gained p10 and p19, lost nothing; the leak is n09, as predicted (two
  rows live, g09 0.580 and g41 0.551 through a sibling chunk).
- **p01 came back empty in the run, an artefact of the deploy**: it was
  the first query, sent seconds after `wrangler deploy`, and was served by
  the previous version (629 ms, the run's slowest). One spot check after
  the run (`q=dental implants`, `no-cache`) returned the six implant
  excerpts the replay predicts (0.655 / 0.648 / 0.637 / 0.613 / 0.595 /
  0.561, top three all labelled answers). With p01 counted, the live
  result is 30/35 answered and 25/35 top-3 clean, matching the replay.
  The run was not repeated: the free plan allows two live collections and
  the second went to the reranker.

### Reranker (#147): measured, off

`RERANK=true` (a worker var, unset everywhere by default) fetches the top
20 reviews by fused rank with the cosine floor off, scores each one's best
excerpt with Workers AI `@cf/baai/bge-reranker-base`, and gates on the
reranker score instead of the floor (`workers/api/src/query/rerank.ts`);
if the call fails the candidates are held to the two-tier floor. Measured
with one collection against preview deployed with
`--var RERANK:true --var RERANK_THRESHOLD:0` (every candidate back with
its score in `x-rerank-scores`; version `1dbc6787`), swept offline with
`pnpm db:tune-floor -- --replay … --rerank`:
[`2026-10-05-live-rerank.json`](floor-tuning/2026-10-05-live-rerank.json).

| Reranker threshold | Answered | Top-3 clean | Must-be-empty with a row | Precision | Recall |
|---|---|---|---|---|---|
| 0.05 | 85.7% (30/35) | 11/35 | 31.8% (7/22) | 41.9% | 41.9% |
| 0.20 | 68.6% (24/35) | 12/35 | 18.2% (4/22) | 51.8% | 29.7% |
| 0.50 | 51.4% (18/35) | 13/35 | 18.2% (4/22) | 63.8% | 20.3% |
| **0.85** (lowest with FP ≤ 5%) | **28.6% (10/35)** | 9/35 | 4.5% (1/22) | 71.4% | 10.1% |
| Two-tier floor, half the specific words (for comparison) | 85.7% (30/35) | 25/35 | 4.5% (1/22) | 69.8% | 50.0% |

- **It does not separate better than cosine here.** n01 "orthodontic
  headgear" scores 0.92 on an anxiety review; "veneers" tops out at 0.11
  on the veneer review. The excerpts are short sentence chunks, and the
  paraphrase misses stay missed: the best labelled answer scores 0.29 for
  p05, 0.003 for p06, 0.006 for p09, 0.10 for p10, 0.07 for p19, below
  unrelated rows in the same query.
- **Latency**: the reranker call adds p50 213 ms, p95 856 ms, max 1,298 ms
  (n = 59). End to end `took_ms` went from p50 294 / p95 629 ms (the
  partial-match run, same day) to p50 579 / p95 1,159 ms, which also
  includes the floorless candidate search.
- **Cost**: about 474 input tokens per query (20 × (query + excerpt),
  estimated at 4 characters per token from `x-rerank-chars`), so ~0.13
  neurons per uncached query at 283 neurons per M tokens (Workers AI
  pricing page; $0.011 per 1,000 neurons beyond the 10,000 free per day).
  Cheap: the free allocation covers ~75,000 reranked queries a day. Cost is
  not the problem.
- **Recommendation: off, on the free tier and on paid.** It adds 0.2–0.9 s
  to every uncached query and is worse than the two-tier floor at every
  threshold that keeps must-be-empty queries empty. It is not worth a paid
  tier either. The code stays behind the flag (default threshold 0.85) so
  a better cross-encoder, or reranking whole reviews rather than sentence
  chunks, can be measured with the same command.

### Transcripts

Local (`pnpm run setup && pnpm dev`, keys from the seed output):

```
[demo] http://localhost:8797 · origin http://localhost:3000 · reviews demo-1791145905-1…6
[1/8] GET /health                                              PASS     61 ms  ok, x-request-id d8fe875e-a09b-4dd0-8a82-c84ff7f2f799
[2/8] POST /v1/reviews (6 reviews, demo-1791145905-n)          PASS    138 ms  stored 6: indexing, indexing, indexing, indexing, indexing, indexing
[3/8] GET /v1/reviews?source=custom until 6/6 indexed          PASS   7562 ms  6/6 indexed after 6.5s
[4/8] GET /v1/query (publishable key + Origin) ×3             PASS    375 ms  a: 1 result(s), top=review 1 score 0.845 took_ms 29 · b: match none, results [] · c: match fallback, 5 labelled row(s)
[5/8] GET /v1/query (repeat a) → x-cache: HIT                PASS    127 ms  HIT, took_ms 1
[6/8] GET /v1/query (a, include=text) → highlights           PASS    119 ms  1 result(s), every text.slice(highlight.start, highlight.end) === excerpt
[7/8] PATCH /v1/reviews/{review 1} hidden → gone from a      PASS    190 ms  hidden; MISS, match none, 0 result(s), review 1 absent
[8/8] DELETE /v1/reviews/{id} ×6 → 204, GET → 404         PASS    467 ms  6 deleted, 6 × 404
demo: 8/8 steps passed in 9s against http://localhost:8797 — cold query 29 ms, cache HIT 1 ms, ingest→indexed 6.5s
```

Preview (`API_URL=https://proofql-api-preview.…`, `ORIGIN=https://proofql-cdn-preview.…`, the seeded demo project's live keys):

```
[demo] https://proofql-api-preview.gruberplatte.workers.dev · origin https://proofql-cdn-preview.gruberplatte.workers.dev · reviews demo-1791145915-1…6
[1/8] GET /health                                              PASS    114 ms  ok, x-request-id a456f3f21bfa089c
[2/8] POST /v1/reviews (6 reviews, demo-1791145915-n)          PASS   1038 ms  stored 6: indexing, indexing, indexing, indexing, indexing, indexing
[3/8] GET /v1/reviews?source=custom until 6/6 indexed          PASS  18227 ms  6/6 indexed after 17.1s
[4/8] GET /v1/query (publishable key + Origin) ×3             PASS   2069 ms  a: 5 result(s), top=review 1 score 0.915 took_ms 391 · b: match none, results [] · c: match fallback, 5 labelled row(s)
[5/8] GET /v1/query (repeat a) → x-cache: HIT                PASS    269 ms  HIT, took_ms 6
[6/8] GET /v1/query (a, include=text) → highlights           PASS    812 ms  5 result(s), every text.slice(highlight.start, highlight.end) === excerpt
[7/8] PATCH /v1/reviews/{review 1} hidden → gone from a      PASS   1391 ms  hidden; MISS, match query, 5 result(s), review 1 absent
[8/8] DELETE /v1/reviews/{id} ×6 → 204, GET → 404         PASS   5530 ms  6 deleted, 6 × 404
demo: 8/8 steps passed in 29s against https://proofql-api-preview.gruberplatte.workers.dev — cold query 391 ms, cache HIT 6 ms, ingest→indexed 17.1s
```

## 6. Preview load run (2026-10-04, #108)

The re-measurement §3 and §4 deferred: the same k6 scenarios against the
deployed **preview** api, with Hyperdrive in front of Neon, Workers AI
embeddings and real KV. Then the fix, then the same runs again.

### Setup

| | |
|---|---|
| Api | `https://proofql-api-preview.gruberplatte.workers.dev`. Before: `main` at `baad677` (version `06033110`). After: this branch, deployed by hand with `pnpm --filter @proofql/api exec wrangler deploy --env preview` (version `0e594245`, unchanged for the whole after-run). Automated preview deploys are on, so the next merge to `main` replaces it. |
| Database | Neon project `hidden-haze-63906501`, branch `preview`: `max_connections` 112. Hyperdrive config `ec18323e…` → the Neon **pooler** endpoint with `origin_connection_limit: 20`, query caching on. Connections were sampled on the **direct** endpoint. |
| Data | `org_load_proofql` on the paid plan: 20 projects × 300 reviews (12,000 chunks), no large tenant, 40 publishable keys per project. Seeded in 16 s and deleted afterwards (the cascade from `accounts`). |
| Load | k6 v2.3.0 from a laptop over the public internet, `constant-arrival-rate`, 60 s per step, publishable keys in `?key=` plus `Origin`. |
| Watching | `wrangler tail --env preview --format json` for the whole run (sampled by Cloudflare at this volume, so its counts are a lower bound), and `load/scripts/pg-sample.ts` polling `pg_stat_activity` every 500 ms. |

**The load-seeded chunks carry fake embeddings,** and on preview `q` is
embedded by Workers AI, so every query returned `results: []` /
`match: "none"`. The path is still the real one: auth, KV, `bge-m3`, Hyperdrive,
the exact scan over the tenant's 600 chunks, policy and serialization.
That is what these latency and connection numbers measure. It is not a
relevance test. The commands are in [`load/README.md`](../load/README.md)
"Against preview". Another agent's demo traffic was running at the same
time (tens of requests).

### Before: `main`

End to end as k6 sees it. Every number includes the ~100 ms laptop →
Cloudflare round trip, so the 50 ms warm target from #50 cannot be read
off this table. Compare the rows with each other, and read `took_ms` for
the server's own share.

| Scenario | Target | Achieved | p50 | p95 | p99 | 5xx | `x-cache` HIT | `took_ms` p50/p95 | Neon backends peak (active) | xact committed |
|---|---|---|---|---|---|---|---|---|---|---|
| `warm` | 100 /s | 100 /s | 112 ms | 151 ms | 234 ms | 0 | 100 % | 4 / 7 | 23 (15) | 12,185 |
| `cold` | 50 /s | 50 /s | 509 ms | 827 ms | 987 ms | 0 | 0 % | 392 / 709 | 22 (14) | 12,316 |
| `mixed` | 100 /s | 100 /s | 120 ms | 568 ms | 795 ms | 0 | 80 % | 4 / 441 | 23 (14) | 14,461 |
| `multi` | 100 /s | 100 /s | 125 ms | 635 ms | 881 ms | 22 (0.36 %) | 80 % | — | 24 (17) | 16,616 |
| ramp `warm` | 50 /s | 50 /s | 110 ms | 130 ms | 190 ms | 0 | 100 % | 4 / 7 | 23 (9) | 6,244 |
| ramp `warm` | 100 /s | 100 /s | 112 ms | 151 ms | 220 ms | 0 | 100 % | 4 / 7 | 23 (16) | 12,211 |
| ramp `warm` | 150 /s | 150 /s | 125 ms | 216 ms | 278 ms | 0 | 100 % | 4 / 7 | 23 (18) | 18,300 |
| ramp `warm` | **200 /s** | **~180 /s** | **1.66 s** | **2.87 s** | 2.99 s | 0 | 100 % | 4 / 7 | 23 (18) | 23,644 |
| ramp `warm` | 300 /s | ~175 /s | 6.14 s | 8.15 s | 8.98 s | 0 | 100 % | 4 / 7 | 23 (19) | 26,075 |
| `cold` | 100 /s | ~60 /s | 3.61 s | 5.09 s | 5.37 s | 0 | 0 % | 2,475 / 3,531 | 24 (18) | 21,740 |
| `cold` | 150 /s | ~80 /s | 6.89 s | 7.55 s | 7.80 s | 37 | 0 % | 4,667 / 5,186 | 24 (20) | 22,229 |

What it shows:

- **Behind Hyperdrive, 53300 never appeared.** The tail held zero
  `request.failed` lines and no `too many clients` anywhere. As predicted
  in §3, the failure changed shape from refusal to **queueing**. Neon's
  backend count sat at 22–24, which is Hyperdrive's 20 origin connections
  plus the sampler and the dashboard, far below `max_connections` (112).
  Hyperdrive's `origin_connection_limit` is the ceiling, not Neon.
- **The warm knee is between 150 and 200 /s.** At 200 /s throughput levels
  off at ~180 /s and every extra request waits: p50 goes from 125 ms to
  1.7 s, k6 drops 479 iterations at 200 and 5,666 at 300, and `took_ms`
  stays at 4 ms because the time is spent queued for a connection before
  the handler runs. That ceiling is arithmetic. A HIT held a pooled
  connection for its key lookup, the `last_used_at` refresh and the usage
  upsert (~2 transactions, `xact` ≈ 2 per request in the table), and 20
  connections at ~110 ms of hold time each come to ~180 requests/s. **The
  query cache did nothing for that number.** That is §4.4 confirmed on
  the real stack.
- **The miss knee is between 50 and 100 /s,** for the same reason plus the
  embedding call: at 100 /s only ~60 /s completed and `took_ms` rose
  to 2.5 s.
- The 5xx in `multi` (22) and `cold` 150 (37) were not in the sampled
  tail. The after-run shows what a miss storm produces at that rate
  (Workers AI 3021, below), which is the likely cause. Six `exceededCpu`
  outcomes were also logged during the 300 /s step.

### The decision

Option (a) from #108, plus (b) as the safety net. (c), reusing a client
across requests in one isolate, was not needed: Hyperdrive never refused
a connection, so connection *count* was never the problem. Connection
*hold time per request* was.

1. **Cache HITs are database-free.** The resolved auth context (project,
   environment, kind, plan, allowed origins, policy) is stored in KV for
   60 s under the key's SHA-256 hash (`workers/api/src/auth-cache.ts`).
   It is tagged with the project's cache generation and trusted only
   while that generation is current. The generation read is the one the
   query cache already made, now shared, so the HIT path adds one KV read
   (the auth entry) and no database round trip. The dashboard now bumps
   the generation on key revocation and on allowlist edits, as policy
   edits already did. **Revocation window:** a revoked key can keep
   authenticating on `/v1/query` until KV propagates the bump or the
   entry expires: about a minute, at most two. This is acceptable because
   the cache is used only on `/v1/query` and its preflight, so a stale
   key can *read publishable reviews*, which the customer publishes to
   every visitor anyway. Write routes resolve the key from Postgres on
   every request, so a revoked secret key cannot write for one second
   longer than before (`docs/security.md` §4.2, §6). Plan changes lag the
   same minute (the badge flips on the next lookup).
2. **The `usage` write is batched** (`workers/api/src/usage-buffer.ts`).
   Each isolate accumulates per `(project, month)` and writes every 5 s in
   one multi-row `INSERT … ON CONFLICT DO UPDATE SET queries =
   usage.queries + excluded.queries`, on a client of its own. Counts can
   lag one window, and an evicted isolate loses at most one window. A
   failed flush logs `usage.flush_failed` with the totals and is not
   retried. `last_used_at` is refreshed only on a database lookup, which
   under steady traffic is once a minute, the same cadence as before.
3. **On a MISS: `max: 1`, `connectTimeout: 10`, `idleTimeout: 5`**
   (`API_DB_OPTIONS`), and a connection failure becomes **503
   `service_unavailable` with `Retry-After: 1`** instead of 500. That
   covers SQLSTATE 53300, 53400, 57P03 and the 08xxx class, plus
   postgres-js `CONNECT_TIMEOUT` and the socket codes. It is in
   `errors.ts`, in the spec on every database-backed operation, and in
   the contract test.

### After: this branch

| Scenario | Target | Achieved | p50 | p95 | p99 | 5xx | `x-cache` HIT | `took_ms` p50/p95 | Neon backends peak (active) | xact committed |
|---|---|---|---|---|---|---|---|---|---|---|
| `warm` | 100 /s | 100 /s | **27 ms** | **38 ms** | 125 ms | 0 | 100 % | 2 / 3 | 21 (7) | **336** |
| `cold` | 50 /s | 50 /s | 427 ms | 744 ms | 910 ms | 0 (1 timeout) | 0 % | 389 / 706 | 21 (9) | 6,371 |
| `mixed` | 100 /s | 100 /s | 29 ms | 477 ms | 719 ms | 0 | 80 % | 2 / 439 | 19 (6) | 2,780 |
| `multi` | 100 /s | 100 /s | 30 ms | 520 ms | 767 ms | 0 | 80 % | 2 / 448 | 20 (11) | 5,009 |
| ramp `warm` | 50 /s | 50 /s | 28 ms | 39 ms | 187 ms | 0 | 100 % | 2 / 3 | 20 (4) | 458 |
| ramp `warm` | 100 /s | 100 /s | 28 ms | 40 ms | 123 ms | 0 | 100 % | 2 / 4 | 20 (11) | 453 |
| ramp `warm` | 150 /s | 150 /s | 29 ms | 41 ms | 111 ms | 0 | 100 % | 2 / 4 | 20 (4) | 504 |
| ramp `warm` | 200 /s | 200 /s | 29 ms | 42 ms | 95 ms | 0 | 100 % | 2 / 4 | 20 (10) | 521 |
| ramp `warm` | **300 /s** | **300 /s** | **30 ms** | **43 ms** | 94 ms | 0 | 100 % | 2 / 4 | 20 (13) | 599 |
| `cold` | 100 /s | ~100 /s | 522 ms | 952 ms | 1.18 s | 0 | 0 % | 485 / 919 | 22 (15) | 12,340 |
| `cold` | 150 /s | ~150 /s | 505 ms | 1.06 s | 1.33 s | **2,649 (30 %)** | 0 % | 582 / 1,090 | 23 (19) | 15,867 |

(The `xact` column includes the dashboard's and the other agent's traffic,
a few hundred a minute. Most of the after-run `warm` numbers are that
background.)

- **No warm knee up to 300 /s,** the highest step tried. Before the change
  it was between 150 and 200 /s. The `warm` p95 went from 151 ms to 38 ms
  at 100 /s, and from 2.87 s to 42 ms at 200 /s. With the ~100 ms network
  round trip removed from the old numbers, what is left is the database
  connection a HIT no longer opens. The warm p95 is now inside the 50 ms
  target from #50 even measured from a laptop.
- **Database work for a HIT went from ~2 transactions to ~0.** At
  100 /s warm, xact committed per minute fell from 12,185 to 336, and
  most of the 336 is background traffic plus one usage flush per isolate
  per 5 s. `sessions_opened` on Neon was 0 throughout. Hyperdrive keeps
  its warm pool, which is why the backend *count* stays around 20 while
  *active* backends fall.
- **The miss path's ceiling is now Workers AI, not the database.** `cold`
  at 100 /s now completes at ~100 /s (it was ~60 /s) with `took_ms` p50
  485 ms (it was 2.5 s), because HITs and auth no longer occupy the 20
  pooled connections. At 150 /s, 30 % of requests failed with 503
  `embedding_unavailable`. Every sampled failure was `3021: rate limiting:
  inference request per min rate reached`, which is Workers AI's
  per-minute limit for `bge-m3` on this account. That is the documented,
  retryable 503 and not a database fault. A real tenant mix is overwhelmingly
  HITs (§4.3), so ~6,000 unique queries a minute is a long way off. It is
  still the number to raise with Cloudflare before launch.
- **Connection peak:** 23–24 Neon backends before and 19–23 after, both
  capped by Hyperdrive's 20 origin connections. Active backends during
  the warm ramp went from 9–19 to 4–13. Neither run came near
  `max_connections` (112). No 53300, and no 503 `service_unavailable` was
  served during the runs.

### What the run cost: the free-plan daily limits

About two hours after the after-run, preview's `/v1/query` began failing for every
caller (including the demo project):

- `auth.cache_error` / `query.cache_error`: **`KV get() limit exceeded
  for the day`**. Workers Free allows 100,000 KV reads a day, and the
  runs (~110,000 requests, 2–3 KV reads each) spent it.
- `request.failed`, 500: **`PostgresError: Usage limit for account
  exceeded, usage renews at 2026-10-05 00:00:00 UTC`**, which is the
  free-plan Hyperdrive daily query allowance.

Both reset at 00:00 UTC. The lessons:

- On the free plan these **daily** allowances are preview's real
  ceiling, two orders of magnitude below any per-second number above.
  Load runs against preview should be budgeted (this whole suite is
  about one day's KV reads) or run on a paid account or a separate
  environment. `load/README.md` says so.
- The auth cache trades database queries for KV reads: a HIT went from
  2 KV reads + ~2 queries to 3 KV reads + ~0 queries, and the auth entry
  is written once a minute per key. On the paid plans, where KV reads
  are ~$0.50 per million, that is the right trade. On free it moves the
  daily ceiling from Hyperdrive to KV.
- The Hyperdrive usage-limit error has no SQLSTATE in the
  `service_unavailable` set, so it surfaced as 500 `internal`. Mapping it
  to 503 with a long `Retry-After` is a small follow-up. It needs a
  stable code or message to match, and none is documented.

## Appendix: raw k6 output

`pnpm load:run` leaves `load/results/<scenario>.txt` (k6's summary),
`<scenario>.summary.json`, and the Postgres snapshots; they are gitignored.
The figures above are from the files produced on 2026-10-02 (`warm`,
`cold`, `large`, the bench) and 2026-10-03 (connection probes, the
corrected `mixed`/`multi` run, the load-database `EXPLAIN`s).
