# @proofql/dashboard

The customer dashboard: React Router v7 (framework mode, SSR) running on
Cloudflare Workers through `@cloudflare/vite-plugin`, Tailwind v4 with the
inherited design tokens (`app/app.css`, `app/styles/tokens/`), and Clerk for
sign-in, where a Clerk **Organization is an account** (scope §2, §4).

```sh
pnpm dev --filter @proofql/dashboard   # http://localhost:8799 (Vite + workerd)
pnpm --filter @proofql/dashboard test            # unit (Vitest, no services)
pnpm --filter @proofql/dashboard test:integration # needs DATABASE_URL
pnpm --filter @proofql/dashboard build           # build/ (client + server + wrangler.json)
CLOUDFLARE_ENV=preview pnpm --filter @proofql/dashboard build && pnpm --filter @proofql/dashboard exec wrangler deploy --dry-run --env preview
```

## Layout

| Path | What |
|---|---|
| `workers/app.ts` | The Worker. Mints the request id, builds the request-bound logger, and puts `{ env, ctx, log, requestId }` on the router context (`app/lib/context.ts`). |
| `app/root.tsx` | Fonts and tokens, the Clerk middleware/provider pair (mounted only when Clerk is configured), the error boundary. |
| `app/routes.ts` | `/` → `/app`; `/sign-in/*`, `/sign-up/*`; `/app/workspace`; the protected `/app` layout with the overview and `/app/projects/:slug/{reviews,import,playground,keys,settings}`; `POST /webhooks/clerk`; `GET /health`. |
| `app/routes/app.projects.$slug.import.*` | The CSV/JSON import (#38): `import` (step 1, upload → R2 + `ingest_runs` row), `import/:runId/map` (step 2, detected mapping as selects, live validation in the browser), `import/:runId` (steps 3–4, progress polling and the result), `import/:runId/errors.csv` (the per-row error report). |
| `app/lib/csv.server.ts` | The import engine: upload, preview, plan, `runImport` (streams the file from R2, `normalizeRow` from `@proofql/core`, `upsertReviews` from `@proofql/db` in batches of 100, enqueues index messages), progress and the error report. Resumable from the run's counts. |
| `app/lib/background.server.ts` | Hands `runImport` to `ctx.waitUntil` with its own DB client. |
| `app/components/import-progress.tsx` | `ImportProgress` + `useImportPolling`: the "spin" the onboarding (#53) reuses. |
| `app/lib/account.server.ts` | `requireAccount(args)` — **the auth seam** (below). |
| `app/lib/accounts.ts` | Account/project queries, including the idempotent upsert by `clerk_org_id`. |
| `app/lib/clerk.server.ts` | Clerk middleware built per request with keys from the Workers env. |
| `app/lib/clerk-webhook.server.ts` | Svix-verified webhook: `organization.created|updated` upsert, `organization.deleted` soft-marks (`accounts.deleted_at`). |
| `app/components/` | Shell (top bar, left nav, page header), `ui/` primitives (button, badge, card, skeleton, link tabs, form fields). |

## The auth seam: `requireAccount`

Every data-backed loader starts with
`const { account, orgId, userId, mode } = await requireAccount(args)` and
never looks at Clerk itself. How the account is resolved depends only on
env (`app/lib/auth-mode.ts`):

| `CLERK_SECRET_KEY` | `ENVIRONMENT` | Mode | Behaviour |
|---|---|---|---|
| set | any | `clerk` | Clerk session via `clerkMiddleware`. No user → `/sign-in?redirect_url=…`. No active Organization → `/app/workspace` (Clerk's create/select UI). Otherwise the `accounts` row for the org, created on first load with the organization's name from Clerk's Backend API. |
| empty | `local` | `stub` | **Local auth stub.** Every request acts as the seeded demo account (`org_demo_proofql`, `pnpm seed`), a "Local auth stub" banner shows, `/sign-in` and `/sign-up` redirect to `/app`. |
| empty | anything else | `unconfigured` | 503 with the fix. Never a silent stub outside local. |

This is Well-Regarded's `requirePracticeContext()` pattern: when real auth
is wanted, one function changes behaviour and nothing that calls it moves.
To use Clerk locally, paste the development instance's keys into
`.dev.vars` (`.dev.vars.example` has the names; `clerk env pull` writes an
`.env.local` — move the values and delete it).

## Owner steps for a deployed environment

1. `wrangler secret put CLERK_SECRET_KEY --env preview|prod` from this directory.
2. Paste the publishable key into `vars.CLERK_PUBLISHABLE_KEY` of the matching env block in `wrangler.jsonc` (replacing `TBD-provision-in-m0`).
3. In Clerk → Configure → Webhooks, add `https://proofql-dashboard-<env>.<subdomain>.workers.dev/webhooks/clerk` with the `organization.*` events and `wrangler secret put CLERK_WEBHOOK_SIGNING_SECRET --env preview|prod` with its signing secret.

Full inventory and rotation notes: [`docs/secrets.md`](../../docs/secrets.md).

## Testing

- Unit (`app/**/*.test.{ts,tsx}`): loaders as functions with injected fakes
  (`account.server.test.ts`), the webhook with a test signer
  (`test/clerk-webhook.ts`), routes through `createRoutesStub` under
  happy-dom (`// @vitest-environment happy-dom` per file).
- Integration (`app/**/*.integration.test.ts`): the real schema via
  `@proofql/db/test` (`setupTestDb()` clones the migrated template per file).
  The import suite (`csv.server.integration.test.ts`) uses `test/fake-r2.ts`
  — an in-memory `UploadStore` and a recording queue — against the fixtures
  in `packages/core/test/fixtures/csv`.

## Bindings beyond the scaffold

| Binding | Used by | Local |
|---|---|---|
| `UPLOADS` (R2) | The import stores uploads at `uploads/<projectId>/<runId>.<csv\|json>`, the confirmed mapping at `….plan.json`, the error report at `….errors.json`. | Miniflare's R2 simulator (`.wrangler/state`). |
| `INGEST_QUEUE` (producer) | One `review.index` message per imported review, after each batch commits — the same message `POST /v1/reviews` sends. | Miniflare's queue; run the pipeline worker alongside (`pnpm dev`) to see reviews become indexed. |
