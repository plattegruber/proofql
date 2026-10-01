# ProofQL

[![CI](https://github.com/plattegruber/proofql/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/plattegruber/proofql/actions/workflows/ci.yml)

**Review search as an API.** Send us your reviews, ask us a question, get back the ones that answer it.

```http
POST /v1/query
Authorization: Bearer pq_pk_live_…

{ "q": "dental implants", "limit": 3 }
```

```json
{
  "results": [
    {
      "score": 0.91,
      "excerpt": "Dr. Patel did my implant and I honestly forgot it wasn't my own tooth within a week.",
      "review": { "rating": 5, "author_name": "Marcus T.", "source": "google", "occurred_at": "2026-03-14" }
    }
  ]
}
```

Businesses have hundreds of genuine reviews and show visitors the same five, picked by hand, on one testimonials page. ProofQL makes the whole corpus queryable so every page can show the reviews relevant to *that* page: the implants page shows implant reviews, the pricing page shows reviews about value, the location page shows reviews that mention parking. Topics are emergent. Nothing is tagged by hand; matching is semantic.

ProofQL is horizontal. The search core does not know or care what industry a review is about.

## What it does

1. **Ingest.** A push API accepts reviews in a normalized shape from any source. A Google Business Profile connector follows once Google approves API access. CSV upload in the dashboard covers everyone else on day one.
2. **Index.** Every review is embedded whole, and longer reviews also get sentence-window chunks so a review that covers four topics matches four queries. Vectors and a full-text index live in Postgres. No LLM touches your reviews.
3. **Serve.** A query API runs hybrid search (vector similarity fused with full-text rank), applies a relevance floor and the project's publication policy, and returns ranked excerpts with their parent reviews. An empty result beats an irrelevant one. A tiny JS snippet renders results on any site with one script tag.

## Status

Pre-code. The scope, architecture, API contract, and milestone plan are in [docs/scope.md](docs/scope.md). The backlog lives in GitHub issues; the roadmap issue is pinned.

The idea comes from [well-regarded](https://github.com/plattegruber/well-regarded), where review placement was one feature of a larger healthcare product. ProofQL is that feature as a standalone, horizontal product with a free tier generous enough for anyone, built fresh.

## Demo

The hosted demo is a fictional dentist's website — Cedar Ridge Dental, the
seeded demo project — using the snippet on four sections: implants, kids,
parking, and a whole-review feed. It is the page `workers/cdn` serves at
`/demo/`; the hosted URL lands here once the Cloudflare account is
provisioned (`infra/provisioning.md`, "Demo project on preview").

Run it locally now:

```sh
pnpm run setup                        # Postgres, migrations, seed → prints the demo keys
pnpm dev --filter @proofql/api --filter @proofql/cdn
# copy the *live publishable* key (pq_pk_live_…) from the seed output, then open
open "http://localhost:8800/demo/?key=pq_pk_live_…&api=http://localhost:8797"
```

No key is committed anywhere: the page reads `?key=` (and the API origin
from `?api=`) out of its own URL and builds the script tag from them. The
local seed embeds with a bag-of-words fake, so the page's queries are phrased
to share words with the seeded reviews; against real embeddings any phrasing
works. See [`workers/cdn/README.md`](workers/cdn/README.md).

## Quickstart

Prerequisites:

- **Node 22** — pinned in `.nvmrc` (`nvm use` picks it up).
- **pnpm 10** — pinned via the `packageManager` field; `corepack enable` makes `pnpm` resolve to the right version automatically.
- **Docker** (Desktop, or any daemon with compose v2) — runs the local Postgres.

```sh
git clone https://github.com/plattegruber/proofql && cd proofql
corepack enable
pnpm i          # install all workspace dependencies
pnpm run setup  # copy example env files, start Postgres (docker compose), run migrations
pnpm dev        # boot every worker side by side (turbo terminal UI — one pane per worker)
```

> Note it's `pnpm run setup`, **not** bare `pnpm setup` — the bare form invokes
> pnpm's own built-in `setup` command (which configures `PNPM_HOME` and edits
> your shell rc) instead of the repo script. See Troubleshooting.

`pnpm run setup` is idempotent — run it whenever you pull new migrations. It never overwrites an existing `.env` or `.dev.vars`. It applies migrations and then reseeds the demo project (Cedar Ridge Dental, 80 reviews, live and test API keys printed at the end — see `packages/db/README.md` "Demo seed"); `pnpm seed` reruns just the seed.

After `pnpm run setup && pnpm dev` you have:

| Service | Where | Notes |
|---|---|---|
| Postgres 16 + pgvector | `localhost:54323` | `postgres://proofql:proofql@localhost:54323/proofql` (local-only credentials) |
| `workers/api` | <http://localhost:8797> | Hono API worker — `GET /health` → `{ "ok": true }` |
| `workers/pipeline` | <http://localhost:8798> | queue consumer (Miniflare-simulated queue) — `GET /health` |
| `apps/dashboard` | <http://localhost:8799> | customer dashboard (React Router v7 via Vite + workerd) — `GET /health`; runs with the local auth stub as the seeded demo account until Clerk keys are in `apps/dashboard/.dev.vars` (see `apps/dashboard/README.md`) |
| `workers/cdn` | <http://localhost:8800> | the snippet (`/v1.js`, `/v1.<hash>.js`) and the demo site (`/demo/`) from Workers static assets — `GET /health` → `{ "ok": true, "version", "hash" }` |

Ports are fixed in each workspace's `wrangler.jsonc` (inspector ports 9239–9242; full matrix and bindings in [`infra/environments.md`](infra/environments.md)). To run a subset, filter: `pnpm dev --filter @proofql/api`.

Everyday commands:

```sh
pnpm build      # build all workspaces
pnpm test       # run every workspace's Vitest unit suite (no services needed)
pnpm lint       # biome check per workspace, via turbo
pnpm typecheck  # tsc --noEmit in every workspace, no build required
```

Biome replaces ESLint + Prettier; run `pnpm lint:fix` before pushing. See [CONTRIBUTING.md](CONTRIBUTING.md) for branches, PRs, and the test split.

## Troubleshooting

**`pnpm setup` printed pnpm-home instructions / edited my shell rc.** Bare `pnpm setup` is pnpm's built-in command for provisioning `PNPM_HOME` — it shadows the repo's `setup` script and appends a `# pnpm` block to your `~/.zshrc`/`~/.bashrc` (safe to delete). Use `pnpm run setup`.

**`pnpm run setup` fails with "The Docker daemon is not running".** The script checks `docker info` before touching compose. Start Docker Desktop (or your daemon), wait for it to finish booting, and re-run. If instead you see "Docker is not installed", install Docker Desktop first.

**Port 54323 already in use.** Something else grabbed our Postgres port. Find it with `lsof -i :54323`. If it's a stale `proofql-db-1` container from another checkout, `docker compose down` in that checkout (or `docker stop <id>`); otherwise stop the offender or change the port mapping locally in `docker-compose.yml` (and everywhere the canonical connection string appears).

**Schema looks wrong / migrations fail after a destructive schema change.** The named volume outlives `docker compose down`. Wipe and rebuild: `docker compose down -v && pnpm run setup`. (Migrations are append-only — see CONTRIBUTING — so a healthy volume never needs this; it's for local experiments gone sideways.)

**pnpm version mismatch / "This project is configured to use pnpm@…".** The repo pins pnpm via `packageManager`. Run `corepack enable` once so the pinned version is used automatically; if corepack itself is missing, install Node 22 (`nvm use`) which bundles it.

**`wrangler dev` fails with "address already in use" (8797–8800 or 9239–9242).** Each worker's port is fixed in its `wrangler.jsonc`. Usually the culprit is a previous `pnpm dev` that didn't fully exit — find it with `lsof -i :8797` (or whichever port) and kill the stale `workerd`/`wrangler` process.

**`wrangler dev` errors about a local Postgres connection string for Hyperdrive, or DB queries fail.** Check Postgres is healthy (`docker compose ps` should say `healthy`) and that the worker's `.env` (not `.dev.vars` — wrangler ignores this var there) contains `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` with the canonical connection string — `pnpm run setup` creates it from `.env.example`. The suffix after `_STRING_` must exactly match the binding name (`HYPERDRIVE`); a mismatch fails silently.
