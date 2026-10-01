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
| `app/routes.ts` | `/` → `/app`; `/sign-in/*`, `/sign-up/*`; `/app/workspace`; the protected `/app` layout with the overview and `/app/projects/:slug/{reviews,playground,keys,settings}`; `POST /webhooks/clerk`; `GET /health`. |
| `app/lib/account.server.ts` | `requireAccount(args)` — **the auth seam** (below). |
| `app/lib/accounts.ts` | Account/project queries, including the idempotent upsert by `clerk_org_id`. |
| `app/lib/clerk.server.ts` | Clerk middleware built per request with keys from the Workers env. |
| `app/lib/clerk-webhook.server.ts` | Svix-verified webhook: `organization.created|updated` upsert, `organization.deleted` soft-marks (`accounts.deleted_at`). |
| `app/components/` | Shell (top bar, left nav, page header), `ui/` primitives (button, badge, card, skeleton, link tabs). |

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
