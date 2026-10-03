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
| `app/routes.ts` | `/` → `/app`; `/sign-in/*`, `/sign-up/*` (Clerk's sign-up, or the waitlist page while `SIGNUP_OPEN` is off — below); `/app/workspace`; the protected `/app` layout with the overview, the guided onboarding (`/app/onboarding`, `/app/onboarding/:slug/{reviews,indexing,snippet,preview,status}`), `/app/projects/new`, `/app/projects/:slug/{reviews,import,playground,keys,integrations,settings}` (+ `integrations/google/connect`), `/app/integrations/google/callback`; `POST /webhooks/clerk`; `GET /health`. |
| `app/routes/app.onboarding*` | The guided onboarding (#53, below): step 1 names the project and mints both live keys; steps 2–4 add reviews, watch indexing, and hand over the prefilled snippet with a live preview. |
| `app/lib/onboarding.ts`, `app/lib/onboarding.server.ts` | Pure rules (steps, the suggested first query, the prefilled tag, the ingest curl) and the server side (the one-hour onboarding cookie, project + keys in one transaction, indexing counts, completion). |
| `app/routes/app.projects.$slug.import.*` | The CSV/JSON import (#38): `import` (step 1, upload → R2 + `ingest_runs` row), `import/:runId/map` (step 2, detected mapping as selects, live validation in the browser), `import/:runId` (steps 3–4, progress polling and the result), `import/:runId/errors.csv` (the per-row error report). |
| `app/lib/csv.server.ts` | The import engine: upload, preview, plan, `runImport` (streams the file from R2, `normalizeRow` from `@proofql/core`, `upsertReviews` from `@proofql/db` in batches of 100, enqueues index messages), progress and the error report. Resumable from the run's counts. |
| `app/lib/background.server.ts` | Hands `runImport` to `ctx.waitUntil` with its own DB client. |
| `app/components/import-progress.tsx` | `ImportProgress` + `useImportPolling`: the "spin" the onboarding (#53) reuses. |
| `app/routes/app._index.tsx` | Overview (#36, #54): plan, badge state, an Upgrade link, and per project reviews / limit and this month's uncached queries / limit (`app/components/usage-meter.tsx`, `app/lib/usage.server.ts` reading the `usage` row the api counts into, `app/lib/usage.ts` for the meter math). |
| `app/lib/account.server.ts` | `requireAccount(args)` — **the auth seam** (below). |
| `app/lib/signup-gate.ts`, `app/lib/waitlist*.ts` | The public-signup switch and the waitlist behind it (#51, below). |
| `app/components/shell/site-footer.tsx` | Support address (`SUPPORT_EMAIL` var via `supportEmailFrom`), docs, privacy, terms — under the app shell and the auth screens. |
| `app/lib/accounts.ts` | Account/project queries, including the idempotent upsert by `clerk_org_id`. |
| `app/lib/clerk.server.ts` | Clerk middleware built per request with keys from the Workers env. |
| `app/lib/clerk-webhook.server.ts` | Svix-verified webhook: `organization.created|updated` upsert, `organization.deleted` soft-marks (`accounts.deleted_at`). |
| `app/components/` | Shell (top bar, left nav, page header), `ui/` primitives (button, badge, card, skeleton, link tabs, form fields). |
| `app/lib/projects.ts` | Pure project rules (#37/#41): `slugify`, `normalizeOrigin`, the zod schemas for create/settings/origins. Shared with the browser. |
| `app/lib/projects.server.ts` | Project writes: create (plan limit + per-account slug), settings update (reports `policyChanged`), allowed origins, delete. |
| `app/lib/api-keys.server.ts` | Keys: list (never the hash), mint via `@proofql/core` `generateApiKey`, revoke. |
| `app/lib/forms.server.ts`, `app/lib/flash.server.ts` | `parseForm` (zod → `fieldErrors`) and the signed one-shot flash cookie — [`docs/frontend-conventions.md`](../../docs/frontend-conventions.md). |
| `app/routes/app.projects.new.tsx` | Create a project; at the plan's limit the form gives way to the upgrade message. |
| `app/routes/app.projects.$slug.keys.tsx` | Keys tab (#37): table, mint with one-time reveal, inline-confirm revoke, allowed-origins editor. |
| `app/routes/app.projects.$slug.integrations.tsx` | Integrations tab (#45): the Google Business Profile connection in its three states (pending approval, not connected, connected), the location picker (saving enqueues `connection.sync`), Reconnect, inline-confirm Disconnect. |
| `app/routes/app.projects.$slug.integrations.google.connect.ts`, `app/routes/app.integrations.google.callback.ts` | The OAuth flow (#45): `connect` mints PKCE + a single-use KV nonce and 302s to Google; `callback` (one URI per environment) verifies the signed state, exchanges the code, stores AES-GCM credentials, discovers locations. |
| `app/lib/google.server.ts` | `beginConnect` / `completeConnect` / location save / disconnect over `@proofql/google` — [`docs/google.md`](../../docs/google.md) "Connecting". |
| `test/fake-google-server.ts` | The fake Google server on an ephemeral port for the integration tests (a Node adapter over the Hono app). |
| `app/routes/app.projects.$slug.settings.tsx` | Settings tab (#41): `min_rating`, `similarity_floor`, name, slug; saving bumps the project's cache generation (`CACHE` KV). Danger: delete with typed-slug confirm. |
| `app/components/` | Shell (top bar, left nav, page header), `ui/` primitives (button, badge, card, skeleton, link tabs, input, select, toaster, copy button), `form/` (field, submit button, inline confirm). |

## Where limits live

Every plan number the dashboard shows or enforces — the project allowance
(`app/lib/projects.server.ts`, `/app/projects/new`), the review cap the CSV
import truncates at (`app/lib/csv.server.ts`), the meters on the overview and
the badge mirror written on project create — is read from `PLANS` in
[`packages/core/src/plans.ts`](../../packages/core/src/plans.ts) via
`planFor(plan)`; nothing here hard-codes a limit. "Upgrade" links point at
`PRICING_URL` from the same module until billing (M3) replaces it. Plan
changes go through `setAccountPlan` in `@proofql/db` (`pnpm db:set-plan`
for ops), which also refreshes `projects.show_badge`; the api never reads
that column to decide the badge — it derives it from `accounts.plan`.

## Guided onboarding (#53)

Scope §1: sign up → import → progress bar → copy the snippet, under five
minutes, zero docs. After sign-in, an account with **zero projects** whose
`accounts.onboarding_completed_at` is null is redirected from `/app` to
`/app/onboarding` (the only onboarding logic in `app._index.tsx`). A
project with zero reviews shows a "Finish setup" rule on every project tab
linking back into step 2.

| Step | Route | What happens |
|---|---|---|
| 1 Name your project | `/app/onboarding` | One field; the slug derives from it. The action runs `startOnboardingProject`: `createProject` + a **live publishable** and a **live secret** key in one transaction, and adds the dashboard's own origin to `allowed_origins` so step 4's preview can query (remove it in Keys when done). "I'll do this later" (`intent=skip`, or `?skip=1`) sets `onboarding_completed_at` and returns to the overview. |
| 2 Add your reviews | `/app/onboarding/:slug/reviews` | Three equal cards: upload (the import wizard with `?onboarding=1`, which returns to step 3 with `?run=<id>` after the mapping is confirmed), connect Google (disabled — waiting on Google's API approval, #44), use the API (a ready-to-run `POST /v1/reviews` curl with the live secret key and three sample reviews; "Check for reviews" polls `…/status` every 2 s for a minute). |
| 3 Indexing | `/app/onboarding/:slug/indexing` | `ImportProgress` for an upload, or one meter over the project's live `reviews` vs `indexed_at` ("Indexing 212 of 340 reviews"); revalidates every 2 s and advances itself once everything is indexed. Sixty seconds with no reviews offers the way back. |
| 4 Your snippet | `/app/onboarding/:slug/snippet` | The tag from `packages/snippet/README.md` with the publishable key and `data-query` set to the suggested first query (the two most frequent co-occurring content words across the project's `full` chunks, `suggestQueryFromTexts`); copy; a live preview iframe (`…/preview`, a bare page carrying the same tag, loaded from `SNIPPET_SRC`); "Where to paste it"; the hosted demo (`<cdn>/demo/?key=…`). Finishing sets `onboarding_completed_at`, clears the cookie and opens the Playground. |

**The keys are shown once.** Only SHA-256 hashes are stored
(`api-keys.server.ts`). The plaintexts minted in step 1 live in the signed
`__pq_onboarding` cookie (same `SESSION_SECRET` as the flash) for **one
hour** (`ONBOARDING_COOKIE_MAX_AGE_S`), together with `startedAt` for the
timing and the project id; the dashboard never persists them anywhere else.
After the hour, steps 2 and 4 show a placeholder and point at Keys.

**Timing.** Every step's loader logs `onboarding.step` with `elapsed_ms`
since step 1 was first shown; `onboarding.completed` / `onboarding.dismissed`
close the clock ([`docs/observability.md`](../../docs/observability.md)).

**Local walkthrough from a fresh account.** The snippet loads from
`SNIPPET_SRC` (`http://localhost:8800/v1.js` locally — run
`pnpm --filter @proofql/cdn dev`; `https://cdn.proofql.com/v1.js`
deployed) and the preview queries the local api, so run the api and the
pipeline too. Set `AUTH_STUB_ORG_ID=org_anything` in `.dev.vars` and the
auth stub acts as an empty account with that id (created on first load)
instead of the seeded demo; clear it to go back.

## Public signup switch and the waitlist (#51)

`/sign-up` renders Clerk's sign-up while signup is open and a "ProofQL is
not open yet" page while it is closed; existing accounts sign in as usual
either way. The decision is `signupOpen(env)` (`app/lib/signup-gate.ts`):
`SIGNUP_OPEN` truthy (`true`/`1`/`yes`/`on`) opens; anything else closes;
unset opens only when `ENVIRONMENT` is `local`. Locally and in preview the
value is a var (`"true"`); in prod it is deliberately a wrangler secret so
the launch flips with `echo true | wrangler secret put SIGNUP_OPEN --env
prod` and no deploy ([`docs/launch.md`](../../docs/launch.md) "Go"). The
Clerk instance's own Restricted sign-up mode is the belt behind the page.

The closed page's form posts to the same route: `handleWaitlistSubmission`
(`app/lib/waitlist.server.ts`) parses with `waitlistFormSchema` (trimmed,
lowercased, 422 on a bad address), drops honeypot hits (200, nothing
stored), throttles per `cf-connecting-ip` with a fixed window in the `CACHE`
KV namespace (5 per hour; 429 with `Retry-After`; in-memory fallback when
the binding is absent), and inserts into `waitlist` with `ON CONFLICT DO
NOTHING` — a repeat address gets the same "you are on the list" answer, so
the page cannot be used to probe the list. Events: `waitlist.joined`,
`waitlist.throttled`, `waitlist.rejected` (docs/observability.md). To see
the closed page locally, set Clerk keys and `SIGNUP_OPEN=false` in
`.dev.vars` (the auth stub skips `/sign-up`).

## The auth seam: `requireAccount`

Every data-backed loader starts with
`const { account, orgId, userId, mode } = await requireAccount(args)` and
never looks at Clerk itself. How the account is resolved depends only on
env (`app/lib/auth-mode.ts`):

| `CLERK_SECRET_KEY` | `ENVIRONMENT` | Mode | Behaviour |
|---|---|---|---|
| set | any | `clerk` | Clerk session via `clerkMiddleware`. No user → `/sign-in?redirect_url=…`. No active Organization → `/app/workspace` (Clerk's create/select UI). Otherwise the `accounts` row for the org, created on first load with the organization's name from Clerk's Backend API. |
| empty | `local` | `stub` | **Local auth stub.** Every request acts as the seeded demo account (`org_demo_proofql`, `pnpm seed`) — or, with `AUTH_STUB_ORG_ID` set in `.dev.vars`, as an empty account with that id, created on first load — a "Local auth stub" banner shows, `/sign-in` and `/sign-up` redirect to `/app`. |
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

## Forms, toasts, pending UI

[`docs/frontend-conventions.md`](../../docs/frontend-conventions.md): the
action recipe (permission → parse → mutate → flash → redirect), `Field` and
`fieldErrors`, flash vs fetcher vs client toasts, `InlineConfirm` instead of
`window.confirm`, `SubmitButton` instead of spinners. Settings and Keys are
the reference surfaces.

## Testing

- Unit (`app/**/*.test.{ts,tsx}`): loaders as functions with injected fakes
  (`account.server.test.ts`), the webhook with a test signer
  (`test/clerk-webhook.ts`), pure rules (`projects.test.ts`), routes
  through `createRoutesStub` under happy-dom (`// @vitest-environment
  happy-dom` per file; `app.projects.$slug.keys.test.tsx` and
  `...settings.test.tsx` are the models).
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
  `@proofql/db/test` (`setupTestDb()` clones the migrated template per
  file). Actions run end to end with `createLoadContext`, `HYPERDRIVE`
  pointed at the harness database, and `MemoryKv` as `CACHE`
  (`app.projects.$slug.settings.integration.test.ts`).
