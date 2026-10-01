# Contributing

Start with the [README](README.md) for what the product is and [docs/scope.md](docs/scope.md) for the architecture, API contract, and the decisions behind them. This document covers the mechanics: branches, PRs, tests, and how work is tracked.

## Branches and pull requests

- Work happens on short-lived branches off `main`, named `<area>/<slug>` — e.g. `api/query-endpoint`, `db/reviews-table`, `infra/scaffold`.
- One PR per issue. Every PR references its issue in the body: `Closes #N`. If you find adjacent work, file an issue rather than growing the diff.
- Fill in the [PR template](.github/pull_request_template.md): **What** (with the `Closes #N` line), **Why**, **Testing** (which levels ran), **Screenshots** (dashboard and snippet PRs; "n/a" elsewhere).
- CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml), #12) runs five parallel checks on every PR and every push to `main`: **lint**, **typecheck**, **test** (unit), **integration** (real Postgres with pgvector in a service container), and **migration-check** (the append-only and no-drift gates from [Database migrations](#database-migrations)). All five are required by branch protection ([`infra/README.md`](infra/README.md)); a red check blocks the merge button, for admins too.
- PRs are **squash-merged**. Keep the PR title in the imperative — it becomes the commit message on `main`.
- If `main` moved since your branch was created, update the branch (rebase or merge `main` in, re-push) and let CI re-run before merging.
- All review conversations must be resolved before merge.

## Tests

Two levels, from cheapest to most expensive.

| Level | How to run |
|---|---|
| Unit | `pnpm test` — Vitest, colocated `*.test.ts` files in every workspace; excludes `*.integration.test.ts`; needs no services |
| Integration | `pnpm test:integration` — Vitest against the real local Postgres from `pnpm run setup` (docker compose); set `DATABASE_URL=postgres://proofql:proofql@localhost:54323/proofql` (the root `.env.example` carries it); file convention `*.integration.test.ts`; harness arrives with the `db` package (#15) |

The split is by file glob and nothing else:

- **`*.integration.test.ts`** ⇒ needs Postgres. Runs only under `pnpm test:integration` (uncached in turbo — a shared mutable database is not a cacheable input). Requires `DATABASE_URL`; the run **fails** when it is unset or the database is unreachable — integration tests never silently skip.
- **Anything else (`*.test.ts`)** ⇒ must run with no services. `pnpm test` never needs Docker or a network.

Any workspace that grows `*.integration.test.ts` files adopts a Vitest projects config with `unit` and `integration` projects on exactly those globs, so its `test` script keeps excluding the integration files.

Ground rules that hold at every level:

- Pure logic (chunking, key validation, policy, normalization) must be unit-testable without network or DB.
- No test may call a real external API. External services get local fakes (deterministic embedding provider, fake Google server).
- Relevance is tested, not assumed: the "empty beats irrelevant" property from the scope doc gets fixtures and assertions, not a vibe check.

## Database migrations

Schema lives in `packages/db/src/schema`; migrations live in `packages/db/migrations` (full workflow in `packages/db/README.md` once #15 lands).

- **Migrations are append-only once merged.** A broken merged migration is fixed by a **new corrective migration**, never by editing the old one. CI diffs the PR against its merge-base with the base branch and fails on any modification, deletion, or rename of an existing `*.sql` migration.
- **No drift.** If the schema changed, run `pnpm db:generate` and commit the SQL, the `meta/*_snapshot.json`, and the `meta/_journal.json` update together. CI re-runs `generate` and fails if it produces anything.
- **Expand → migrate → contract.** Migrations run before workers deploy, so every migration must be compatible with the *currently deployed* code. Add first, ship code that uses it, remove the old shape later.
- Use the pinned workspace `drizzle-kit` via the pnpm scripts, never a global one.

## Lint and format

Biome for both lint and format — no ESLint, no Prettier:

```sh
pnpm lint       # check (per workspace, via turbo)
pnpm lint:fix   # auto-fix + format
pnpm format     # format only
```

Run `pnpm lint:fix` before pushing. TypeScript compiler options live in the shared [`packages/tsconfig`](packages/tsconfig) package (`base.json`, `worker.json`, `react.json`) — every workspace extends one of those; do not add per-workspace strictness overrides.

## Issue workflow

All work is tracked as GitHub issues; the roadmap (#52) is pinned.

- **Epics** carry the `epic` label and own milestones. They hold the invariants and context their children must respect.
- **Work items** reference their epic and close via PR.
- If completing a task requires making an architectural decision, the issue is wrong — comment and fix the issue (or [docs/scope.md](docs/scope.md)) first.
- Anything bigger than ~3 days gets split.
