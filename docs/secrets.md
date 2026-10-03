# Secrets and configuration

Every value the system needs outside the source tree, where it lives, who
sets it, and how it rotates. The provisioning checklist that creates the
"needed now" rows is [`infra/provisioning.md`](../infra/provisioning.md); the
environment matrix (worker names, binding names, ports) is
[`infra/environments.md`](../infra/environments.md).

ProofQL has unusually few secrets by design (scope §2): embeddings and
sentiment run on Workers AI through a binding (no key), there is no LLM
vendor, and workers reach Postgres through the Hyperdrive **binding**, so no
worker ever holds a database URL. Today the secrets are the two the deploy
workflow needs, the two Neon connection strings the migrator needs, and the
dashboard's Clerk keys (M2, #36) and its Google Places key (M3, #47).

## Where values live

| Store | Holds | Set with | Read by |
| --- | --- | --- | --- |
| **GitHub Actions secret** (repository) | values CI needs for every environment | `gh secret set NAME` | `.github/workflows/deploy.yml` (`${{ secrets.NAME }}`) |
| **GitHub Actions secret** (environment `production`) | prod-only values | `gh secret set NAME --env production` | only jobs with `environment: production` |
| **GitHub Actions variable** | non-secret switches and public config | `gh variable set NAME --body VALUE` | workflows (`${{ vars.NAME }}`), usable in `if:` |
| **wrangler secret** (per worker, per env) | runtime secrets a worker reads on `env.*` | `wrangler secret put NAME --env preview\|prod` from the worker's directory | that worker, that environment |
| **`vars` in `wrangler.jsonc`** (per worker, per env) | non-secret runtime config | edit the file (all three blocks: local, `env.preview`, `env.prod`) | that worker |
| **resource ids in `wrangler.jsonc`** | KV namespace ids, Hyperdrive config ids, queue names | edit the file after `wrangler ... create` | `wrangler deploy` |
| **`.dev.vars`** (per worker, gitignored) | local values of the wrangler secrets and vars for `wrangler dev` | copy from `.dev.vars.example` (`pnpm run setup`), edit | `wrangler dev` for that worker |
| **`.env`** (per worker and root, gitignored) | wrangler *process* config (`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`) and root `DATABASE_URL` | copy from `.env.example` | the wrangler CLI; `pnpm db:migrate`, `pnpm test:integration` |
| **Neon** | the databases themselves and their connection strings | Neon console or `neonctl` | Hyperdrive (pooled string), the migrator (direct string) |
| **Cloudflare account** | Workers, KV, Queues, Hyperdrive, Workers AI, the API token | `wrangler` / dashboard | everything above |

Rules that hold everywhere:

- **Secrets never enter the tree.** `.dev.vars` and `.env` are gitignored; the
  committed `.example` files hold placeholders or local-only compose
  credentials. Never put a secret in `vars` in `wrangler.jsonc`.
- **Names are SCREAMING_SNAKE_CASE**; credentials end in `_KEY`, `_TOKEN`, or
  `_SECRET`; a name means the same thing in every worker that has it.
- **Run `wrangler secret put` from the worker's directory** so it targets that
  worker's config, and run it once per environment.
- **One Neon account, separate projects.** The Neon account is shared with
  well-regarded; ProofQL is its own project (`proofql`) with branches
  `preview` and `prod`. Nothing is shared between the projects.

## Inventory

**Status:** *now* = required for the first deploy (created by
[`infra/provisioning.md`](../infra/provisioning.md)); *M2* / *M3* = the row is
reserved, the value does not exist yet, and the code that will read it has
not landed. Placeholder rows exist so names are decided once and the schema
flip is a known step rather than a surprise.

### Deploy credentials (GitHub Actions)

| Name | Status | Secret? | Lives in | Used by | Set by | Rotation |
| --- | --- | --- | --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | now | **yes** | GitHub repository secret | `deploy.yml` → `cloudflare/wrangler-action` for every `wrangler deploy` | owner, from the Cloudflare dashboard (scopes in provisioning.md step 8) | Roll in the dashboard ("Roll" keeps the id and scopes, issues a new value) and `gh secret set` again. Rotate immediately if a run log ever prints it; the token is account-wide. |
| `CLOUDFLARE_ACCOUNT_ID` | now | no, but kept as a secret so it never appears in logs | GitHub repository secret | `deploy.yml` → `wrangler-action` `accountId` | owner (`wrangler whoami`) | Never changes. |
| `NEON_PREVIEW_DATABASE_URL` | now | **yes** (embeds the role password) | GitHub repository secret | `deploy.yml` job `migrate-preview` → `pnpm db:migrate` as `DATABASE_URL` | owner, from Neon (`preview` branch, **direct** string) | Reset the role password in Neon, then update **both** this secret and the preview Hyperdrive config (`wrangler hyperdrive update`). |
| `NEON_PROD_DATABASE_URL` | now | **yes** | GitHub **environment** secret on `production` | `deploy.yml` job `migrate-prod` | owner, from Neon (`prod` branch, direct string) | Same as preview; both the secret and `proofql-hyperdrive-prod`. |
| `DEPLOY_ENABLED` | now | no | GitHub repository **variable** | every job in `deploy.yml` (`if: vars.DEPLOY_ENABLED == 'true'`) | owner, last step of provisioning | n/a. `gh variable set DEPLOY_ENABLED --body false` is the kill switch for all deploys. |
| `WORKERS_SUBDOMAIN` | now (optional) | no | GitHub repository variable | the `/health` smoke step in `deploy.yml`; unset ⇒ the step is skipped with a notice | owner (`<subdomain>` in `https://<worker>.<subdomain>.workers.dev`) | Never changes. |

The migrator (`packages/db/scripts/migrate.ts`) is the **only** consumer of
a database URL. Workers get Postgres through the `HYPERDRIVE` binding, so
there is no `DATABASE_URL` secret on any worker and nothing to rotate there
beyond the Hyperdrive config itself.

### Cloudflare resources (ids in `wrangler.jsonc`, not secrets)

Resource ids are configuration, committed in the env blocks of the three
`wrangler.jsonc` files. `node scripts/check-provisioning.mjs [preview|prod]`
lists the ones still set to the `TBD-provision-in-m0` placeholder.

| Resource | Status | preview | prod | Set by | Workers |
| --- | --- | --- | --- | --- | --- |
| KV namespace `CACHE` | now | id of `proofql-cache-preview` | id of `proofql-cache-prod` | `wrangler kv namespace create` (provisioning step 3) → paste id | api, pipeline, dashboard |
| Queue `INGEST_QUEUE` + consumer | now | `proofql-ingest-preview`, DLQ `proofql-ingest-dlq-preview` | `proofql-ingest-prod`, DLQ `proofql-ingest-dlq-prod` | `wrangler queues create` (step 4); names are already in the configs, nothing to paste | api (producer), pipeline (consumer) |
| Hyperdrive `HYPERDRIVE` | now | id of `proofql-hyperdrive-preview` → Neon `preview` branch | id of `proofql-hyperdrive-prod` → Neon `prod` branch | `wrangler hyperdrive create --connection-string=<pooled Neon string>` (step 7) → paste id | api, pipeline, dashboard |
| Workers AI `AI` | now | binding only | binding only | nothing: account-level, no id, no key | api, pipeline |
| `API_URL` (var) | now | `https://proofql-api-preview.<subdomain>.workers.dev` | `https://proofql-api-prod.<subdomain>.workers.dev` (custom domain later, scope §7.6) | paste into `apps/dashboard/wrangler.jsonc` (step 9) | dashboard |
| `ENVIRONMENT` (var) | now | `"preview"` | `"prod"` | committed | all |

The Neon connection string embedded in a Hyperdrive config is **held by
Hyperdrive**, not by any worker and not by GitHub. Rotating the Neon
password means `wrangler hyperdrive update <id> --connection-string=...` for
that environment plus the matching `NEON_*_DATABASE_URL` secret.

### Worker runtime secrets (wrangler secrets / `.dev.vars`)

The dashboard's Clerk rows (#36) and Places key (#47) are live; the api and
pipeline still need no runtime secret, and `wrangler deploy` of those two
needs no `wrangler secret put`. The remaining rows reserve names for the milestones
that introduce them; each lands with its own PR that adds the schema check,
the `.dev.vars.example` line, and flips this table's status.

**Clerk (dashboard).** One Clerk application (`app_3K61mygiVkqZZcrltxAu8UpG5kx`,
owner-created) with a *development* instance for local and preview and a
*production* instance for prod. Locally the three values go in
`apps/dashboard/.dev.vars`; leave `CLERK_SECRET_KEY` empty and the dashboard
runs with the **local auth stub** (every request acts as the seeded demo
account, banner shown) — the stub never engages outside `ENVIRONMENT=local`.
The webhook endpoint to register in Clerk (Configure → Webhooks → Add
endpoint, events `organization.created`, `organization.updated`,
`organization.deleted`) is
`https://proofql-dashboard-<env>.<subdomain>.workers.dev/webhooks/clerk`, one
endpoint per deployed environment; its signing secret is that environment's
`CLERK_WEBHOOK_SIGNING_SECRET`. Locally, `clerk webhooks listen
--forward-to http://localhost:8799/webhooks/clerk` relays events and prints a
secret to paste into `.dev.vars`.

| Name | Status | Secret? | Workers | Local | Deployed | Rotation / notes |
| --- | --- | --- | --- | --- | --- | --- |
| `CLERK_SECRET_KEY` | **now** (#36; required for the first dashboard deploy) | **yes** | dashboard | `apps/dashboard/.dev.vars` (empty ⇒ local auth stub) | `wrangler secret put CLERK_SECRET_KEY --env preview\|prod` from `apps/dashboard` | Clerk dashboard → Configure → API keys → roll; the old key keeps working until you revoke it, so set the new one first. Development instance for local and preview, production instance for prod. |
| `CLERK_PUBLISHABLE_KEY` | **now** (#36) | no (publishable) | dashboard | `apps/dashboard/.dev.vars` | `vars` in `apps/dashboard/wrangler.jsonc` (`env.preview` and `env.prod`; placeholder `TBD-provision-in-m0` until pasted — `check-provisioning.mjs` lists it) | Changes only when the Clerk instance changes. Public by design, but still never committed from a real `.env`: paste it into the config deliberately. |
| `CLERK_WEBHOOK_SIGNING_SECRET` | **now** (#36; `POST /webhooks/clerk` answers 503 until set) | **yes** | dashboard | `apps/dashboard/.dev.vars` | `wrangler secret put CLERK_WEBHOOK_SIGNING_SECRET --env preview\|prod` from `apps/dashboard` | Clerk → Configure → Webhooks → the endpoint for `https://proofql-dashboard-<env>.<subdomain>.workers.dev/webhooks/clerk` → Signing secret. One endpoint (and secret) per environment; rotating in Clerk invalidates the old one at once, so set the new secret first, then rotate. |
| `SESSION_SECRET` | **now** (#37/#41; signs the dashboard's one-shot flash cookie, `apps/dashboard/app/lib/flash.server.ts`) | **yes** | dashboard | `apps/dashboard/.dev.vars` (empty ⇒ a fixed dev-only secret, accepted only when `ENVIRONMENT=local`) | `wrangler secret put SESSION_SECRET --env preview\|prod` from `apps/dashboard`; the app throws on the first flash without it | `openssl rand -base64 32`. Rotating only drops in-flight toasts; nothing durable is signed with it. |
| `CREDENTIALS_KEY` | M3 (Google connector; encrypts `connections.credentials`, scope §4) | **yes** | pipeline, api | `.dev.vars` in both (a dev-only value lands in `.dev.vars.example`) | `wrangler secret put CREDENTIALS_KEY --env preview\|prod` from **both** `workers/api` and `workers/pipeline`, same value | 32 random bytes, base64: `openssl rand -base64 32`. AES-256-GCM, one key per environment, **identical across the workers that share the table**. Rotation re-encrypts every `connections.credentials` row; the implementing PR must ship a versioned-key format (e.g. `{"1": "<base64>"}` like well-regarded's `PII_ENCRYPTION_KEYS`) or a re-encrypt script before the first real credential is stored. Losing the key loses every connected Google account (users reconnect). |
| `GOOGLE_CLIENT_ID` | M3 (Google OAuth client, scope §7.1–2) | no (public identifier) | api (connect flow), pipeline (token refresh while polling) | `.dev.vars` (placeholders; the fake Google server ignores them) | `vars` in both workers' `wrangler.jsonc` | Changes only if the OAuth client is recreated. |
| `GOOGLE_CLIENT_SECRET` | M3 | **yes** | api, pipeline | `.dev.vars` | `wrangler secret put GOOGLE_CLIENT_SECRET --env preview\|prod` from both workers | Google Cloud console → Credentials → the client → add a new secret, deploy it, then delete the old one. |
| `GOOGLE_OAUTH_STATE_SECRET` | M3 | **yes** | api | `.dev.vars` | `wrangler secret put ... --env preview\|prod` | `openssl rand -base64 32`; signs the anti-CSRF `state` parameter. Rotating invalidates in-flight connect attempts only. |
| `GOOGLE_PLACES_API_KEY` | **now** (#47; the "Find your business on Google" card on onboarding step 2 and the Import tab says "not configured" until set — [`docs/places.md`](places.md)) | **yes** (billable) | dashboard | `apps/dashboard/.dev.vars` (empty ⇒ card disabled; `fake` + `PLACES_API_BASE=http://localhost:8802` against `node apps/dashboard/test/fake-places-server.ts`) | `wrangler secret put GOOGLE_PLACES_API_KEY --env preview\|prod` from `apps/dashboard` (provisioning step 14) | Cloud console → APIs & Services → enable **Places API (New)** → Credentials → Create API key → API restriction "Places API (New)" only, application restriction none (used server-side from Workers). Set a billing budget alert. Rotate by creating a second key, `wrangler secret put` it, then deleting the first. |
| `PLACES_API_BASE` | now (#47) | no | dashboard | `apps/dashboard/.dev.vars` (`http://localhost:8802` for the fake) | not set: defaults to `https://places.googleapis.com` | Local override only; never point a deployed environment anywhere else. |
| `STRIPE_SECRET_KEY` | M3 (billing, scope §2) | **yes** | dashboard (or a billing worker, decided at M3) | `.dev.vars` (Stripe *test* key `sk_test_…`) | `wrangler secret put STRIPE_SECRET_KEY --env preview\|prod`; preview uses the test key, prod the live key `sk_live_…` | Stripe dashboard → Developers → API keys → roll (grace period configurable). |
| `STRIPE_WEBHOOK_SECRET` | M3 | **yes** | same worker as above | `.dev.vars` (from `stripe listen`) | `wrangler secret put STRIPE_WEBHOOK_SECRET --env preview\|prod` | One per webhook endpoint; roll in the Stripe dashboard. |
| `STRIPE_PUBLISHABLE_KEY` | M3 | no (publishable) | dashboard | `.dev.vars` | `vars` in `apps/dashboard/wrangler.jsonc` | Changes with the Stripe account/mode. |

Not in the table on purpose:

- **`ANTHROPIC_API_KEY` and any LLM key** — scope §2 "LLMs: none in v0".
- **`DATABASE_URL` on a worker** — workers use the `HYPERDRIVE` binding
  (`env.HYPERDRIVE.connectionString`). The root `.env` `DATABASE_URL` is
  tooling config for the compose Postgres, not a secret.
- **Anything Workers AI** — the `AI` binding needs no key. Locally the
  binding is absent and code uses the deterministic fake provider from
  `@proofql/ai`.

## Local development

Nothing secret is needed to run `pnpm run setup && pnpm dev` or any test
level: the compose Postgres credentials (`proofql:proofql@localhost:54323`)
are local-only and committed in `docker-compose.yml` and the `.env.example`
files, and the dashboard runs with its local auth stub until Clerk keys are
pasted into `apps/dashboard/.dev.vars` (never `.env`: see the `.env` vs
`.dev.vars` table in [`infra/environments.md`](../infra/environments.md)).
The Clerk CLI's `clerk init` / `clerk env pull` write `.env.local`; move the
values into `.dev.vars` and delete that file (`.env.local` is gitignored as
a backstop).

## Adding a variable or secret

1. Decide the name here first (table row, status, workers, rotation note).
2. Add the placeholder line to each affected worker's `.dev.vars.example`
   (secrets: comment or dev-only value; never a real one).
3. If the worker validates its env at startup, add the field to that schema
   (optional until the real value exists, with a `TODO(#issue)` to flip it).
4. Set it: `.dev.vars` locally; `wrangler secret put NAME --env preview` and
   `--env prod` from the worker's directory, or `vars` in all three blocks
   of its `wrangler.jsonc` for non-secrets.
5. Flip the row's status in this file in the same PR.

## Incident checklist

- **Token leaked in a log or a PR:** roll `CLOUDFLARE_API_TOKEN` in the
  Cloudflare dashboard first (it is account-wide), `gh secret set` the new
  value, then audit the Workers audit log for deploys you did not make.
- **Neon password exposed:** reset the role password on the affected branch
  in Neon; update the Hyperdrive config for that environment
  (`wrangler hyperdrive update`) *before* the GitHub secret, because
  Hyperdrive serves live traffic and the migrator runs only on deploy.
- **Stop all deploys:** `gh variable set DEPLOY_ENABLED --body false`.
- **Roll back a worker:** `wrangler rollback --env preview|prod` from the
  worker's directory (Cloudflare keeps the previous versions). Migrations do
  not roll back; fix forward (CONTRIBUTING "Database migrations").
