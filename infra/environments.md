# Environment matrix

Every deployable workspace ships as a Cloudflare Worker configured by a
`wrangler.jsonc` in its workspace root. Naming convention everywhere:
`proofql-<name>-<env>` with `<name>` ∈ {`api`, `pipeline`, `dashboard`} and
`<env>` ∈ {`local`, `preview`, `prod`}.

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
| `apps/dashboard`   | `proofql-dashboard-local` | `proofql-dashboard-preview` | `proofql-dashboard-prod` |

## Local dev ports

Fixed in each `wrangler.jsonc` so `pnpm dev` can run everything side by side.
The block is chosen not to collide with well-regarded's 8787–8791 / 9229–9233,
so both repos can run at once on one machine.

| Workspace          | URL                     | `dev.port` | `dev.inspector_port` |
| ------------------ | ----------------------- | ---------- | -------------------- |
| `workers/api`      | <http://localhost:8797> | 8797       | 9239                 |
| `workers/pipeline` | <http://localhost:8798> | 8798       | 9240                 |
| `apps/dashboard`   | <http://localhost:8799> | 8799       | 9241                 |
| Postgres (compose) | `localhost:54323`       | —          | —                    |

The dashboard's dev server is Vite (`@cloudflare/vite-plugin`, #36), so its
port is pinned twice: `dev.port` in `apps/dashboard/wrangler.jsonc` (raw
`wrangler dev` only) and `server.port` in `apps/dashboard/vite.config.ts`
(`pnpm dev`). Keep the two in sync. The dashboard is also deployed from its
Vite build: `CLOUDFLARE_ENV=<env> react-router build` resolves the env block
into `build/server/wrangler.json` and `wrangler deploy` follows the redirect
in `.wrangler/deploy/config.json` (see the header of its `wrangler.jsonc`).

## Bindings

Binding **names** are what code sees on `env.*` and are API surface; keep them
identical across workers and environments.

| Binding        | Type              | api      | pipeline | dashboard | local                                              | preview / prod                                   |
| -------------- | ----------------- | -------- | -------- | --------- | -------------------------------------------------- | ------------------------------------------------ |
| `HYPERDRIVE`   | Hyperdrive        | yes      | yes      | yes       | docker compose Postgres (see below)                | `proofql-hyperdrive-<env>` config → Neon         |
| `CACHE`        | KV namespace      | yes      | yes      | yes       | Miniflare simulator (id ignored)                   | `proofql-cache-<env>`                            |
| `INGEST_QUEUE` | Queue producer    | yes      | yes      | —         | `proofql-ingest` (Miniflare)                       | `proofql-ingest-<env>`                           |
| (consumer)     | Queue consumer    | —        | yes      | —         | `proofql-ingest`, DLQ `proofql-ingest-dlq`         | `proofql-ingest-<env>`, DLQ `proofql-ingest-dlq-<env>` |
| `AI`           | Workers AI        | yes      | yes      | —         | **not bound** — no simulator; code must treat `env.AI` as optional and use the deterministic fake provider | account-level, no id |
| `RL_SECRET`    | Rate limit        | yes      | —        | —         | Miniflare simulator, 300 req / 60 s per key        | namespace `1001`, 300 req / 60 s per key         |
| `RL_PUBLISHABLE` | Rate limit      | yes      | —        | —         | Miniflare simulator, 120 req / 60 s per key        | namespace `1002`, 120 req / 60 s per key         |
| `ENVIRONMENT`  | var               | yes      | yes      | yes       | `"local"`                                          | `"preview"` / `"prod"`                           |
| `RATE_LIMITS`  | var (optional)    | yes      | —        | —         | unset                                              | unset; JSON override of the advertised per-kind limits, must mirror the `ratelimits` entries when set |
| `API_URL`      | var               | —        | —        | yes       | `http://localhost:8797`                            | the api worker's public origin                   |
| `CLERK_PUBLISHABLE_KEY` | var      | —        | —        | yes       | `.dev.vars` (optional)                             | the Clerk instance's publishable key (`pk_test_…` preview, `pk_live_…` prod) |
| `CLERK_SECRET_KEY` | secret        | —        | —        | yes       | `.dev.vars`; **unset ⇒ local auth stub** (acts as the seeded demo account) | `wrangler secret put` per env; required — no stub outside local |
| `CLERK_WEBHOOK_SIGNING_SECRET` | secret | —   | —        | yes       | `.dev.vars` (optional; `POST /webhooks/clerk` answers 503 without it) | `wrangler secret put` per env |

Why the split: the api embeds queries (AI), reads/writes Postgres (HYPERDRIVE),
serves from and fills the cache (CACHE), enqueues ingested reviews
(INGEST_QUEUE), and counts requests per API key (RL_SECRET / RL_PUBLISHABLE —
`namespace_id` is an account-unique integer we pick, nothing is provisioned;
code treats both as optional and falls back to an in-memory limiter, see
`workers/api/src/rate-limit.ts`). The pipeline consumes the queue, embeds and classifies (AI),
writes Postgres, and purges the cache for the project it just indexed; its
five-minute cron (`triggers.crons`) also *produces* to the same queue to
re-enqueue reviews stuck with `indexed_at IS NULL` (#72). The
dashboard reads/writes Postgres for projects, keys, and policy, and purges the
cache on policy change; it never embeds.

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
| Hyperdrive (`HYPERDRIVE`) | `proofql-hyperdrive-preview` → Neon branch `preview`       | `proofql-hyperdrive-prod` → Neon branch `prod`            | `hyperdrive[].id` in all three configs  |
| Neon                    | project `proofql`, branch `preview`, database `proofql`      | project `proofql`, branch `prod`, database `proofql`      | Hyperdrive config (pooled string); GitHub secret `NEON_<ENV>_DATABASE_URL` (direct string, migrator only) |
| Workers AI (`AI`)       | account-level                                                | account-level                                             | nothing                                 |
| api URL                 | `https://proofql-api-preview.<subdomain>.workers.dev`        | `https://proofql-api-prod.<subdomain>.workers.dev` (custom domain TBD, scope §7.6) | `env.<env>.vars.API_URL` in the dashboard config; repo variable `WORKERS_SUBDOMAIN` for the smoke check |
| pipeline URL            | `https://proofql-pipeline-preview.<subdomain>.workers.dev`   | `https://proofql-pipeline-prod.<subdomain>.workers.dev`   | `/health` only                          |
| dashboard URL           | `https://proofql-dashboard-preview.<subdomain>.workers.dev`  | `https://proofql-dashboard-prod.<subdomain>.workers.dev` (custom domain TBD) | —                                       |

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
`main` migrates the Neon `preview` branch then deploys the three preview
workers (pipeline, api, dashboard, in that order); `workflow_dispatch` with
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
