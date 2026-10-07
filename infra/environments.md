# Environment matrix

Every deployable workspace ships as a Cloudflare Worker configured by a
`wrangler.jsonc` in its workspace root. Naming convention everywhere:
`proofql-<name>-<env>` with `<name>` ∈ {`api`, `pipeline`, `cdn`, `dashboard`,
`docs`} and `<env>` ∈ {`local`, `preview`, `prod`}.

- **local** — the top-level (default) config in each `wrangler.jsonc`. Used by
  `wrangler dev` only; never deployed. Queues and KV run in Miniflare's local
  simulators and Hyperdrive points at the docker compose Postgres, so **zero
  Cloudflare resources are needed**.
- **preview** — `wrangler deploy --env preview`.
- **prod** — `wrangler deploy --env prod`.

> **Gotcha:** wrangler environments do **not** inherit bindings. Each binding
> is repeated in full in the top-level (local) block and in `env.preview` /
> `env.prod` of every `wrangler.jsonc`. Edit all three when changing anything.

## Worker names

| Workspace          | local (dev only)          | preview                     | prod                     |
| ------------------ | ------------------------- | --------------------------- | ------------------------ |
| `workers/api`      | `proofql-api-local`       | `proofql-api-preview`       | `proofql-api-prod`       |
| `workers/pipeline` | `proofql-pipeline-local`  | `proofql-pipeline-preview`  | `proofql-pipeline-prod`  |
| `workers/cdn`      | `proofql-cdn-local`       | `proofql-cdn-preview`       | `proofql-cdn-prod`       |
| `apps/dashboard`   | `proofql-dashboard-local` | `proofql-dashboard-preview` | `proofql-dashboard-prod` |
| `docs/site`        | `proofql-docs-local`      | `proofql-docs-preview`      | `proofql-docs-prod`      |
| `apps/www`         | `proofql-www-local`       | `proofql-www-preview`       | `proofql-www-prod`       |

## Local dev ports

Fixed in each `wrangler.jsonc` so `pnpm dev` can run everything side by side.
The block is chosen not to collide with well-regarded's 8787–8791 / 9229–9233,
so both repos can run at once on one machine.

| Workspace          | URL                     | `dev.port` | `dev.inspector_port` |
| ------------------ | ----------------------- | ---------- | -------------------- |
| `workers/api`      | <http://localhost:8797> | 8797       | 9239                 |
| `workers/pipeline` | <http://localhost:8798> | 8798       | 9240                 |
| `apps/dashboard`   | <http://localhost:8799> | 8799       | 9241                 |
| `docs/site`        | <http://localhost:8801> | 8801       | 9243                 |
| `workers/cdn`      | <http://localhost:8800> | 8800       | 9242                 |
| `apps/www`         | <http://localhost:8804> | 8804       | 9245                 |
| `packages/google` fake GBP server (`pnpm --filter @proofql/google dev:fake`; local only, never deployed, not part of `pnpm dev`) | <http://localhost:8802> | 8802 | 9244 |
| fake Places API (`node apps/dashboard/test/fake-places-server.ts` after `pnpm build`; local only, not part of `pnpm dev`; used by the dashboard's card and the pipeline's refresh cron) | <http://localhost:8803> | 8803 | — |
| Postgres (compose) | `localhost:54323`       | —          | —                    |

The dashboard's dev server is Vite (`@cloudflare/vite-plugin`, #36), so its
port is pinned twice: `dev.port` in `apps/dashboard/wrangler.jsonc` (raw
`wrangler dev` only) and `server.port` in `apps/dashboard/vite.config.ts`
(`pnpm dev`). Keep the two in sync. The dashboard is also deployed from its
Vite build: `CLOUDFLARE_ENV=<env> react-router build` resolves the env block
into `build/server/wrangler.json` and `wrangler deploy` follows the redirect
in `.wrangler/deploy/config.json` (see the header of its `wrangler.jsonc`).

The cdn worker (`workers/cdn`, #34/#35) serves the built snippet (`/v1.js`,
`/v1.<hash>.js`, maps, `/version.json`) and the hosted demo site (`/demo/`)
from Workers static assets. Its `public/` directory is **built, not
committed** (`pnpm --filter @proofql/cdn build`, which runs the snippet's
esbuild step); only `public/demo/` is in the tree. `pnpm dev` builds before
`wrangler dev`, and the deploy workflow builds before `wrangler deploy`. The
demo page reads the publishable key from its own URL (`/demo/?key=…`), so
the seed lists `http://localhost:8800` among the demo project's allowed
origins.

## Bindings

Binding **names** are what code sees on `env.*` and are API surface; keep them
identical across workers and environments.

| Binding        | Type              | api      | pipeline | dashboard | local                                              | preview / prod                                   |
| -------------- | ----------------- | -------- | -------- | --------- | -------------------------------------------------- | ------------------------------------------------ |
| `HYPERDRIVE`   | Hyperdrive        | yes      | yes      | yes       | docker compose Postgres (see below)                | `proofql-hyperdrive-<env>` config → Neon         |
| `CACHE`        | KV namespace      | yes      | yes      | yes       | Miniflare simulator (id ignored)                   | `proofql-cache-<env>`                            |
| `INGEST_QUEUE` | Queue producer    | yes      | yes      | yes       | `proofql-ingest` (Miniflare)                       | `proofql-ingest-<env>`                           |
| (consumer)     | Queue consumer    | —        | yes      | —         | `proofql-ingest`, DLQ `proofql-ingest-dlq`         | `proofql-ingest-<env>`, DLQ `proofql-ingest-dlq-<env>` |
| `UPLOADS`      | R2 bucket         | —        | yes (#169) | yes     | `proofql-uploads` (Miniflare, one store per worker) | `proofql-uploads-<env>` (by name; no id to paste); the same bucket on both workers — the pipeline only deletes a purged workspace's prefixes. 7-day lifecycle rule on `uploads/` (provisioning.md §4) |
| `AI`           | Workers AI        | yes      | yes      | —         | **not bound** — no simulator; code must treat `env.AI` as optional and use the deterministic fake provider | account-level, no id |
| `RL_SECRET`    | Rate limit        | yes      | —        | —         | Miniflare simulator, 300 req / 60 s per key        | namespace `1001`, 300 req / 60 s per key (free plan, secret keys) |
| `RL_PUBLISHABLE` | Rate limit      | yes      | —        | —         | Miniflare simulator, 120 req / 60 s per key        | namespace `1002`, 120 req / 60 s per key (free plan, publishable keys) |
| `RL_SECRET_PAID` | Rate limit      | yes      | —        | —         | Miniflare simulator, 1000 req / 60 s per key       | namespace `1003`, 1000 req / 60 s per key (paid plan, secret keys) |
| `RL_PUBLISHABLE_PAID` | Rate limit | yes      | —        | —         | Miniflare simulator, 600 req / 60 s per key        | namespace `1004`, 600 req / 60 s per key (paid plan, publishable keys) |
| `ENVIRONMENT`  | var               | yes      | yes      | yes       | `"local"`                                          | `"preview"` / `"prod"`                           |
| `API_URL`      | var               | —        | —        | yes       | `http://localhost:8797`                            | the api worker's public origin                   |
| `SNIPPET_SRC`  | var               | —        | —        | yes       | `http://localhost:8800/v1.js` (the local cdn worker) | `https://cdn.proofql.dev/v1.js` — where the onboarding's snippet tag and preview load the snippet from (#53) |
| `AUTH_STUB_ORG_ID` | var (optional) | —      | —        | yes       | `.dev.vars`; set ⇒ the local auth stub acts as an empty account with this Clerk org id (created on first load) instead of the seeded demo | unset; ignored outside the stub |
| `CLERK_PUBLISHABLE_KEY` | var      | —        | —        | yes       | `.dev.vars` (optional)                             | the Clerk instance's publishable key (`pk_test_…` preview, `pk_live_…` prod) |
| `CLERK_SECRET_KEY` | secret        | —        | —        | yes       | `.dev.vars`; **unset ⇒ local auth stub** (acts as the seeded demo account) | `wrangler secret put` per env; required — no stub outside local |
| `CLERK_WEBHOOK_SIGNING_SECRET` | secret | —   | —        | yes       | `.dev.vars` (optional; `POST /webhooks/clerk` answers 503 without it) | `wrangler secret put` per env |
| `CREDENTIALS_KEY` | secret        | —        | yes      | yes       | `.dev.vars` (generated by `pnpm run setup`, one value shared across workers) | `wrangler secret put` per env, **same value** in every worker that reads `connections.credentials` (docs/secrets.md) |
| `GOOGLE_CLIENT_ID` | var          | —        | yes      | yes       | `.dev.vars` (placeholder; the fake ignores it) | `vars` in `env.preview` / `env.prod`, `TBD-provision-in-m3` until #44 |
| `GOOGLE_CLIENT_SECRET` | secret   | —        | yes      | yes       | `.dev.vars` (placeholder)                           | `wrangler secret put` per env |
| `GOOGLE_OAUTH_BASE`, `GOOGLE_TOKEN_URL`, `GOOGLE_API_BASE` | var (optional) | — | yes | yes | `.dev.vars` → `http://localhost:8802` (the fake) | unset ⇒ real Google hosts (`packages/google/src/endpoints.ts`) |
| `GOOGLE_OAUTH_STATE_SECRET` | secret | —      | —        | yes       | `.dev.vars` (empty ⇒ dev-only secret)              | `wrangler secret put` per env (docs/secrets.md) |
| `GOOGLE_CONNECTOR_ENABLED` | var     | —      | —        | yes       | `.dev.vars` → `true`                                | `vars`: `"false"` until Google approves API access (#44), then `"true"` (provisioning.md) |
| `GOOGLE_PLACES_API_KEY` | secret | —      | yes (#116) | yes     | `.dev.vars` in each (optional; unset ⇒ the "Find your business on Google" card says not configured and the pipeline's daily refresh logs `places.refresh.skipped`; `fake` against the fake server below) | `wrangler secret put` per env on both workers, same key — the Places bootstrap (#47) and its 25-day refresh (#116, [`docs/places.md`](../docs/places.md)) |
| `PLACES_API_BASE` | var (optional) | —    | yes (#116) | yes     | `.dev.vars` in each; `http://localhost:8803` ⇒ the fake Places API (`node apps/dashboard/test/fake-places-server.ts`) | unset ⇒ `https://places.googleapis.com` |

The docs site (`docs/site`, #43) is an **assets-only** Worker: `astro build`
writes `dist/` and `wrangler deploy` uploads it with no script and no
bindings, so it has no row in the bindings table below. `wrangler dev` on
8801 serves the built `dist/`; for authoring, `pnpm --filter @proofql/docs
dev` runs Astro's own dev server on 4321 with hot reload.

The marketing site (`apps/www`) is the same kind of assets-only Worker:
`astro build` writes `dist/`, `wrangler dev` on 8804 serves it, and
`pnpm --filter @proofql/www dev` runs Astro's dev server on 4322. Its demo is
rendered at build time by `@proofql/snippet`'s own code; there are no
bindings and no API calls.

The cdn worker has none of the above. Its only binding is `ASSETS` (Workers
static assets, the `public/` directory), plus the `ENVIRONMENT` var. The
snippet files, maps, `/version.json` and `/demo/*` are served by the asset
layer **without invoking the worker** (#158: asset requests are free, worker
requests count against the free plan's 100,000 a day), with their headers
from the generated `public/_headers`; `run_worker_first: ["/health"]` runs
the worker for the smoke check, and it answers whatever no asset matches. It holds no state and reads no database, so nothing is provisioned for
it; `scripts/check-provisioning.mjs` lists it as `ok` in every environment.

### Cache API: custom domains only

The api keeps query results and resolved API keys in the **Workers Cache
API** (`caches.default`, #158), which has no daily quota, so neither costs
a KV write. Cloudflare documents working cache operations only for
"Workers deployed to custom domains" (and Pages). On `*.workers.dev`,
`cache.put` is accepted and silently dropped. The api therefore checks
the request's hostname (`isWorkersDevHost`, `workers/api/src/edge-cache.ts`).
On `*.workers.dev` (preview; prod serves only `api.proofql.dev`), it falls back: results go to KV, but only from a query's second
miss in an isolate (the write budget), and resolved keys are kept in the
isolate only. Routing the custom domain switches the Cache API on, with no
config change. The Cache API is per data center and is not shared between
workers. The project cache generations (`gen:<id>`), which the dashboard
and pipeline bump, stay in KV either way. Background:
`docs/performance.md` §7.

Why the split: the api embeds queries (AI), reads/writes Postgres (HYPERDRIVE),
serves from and fills the cache (CACHE), enqueues ingested reviews
(INGEST_QUEUE), and counts requests per API key (the `RL_*` bindings — one per
plan and key kind, because a binding's limit is fixed in wrangler.jsonc and the
numbers come from `PLANS` in `packages/core/src/plans.ts`; `namespace_id` is an
account-unique integer we pick, nothing is provisioned; code treats all four as
optional and falls back to an in-memory limiter, see
`workers/api/src/rate-limit.ts`). The pipeline consumes the queue, embeds and classifies (AI),
writes Postgres, and purges the cache for the projects a batch indexed (one
generation bump per project per batch, #158); its
single five-minute cron (`triggers.crons`; one per environment because
the Workers Free plan allows five per account, #174) also *produces* to
the same queue to re-enqueue reviews stuck with `indexed_at IS NULL` (#72),
and at 00/06/12/18:00 UTC the same tick polls every Google connection
(#46; docs/google.md),
producing `review.index` messages for what it imports; the dashboard
produces a `connection.sync` message when a location mapping is saved
(#45), which the pipeline consumes to poll that one connection at once. The poller
does nothing until its three Google credentials are set, so a deploy
without them is safe. The 03:30 UTC tick refreshes Places
bootstraps (#116), and the 04:15 UTC one (#169) hard-deletes workspaces
soft-deleted more than 30 days ago — 50 per tick, FK cascades take every
tenant row — and removes their projects' `uploads/<id>/` prefixes through
the pipeline's `UPLOADS` binding. The
dashboard reads/writes Postgres for projects, keys, and policy, purges the
cache on policy change, stores uploaded review exports in R2 (`UPLOADS`, #38;
expired by the bucket's 7-day lifecycle rule, and deleted at once with their
project, #169) and enqueues the reviews it imports from them (INGEST_QUEUE, the same message
the api sends); it never embeds.

Workers AI is also why there is no local `AI` binding: the binding always
proxies to the real Workers AI API and needs a logged-in wrangler, which a
fresh clone and CI do not have. Binding it only in preview/prod keeps
`pnpm dev` and the test suites credential-free.

## Cloud resources per environment

Everything the owner creates in [`provisioning.md`](provisioning.md), by
name. Local has none of it (Miniflare simulators and the compose Postgres).

| Resource                | preview                                                      | prod                                                      | Holds the id/name                       |
| ----------------------- | ------------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------- |
| KV namespace (`CACHE`)  | `proofql-cache-preview`                                      | `proofql-cache-prod`                                      | `kv_namespaces[].id` in all three configs |
| Queue (`INGEST_QUEUE`)  | `proofql-ingest-preview`                                     | `proofql-ingest-prod`                                     | by name, already in the configs         |
| Dead-letter queue       | `proofql-ingest-dlq-preview`                                 | `proofql-ingest-dlq-prod`                                 | by name, already in the configs         |
| R2 bucket (`UPLOADS`)   | `proofql-uploads-preview`                                    | `proofql-uploads-prod`                                    | by name, already in the dashboard config |
| Hyperdrive (`HYPERDRIVE`) | `proofql-hyperdrive-preview` → Neon branch `preview`       | `proofql-hyperdrive-prod` → Neon branch `prod`            | `hyperdrive[].id` in all three configs  |
| Neon                    | project `proofql`, branch `preview`, database `proofql`      | project `proofql`, branch `prod`, database `proofql`      | Hyperdrive config (pooled string); GitHub secret `NEON_<ENV>_DATABASE_URL` (direct string, migrator only) |
| Workers AI (`AI`)       | account-level                                                | account-level                                             | nothing                                 |
| api URL                 | `https://proofql-api-preview.<subdomain>.workers.dev`        | `https://api.proofql.dev` (Workers Custom Domain, `env.prod.routes`; `workers_dev: false`) | `env.<env>.vars.API_URL` in the dashboard config; repo variable `WORKERS_SUBDOMAIN` for the smoke check |
| pipeline URL            | `https://proofql-pipeline-preview.<subdomain>.workers.dev`   | `https://proofql-pipeline-prod.<subdomain>.workers.dev`   | `/health` only                          |
| dashboard URL           | `https://proofql-dashboard-preview.<subdomain>.workers.dev`  | `https://app.proofql.dev` (Workers Custom Domain, `env.prod.routes`) | —                                       |
| cdn URL                 | `https://proofql-cdn-preview.<subdomain>.workers.dev`        | `https://cdn.proofql.dev` (Workers Custom Domain, `env.prod.routes` in `workers/cdn/wrangler.jsonc`; provisioning.md "Custom domains") | the snippet tag's `src`; the demo link in the README |
| docs URL                | `https://proofql-docs-preview.<subdomain>.workers.dev`       | `https://docs.proofql.dev` (Workers Custom Domain, `env.prod.routes`; provisioning.md "Custom domains"); every api error envelope's `doc_url` points there | `/` smoke only; no bindings |
| marketing site URL      | `https://proofql-www-preview.<subdomain>.workers.dev`        | `https://proofql.dev` and `https://www.proofql.dev` (Workers Custom Domains, `env.prod.routes`); deployed only once the repository variable `WWW_PROD_ENABLED` is `true` (docs/launch.md §2 step 7) | `/` smoke only; no bindings |

**Provisioning status:** every KV namespace id and Hyperdrive config id in
the `wrangler.jsonc` env blocks, and the dashboard's `API_URL`, start as the
placeholder `TBD-provision-in-m0`. `node scripts/check-provisioning.mjs
[preview|prod]` lists what is still unprovisioned; the owner's checklist is
[`provisioning.md`](provisioning.md) (issue #14). `wrangler deploy --dry-run
--env preview|prod` parses every config (dry-run does not validate ids), but
a **real** `wrangler deploy` fails on the placeholders until then — expected.
`wrangler dev` needs none of it.

## Deploys

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml): a push to
`main` migrates the Neon `preview` branch then deploys the six preview
workers (pipeline, api, cdn, dashboard, docs, www, in that order — the cdn is
built from `packages/snippet`, the docs from `docs/site` and the marketing
site from `apps/www` right before their deploys; prod skips www until
`WWW_PROD_ENABLED` is `true`); `workflow_dispatch` with
`environment=prod` does the same for prod inside the GitHub environment
`production` (required reviewer). Every job is skipped until the repository
variable `DEPLOY_ENABLED` is `true` — the last provisioning step and the
kill switch. Secrets and variables the workflow reads:
[`docs/secrets.md`](../docs/secrets.md).

## Local Postgres (Hyperdrive)

Hyperdrive has no Miniflare simulator; locally, wrangler connects the
`HYPERDRIVE` binding straight to a Postgres connection string. Two sources,
in precedence order:

1. The environment variable, read by wrangler from its **process environment
   or the worker directory's `.env` file** — *not* from `.dev.vars`:

   ```
   CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://proofql:proofql@localhost:54323/proofql
   ```

   The suffix after `_STRING_` is the binding name. Each Hyperdrive binder
   commits a `.env.example` with this line; `pnpm run setup` copies it to the
   gitignored `.env`.
2. `localConnectionString` on the binding in `wrangler.jsonc`, set to the same
   canonical string, so `wrangler dev` also boots in a checkout where `.env`
   was never created.

Both point at the docker compose database from `pnpm run setup`
(`docker-compose.yml` is the canonical home of the connection string).

### `.env` vs `.dev.vars`

| File        | Read by              | Holds                                                                      |
| ----------- | -------------------- | -------------------------------------------------------------------------- |
| `.env`      | the wrangler CLI     | process config: the Hyperdrive connection string above                     |
| `.dev.vars` | the worker (runtime) | `env.*` vars and secrets for `wrangler dev` (the dashboard's Clerk keys; nothing required) |

When `.dev.vars` is absent wrangler falls back to loading `.env` as runtime
vars, so every worker commits a `.dev.vars.example` (comments, plus empty
Clerk placeholders in the dashboard's) that `pnpm run setup` copies, keeping
the connection string out of `env`.

## Repo-level env vars

| Variable       | Where                   | Used by                                                        |
| -------------- | ----------------------- | -------------------------------------------------------------- |
| `DATABASE_URL` | root `.env` (`.env.example`) or the shell | `pnpm db:migrate`, `pnpm test:integration` (#15); same canonical string |

`turbo.json` passes `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_*`,
`CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN` through to `dev` tasks.
