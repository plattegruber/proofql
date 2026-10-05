# Load test: the query path

k6 scenarios for `GET /v1/query` and the seed that gives them something to
hit (#50). Results and the analysis live in
[`docs/performance.md`](../docs/performance.md); this directory is the
tooling. It is **not a workspace**: the seed imports the packages by
relative path and runs under `packages/db`'s `tsx`, so nothing here ships.

| Path | What |
|---|---|
| `scripts/seed-load.ts` | Creates the load account (`org_load_proofql`, paid plan): N projects × M reviews plus one 50,000-chunk tenant, two fake-embedded chunks per review, and mints keys per project. Writes `.keys.json` (gitignored). The two fixed chunks (`full` + first-sentence `window`) are a shape for the scan, not `chunkReview`'s output — since #127 a real review averages ~4 chunks on the demo corpus, so a 1,000-review load tenant stands in for ~500 real reviews; read [`docs/performance.md`](../docs/performance.md) §2 for the conversion. |
| `k6/query.js` | The five scenarios, one per run (`-e SCENARIO=…`), with the thresholds. |
| `run.sh` | Runs the scenarios in sequence, snapshots Postgres before and after each, writes `results/` (gitignored). |
| `scripts/pg-stats.sh` | The Postgres snapshot (`pg_stat_database.sessions`, backends by state); needs `psql` or the compose container. |
| `scripts/pg-sample.ts` | The same picture for a database without `psql` (the Neon preview branch): polls `pg_stat_activity` every 500 ms for the run's duration and prints the peak backends by state plus the `sessions` / `xact_commit` deltas. Stops on SIGTERM with its summary, so a runner can bracket k6 with it (#108). |
| `tsconfig.json` | Typechecks the seed and the sampler: `pnpm load:typecheck` (run by CI's `typecheck` job). |

## Prerequisites

- The compose Postgres, migrated (`pnpm run setup`).
- The api worker running locally: `pnpm --filter @proofql/api dev` (port
  8797; the fake embedder, Miniflare KV and the local rate-limit bindings).
  If another checkout already holds the inspector port, use
  `pnpm --filter @proofql/api exec wrangler dev --port 8797 --inspector-port 9339`.
- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/): `brew install k6`,
  or drop the release binary somewhere and set `K6=/path/to/k6`.

## Run it

```sh
pnpm load:seed                       # ~15 s: 20 × 1,000 reviews + 1 × 25,000 reviews = 90,000 chunks
pnpm load:run                        # all five scenarios, ~6 minutes
pnpm load:run warm cold              # a subset
```

Each scenario leaves `results/<scenario>.txt` (k6's summary),
`results/<scenario>.summary.json`, and the two Postgres snapshots. `run.sh`
also prints how many Postgres sessions the scenario opened.

### Scenarios

| `SCENARIO` | Default rate | What it measures |
|---|---|---|
| `warm` | 100 /s × 60 s | One project, 12 queries primed in `setup()`; every request is a KV `HIT`. |
| `cold` | 50 /s × 60 s | One project, a never-seen query per request: embed + exact scan + KV put. Every request is a `MISS`. |
| `mixed` | 100 /s × 60 s | One project, 80 % primed queries / 20 % unique. |
| `multi` | 100 /s × 60 s | 20 projects round-robin, 80/20 — the tenant filter and KV under many keys. |
| `large` | 20 /s × 60 s | The 50,000-chunk tenant, unique queries — the exact scan at the line scope.md §2 says to revisit. |

Queries are the seeded topic sentences (`TOPICS` in the seed, copied into
`.keys.json`), so a request is a `window` chunk's exact text under the fake
embedder and returns `limit` rows above any floor; a "unique"
query appends a nonce so the normalized cache key is new.

### Thresholds

Set in `k6/query.js`; `-e P95_MS=…` overrides the latency one.

| Metric | Threshold | Scenarios |
|---|---|---|
| `http_req_duration` p95 | < 50 ms | `warm` |
| `http_req_duration` p95 | < 400 ms | `cold`, `mixed`, `multi`, `large` |
| `http_req_failed` | < 0.1 % | all |
| `http_5xx` | 0 | all |
| `http_429` | 0 | all (a 429 means too few keys for the rate, not a server fault) |
| `cache_hit` | > 99 % / < 1 % | `warm` / `cold`, `large` |

These are **local** numbers. Locally the embedder is the deterministic fake
(~1 ms) and KV is Miniflare's on-disk SQLite, so a `cold` request is
"auth + SQL + KV write" and a `warm` one is "auth + KV read". Against
staging the miss path adds a Workers AI `bge-m3` call (tens of ms) and both
paths add KV's network hop, so the staging numbers will be higher and the
50 ms / 400 ms targets in #50 are the ones to judge them by — the local run
is the floor they cannot beat.

### Variables

| Variable | Default | Notes |
|---|---|---|
| `BASE_URL` | `http://localhost:8797` | The preview api: `BASE_URL=https://proofql-api-preview.gruberplatte.workers.dev pnpm load:run` (see "Against preview"). |
| `KEYS_FILE` | `load/.keys.json` | The seed's output. Against preview, seed that database with `DATABASE_URL=… pnpm load:seed -- --force` (the seed refuses non-loopback hosts without `--force`) and `LOAD_ORIGIN` set to an origin the snippet would use. |
| `SCENARIO` | `warm` | `run.sh` sets it per scenario. |
| `RATE`, `DURATION` | per scenario, `60s` | Override the arrival rate (requests/s) and duration. |
| `PROJECT` | `0` | Which project the single-project scenarios use. |
| `KEY_KIND` | `publishable` | `secret` sends `Authorization: Bearer` instead of `?key=` + `Origin`. |
| `P95_MS` | per scenario | Override the latency threshold. |
| `K6` | `k6` | Path to the binary for `run.sh`. |

Seed knobs: `LOAD_PROJECTS` (20), `LOAD_REVIEWS` (1,000 per project),
`LOAD_LARGE_CHUNKS` (50,000), `LOAD_PUBLISHABLE_KEYS` (12 per project),
`LOAD_SECRET_KEYS` (2), `LOAD_PLAN` (`paid`), `LOAD_ORIGIN`
(`http://localhost:3000`), `DATABASE_URL` (the compose Postgres).

### Against preview

The preview run for #108 (`docs/performance.md` §6) used these commands;
the preview facts (Neon project, Hyperdrive config, api URL) are in
`infra/environments.md` and `infra/provisioning.md`.

```sh
# 1. Seed the load account into the preview branch over the *direct* Neon
#    URL (never the pooler): 20 × 300 reviews, no large tenant, 40
#    publishable keys per project so 300 rps on one project stays under the
#    600/min per-key limit. ~16 s. Only `org_load_proofql` is touched; the
#    demo account is left alone.
DATABASE_URL="$PREVIEW_DB_URL" LOAD_PROJECTS=20 LOAD_REVIEWS=300 \
  LOAD_LARGE_CHUNKS=0 LOAD_PUBLISHABLE_KEYS=40 pnpm load:seed -- --force

# 2. Watch the api while the run is on (sampled by Cloudflare above a few
#    hundred events/s — counts are a lower bound).
pnpm --filter @proofql/api exec wrangler tail --env preview --format json > tail.jsonl

# 3. One scenario, with the connection sampler on the direct endpoint
#    alongside. `K6_SETUP_TIMEOUT` matters for `multi`: its warm-up is 240
#    cache misses at ~0.5 s each, past k6's 60 s default.
DATABASE_URL="$PREVIEW_DB_URL" pnpm --filter @proofql/db exec tsx \
  ../../load/scripts/pg-sample.ts --seconds 3600 > warm.pg.json & SAMPLER=$!
BASE_URL=https://proofql-api-preview.gruberplatte.workers.dev K6_SETUP_TIMEOUT=600s \
  ~/.local/bin/k6 run -e SCENARIO=warm -e RATE=100 --summary-export warm.summary.json load/k6/query.js
kill -TERM $SAMPLER; wait $SAMPLER

# 4. The ramp: the same `warm` scenario at RATE=50 100 150 200 300, 60 s each.

# 5. Clean up: the load account cascades to its projects, keys, reviews,
#    chunks and usage rows.
#    DELETE FROM accounts WHERE clerk_org_id = 'org_load_proofql';
```

**Budget the run.** On the free plan, preview has *daily* allowances:
100,000 KV reads, 1,000 KV writes, 100,000 Hyperdrive queries and 100,000
Workers requests, shared with every other user of the account. The full
suite twice (~160,000 requests) spent the KV reads and the Hyperdrive
queries and took preview's `/v1/query` down for every caller until
00:00 UTC (`docs/performance.md` §6, §7). Since #158 that degrades instead
of failing, but the suite alone exceeds the daily Workers requests: do
not run it against preview while the account is on the free plan
(docs/launch.md §16).

Load-seeded chunks carry **fake embeddings**, so on preview — where `q`
is embedded by Workers AI — every query returns `results: []` and
`match: "none"`. That still exercises the whole path (auth, KV, embed,
Hyperdrive, the exact scan, policy, response) and is what the latency and
connection numbers measure; it is not a relevance test. k6's local
thresholds (warm p95 < 50 ms) will trip against preview because the
laptop → Cloudflare round trip alone is ~100 ms; read the percentiles,
not the exit code.

### Rate limits and keys

Nothing in `workers/api` is changed or bypassed for the test. Limits are per
key and per plan (`PLANS` in `packages/core/src/plans.ts`: 600 requests /
minute per publishable key on the paid plan), so the script round-robins
across the project's keys: 12 publishable keys give 120 requests/s of
headroom per project. Raise `LOAD_PUBLISHABLE_KEYS` (and reseed) before
raising `RATE` past that, or `http_429` will trip. The load account is on
the paid plan because a 25,000-review tenant is over the free cap by
definition; the plan does not touch the latency path.

### Reading the Postgres side

`run.sh` prints the `pg_stat_database.sessions` delta per scenario: with the
api opening a postgres-js client per request, that number divided by
`http_reqs` is connections per request. `max_connections` is 100 on the
compose image; `backends_*` in the snapshots is the concurrent picture at
the moment of the snapshot. For the search statement itself, the existing
bench gives `EXPLAIN ANALYZE` at any tenant size:

```sh
DATABASE_URL=postgres://proofql:proofql@localhost:54323/proofql \
  pnpm --filter @proofql/db exec tsx scripts/bench-search.ts 50000 --explain
```

`search_ms` per request is in the worker's `query.completed` log lines
(`docs/observability.md`); under `wrangler dev` they are on its stdout.
