# @proofql/api

The public API worker (`proofql-api-<env>`): Hono on Cloudflare Workers,
Postgres through Hyperdrive, Workers AI for query embeddings, the Workers
Cache API (custom domains) or KV under a write budget (`*.workers.dev`) for
the query cache, KV for the cache generations (`src/edge-cache.ts`, #158). The contract is [`docs/api/openapi.yaml`](../../docs/api/openapi.yaml);
the architecture is [`docs/scope.md`](../../docs/scope.md) §3.

```sh
pnpm dev --filter @proofql/api                      # http://localhost:8797 (wrangler dev)
pnpm --filter @proofql/api test                     # unit (Vitest, no services)
DATABASE_URL=… pnpm --filter @proofql/api test:integration   # real Postgres, incl. the OpenAPI contract tests
pnpm --filter @proofql/api exec wrangler deploy --dry-run --env preview
```

## Layout

| Path | What |
|---|---|
| `src/worker.ts` | The wrangler entrypoint; `src/app.ts` is the composition root tests build with `createApp({ db })`. |
| `src/auth.ts` | Bearer / `?key=` auth. One statement resolves the key with its project's policy **and the account's plan** (`auth.plan`). |
| `src/rate-limit.ts` | Per-key rate limits, selected by plan and key kind (below). |
| `src/quota.ts` | The monthly uncached-query quota from the `usage` table; 429 `query_quota_exceeded` with `Retry-After` to month end. |
| `src/query/` | `/v1/query`: request parsing, the result cache (Cache API or KV), the handler. `badge` in the response is `planFor(auth.plan).badge`. |
| `src/routes/` | `/v1/reviews` ingest (422 `review_limit_reached` at the plan's cap, nothing written) and CRUD. |
| `src/errors.ts` | The error envelope and the code → status table. |

## Where limits live

Every number a plan changes — projects, reviews per project, uncached
queries per month, the snippet badge, the per-kind rate limits — is one
table, `PLANS` in [`packages/core/src/plans.ts`](../../packages/core/src/plans.ts),
read through `planFor(plan)`. This worker never hard-codes a limit:

- **Review cap** — `upsertReviews` in `@proofql/db`, under a row lock, before anything is written.
- **Query quota** — `src/quota.ts`, on a cache miss only (cached hits are free on every plan).
- **Badge** — `src/query/route.ts`, derived per request from `auth.plan`; `projects.show_badge` is a mirror the db package keeps in step (`syncProjectBadges`), not something this worker reads.
- **Rate limits** — `src/rate-limit.ts`. The Cloudflare rate limiting bindings have their limit fixed in `wrangler.jsonc`, so there is one binding per `(plan, key kind)`: `RL_SECRET` / `RL_PUBLISHABLE` (free) and `RL_SECRET_PAID` / `RL_PUBLISHABLE_PAID` (paid). Adding a plan means a row in `PLANS` plus the matching `ratelimits` entries in all three `wrangler.jsonc` blocks; `src/rate-limit.test.ts` reads the config and fails when the two disagree.

Over-limit responses are deliberate, not accidents: the message names the
plan, the limit and `PRICING_URL` (the upgrade placeholder until billing,
M3). The snippet renders nothing on any non-2xx, so a site at its limit
shows an empty widget, never a broken page.

## Bindings

See [`infra/environments.md`](../../infra/environments.md) for the matrix.
`AI` is bound in preview/prod only (no local simulator; the deterministic
fake embedder from `@proofql/ai` stands in). The `RL_*` bindings are
optional in code: without them the worker falls back to an in-memory
limiter per isolate, configured from the same plan table.
