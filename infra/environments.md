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

When React Router v7 lands in the dashboard (#36) its dev server becomes Vite
(`@cloudflare/vite-plugin`); pin 8799 in `apps/dashboard/vite.config.ts`
(`server.port`) as well, and keep the two in sync.

## Bindings

Binding **names** are what code sees on `env.*` and are API surface; keep them
identical across workers and environments.

| Binding        | Type              | api      | pipeline | dashboard | local                                              | preview / prod                                   |
| -------------- | ----------------- | -------- | -------- | --------- | -------------------------------------------------- | ------------------------------------------------ |
| `HYPERDRIVE`   | Hyperdrive        | yes      | yes      | yes       | docker compose Postgres (see below)                | `proofql-hyperdrive-<env>` config → Neon         |
| `CACHE`        | KV namespace      | yes      | yes      | yes       | Miniflare simulator (id ignored)                   | `proofql-cache-<env>`                            |
| `INGEST_QUEUE` | Queue producer    | yes      | —        | —         | `proofql-ingest` (Miniflare)                       | `proofql-ingest-<env>`                           |
| (consumer)     | Queue consumer    | —        | yes      | —         | `proofql-ingest`, DLQ `proofql-ingest-dlq`         | `proofql-ingest-<env>`, DLQ `proofql-ingest-dlq-<env>` |
| `AI`           | Workers AI        | yes      | yes      | —         | **not bound** — no simulator; code must treat `env.AI` as optional and use the deterministic fake provider | account-level, no id |
| `ENVIRONMENT`  | var               | yes      | yes      | yes       | `"local"`                                          | `"preview"` / `"prod"`                           |
| `API_URL`      | var               | —        | —        | yes       | `http://localhost:8797`                            | the api worker's public origin                   |

Why the split: the api embeds queries (AI), reads/writes Postgres (HYPERDRIVE),
serves from and fills the cache (CACHE), and enqueues ingested reviews
(INGEST_QUEUE). The pipeline consumes the queue, embeds and classifies (AI),
writes Postgres, and purges the cache for the project it just indexed. The
dashboard reads/writes Postgres for projects, keys, and policy, and purges the
cache on policy change; it never embeds.

**Nothing is provisioned yet.** Every KV namespace id and Hyperdrive config id
in the `wrangler.jsonc` files is the placeholder `TBD-provision-in-m0`; the
M0 provisioning issue (Cloudflare account + Neon project) creates the real
resources and fills them in. `wrangler deploy --dry-run --env preview|prod`
parses every config (dry-run does not validate ids against Cloudflare), but a
**real** `wrangler deploy` fails on the placeholders until then — expected.
`wrangler dev` needs none of it.

Workers AI is also why there is no local `AI` binding: the binding always
proxies to the real Workers AI API and needs a logged-in wrangler, which a
fresh clone and CI do not have. Binding it only in preview/prod keeps
`pnpm dev` and the test suites credential-free.

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
| `.dev.vars` | the worker (runtime) | `env.*` vars and secrets for `wrangler dev` (none required yet)            |

When `.dev.vars` is absent wrangler falls back to loading `.env` as runtime
vars, so every worker commits a `.dev.vars.example` (comments only for now)
that `pnpm run setup` copies, keeping the connection string out of `env`.

## Repo-level env vars

| Variable       | Where                   | Used by                                                        |
| -------------- | ----------------------- | -------------------------------------------------------------- |
| `DATABASE_URL` | root `.env` (`.env.example`) or the shell | `pnpm db:migrate`, `pnpm test:integration` (#15); same canonical string |

`turbo.json` passes `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_*`,
`CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN` through to `dev` tasks.
