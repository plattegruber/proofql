# Provisioning checklist (M0, issue #14)

The owner runs this once, top to bottom, with the real accounts. Everything
an agent could prepare is already in the tree: the four `wrangler.jsonc`
files with `preview` and `prod` env blocks (the cdn worker's needs no ids —
it is static assets only), the deploy workflow
([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)), the
inventory of every secret ([`docs/secrets.md`](../docs/secrets.md)), and a
read-only checker for what is still unprovisioned:

```sh
node scripts/check-provisioning.mjs            # both envs, exit 1 while anything is TBD
node scripts/check-provisioning.mjs preview    # one env
```

Run it at the start to see the 14 placeholders this checklist removes, and
at the end to confirm zero remain.

**Work on a branch.** Steps 3, 7, and 9 edit the `wrangler.jsonc` files; open
one PR (`infra/provisioned-ids`, `Part of #14`) with all the pasted ids and
merge it before step 12. Ids are not secrets and belong in the tree.

**Order matters.** Cloudflare resources (steps 1–5) and Neon (step 6) are
independent; Hyperdrive (step 7) needs both; the token (8) and GitHub
secrets (9) need the account; migrations (10) need Neon; the first deploy
(11) needs everything.

Resource names are fixed by [`environments.md`](environments.md): every
cloud resource is `proofql-<thing>-<env>`.

---

## 1. Cloudflare account and `wrangler login`

Use the existing Cloudflare account (the one well-regarded will deploy to) or
create one at <https://dash.cloudflare.com/sign-up>. Workers Free covers M0
and M1: 100k requests/day, KV 100k reads/day, Queues and Hyperdrive are on
the free plan, Workers AI has a free daily allocation. Upgrade to Workers
Paid ($5/mo) when Queues throughput or Workers AI neurons run out, not
before.

```sh
cd /path/to/proofql
pnpm install
pnpm --filter @proofql/api exec wrangler login      # opens the browser; OAuth, no token
```

**Verify**

```sh
pnpm --filter @proofql/api exec wrangler whoami
```

Prints the account name, the **Account ID** (needed in step 9), and the
token scopes. Copy the Account ID now:

```sh
export CLOUDFLARE_ACCOUNT_ID=<paste>
```

> Every `wrangler` command below is run via `pnpm --filter @proofql/api exec
> wrangler …` (pinned workspace version, wrangler 4.x) from the repo root
> unless it says `cd`. A globally installed wrangler also works but may be a
> different version.

## 2. Workers AI

Nothing to create. The `AI` binding is account-level and keyless; it appears
in `env.preview` / `env.prod` of the api and pipeline configs already.

**Verify** (optional, costs a few neurons)

```sh
pnpm --filter @proofql/api exec wrangler ai models --search bge-m3
```

Lists `@cf/baai/bge-m3` — the embedding model from scope §2.

## 3. KV namespaces

One namespace per environment, shared by all three workers (the `CACHE`
binding). Create them with the `--env` flag so wrangler names them after the
worker's env block:

```sh
cd workers/api
pnpm exec wrangler kv namespace create CACHE --env preview
pnpm exec wrangler kv namespace create CACHE --env prod
cd ../..
```

Each command prints a snippet with an `id`. (wrangler names the namespaces
`proofql-api-preview-CACHE` / `proofql-api-prod-CACHE`; the name is
cosmetic — the id is what the configs reference. Rename in the dashboard to
`proofql-cache-preview` / `proofql-cache-prod` if you want the names to
match `environments.md`; the id does not change.)

Paste the preview id over `TBD-provision-in-m0` in the `kv_namespaces` entry
of **`env.preview`** in all three files, and the prod id into **`env.prod`**:

- `workers/api/wrangler.jsonc`
- `workers/pipeline/wrangler.jsonc`
- `apps/dashboard/wrangler.jsonc`

Leave the top-level (local) `TBD-provision-in-m0` alone — Miniflare ignores
it.

**Verify**

```sh
pnpm --filter @proofql/api exec wrangler kv namespace list
node scripts/check-provisioning.mjs | grep -c kv_namespaces     # expect 0
```

**Rollback:** `wrangler kv namespace delete --namespace-id <id>` (empty
namespaces, nothing lost).

## 4. Queues and R2

Four queues: the ingest queue and its dead-letter queue, per environment.
Names are already in the configs (api produces, pipeline consumes), so there
is nothing to paste:

```sh
W="pnpm --filter @proofql/api exec wrangler"
$W queues create proofql-ingest-preview
$W queues create proofql-ingest-dlq-preview
$W queues create proofql-ingest-prod
$W queues create proofql-ingest-dlq-prod
```

Both consumers (pipeline → `proofql-ingest-<env>`, `max_retries: 3`, DLQ;
and pipeline → `proofql-ingest-dlq-<env>`, `max_retries: 0`, no DLQ) are
attached automatically by the pipeline's first `wrangler deploy`; do not add
them by hand.

**Verify**

```sh
$W queues list
```

Four queues, zero consumers (consumers appear after step 11).

**Rollback:** `$W queues delete <name>` (fails while a consumer is attached;
deploy-time consumers go away with `wrangler delete --env <env>` from
`workers/pipeline`).

### R2 bucket for uploads

The dashboard stores uploaded review exports (CSV import, #38) in an R2
bucket per environment — the `UPLOADS` binding, referenced by name, so
again nothing to paste:

```sh
$W r2 bucket create proofql-uploads-preview
$W r2 bucket create proofql-uploads-prod
```

Objects live under `uploads/<projectId>/<ingestRunId>.<csv|json>` with the
import's mapping and error report beside them; nothing is public. (R2 needs
to be enabled once on the account: Dashboard → R2 → "Purchase R2" — the
free tier covers this.)

**Verify**

```sh
$W r2 bucket list
```

**Rollback:** `$W r2 bucket delete <name>` (must be empty).

## 5. workers.dev subdomain

Workers get `https://<worker-name>.<subdomain>.workers.dev` URLs. The
subdomain is per account and is what the dashboard's `API_URL` var and the
deploy workflow's smoke check are built from.

```sh
# Dashboard: Workers & Pages → Overview → right column "Your subdomain"
# (register one there if the account has none). Or, once the token from
# step 8 exists:
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" | jq -r .result.subdomain
``` Write it down:

```sh
export WORKERS_SUBDOMAIN=<subdomain>
```

**Verify:** `echo https://proofql-api-preview.$WORKERS_SUBDOMAIN.workers.dev`
looks right. (It will 404/1101 until step 11 — that is fine.)

## 6. Neon project and branches

One Neon account serves well-regarded and ProofQL as **separate projects**
(scope §7.3). Sign in at <https://console.neon.tech> with the shared
account. The free plan allows multiple projects with 0.5 GiB storage each
and scale-to-zero compute — plenty for M0–M2.

Use `neonctl` (`brew install neonctl` or `npx neonctl`), or do the same
clicks in the console:

```sh
neonctl auth                                                 # browser login
neonctl projects create --name proofql --region-id aws-us-east-1 --pg-version 16
```

Note the project id it prints (`neonctl projects list`). Pick the region
closest to where most Workers traffic will originate; Hyperdrive caches
connections at the edge, so a single region is fine.

Create the database and branches. A new project has one default branch
(`production`) and one database (`neondb`). Rename the branch to `prod`,
create the `proofql` database on it, then branch `preview` off it (empty
schema; the branches diverge from here and are **never** reset from each
other):

```sh
P=<project-id>
neonctl branches rename production prod --project-id $P
neonctl databases create --name proofql --branch prod --project-id $P
neonctl branches create --name preview --parent prod --project-id $P
```

Both branches now have an empty database `proofql` owned by the default role
`neondb_owner`. Migrations (step 10) create the `vector` extension; Neon
allows `CREATE EXTENSION vector` for the owner role, nothing to enable.

Get **two** connection strings per branch — the **pooled** one (host
`…-pooler.…neon.tech`) for Hyperdrive and the **direct** one for the
migrator:

```sh
neonctl connection-string preview --database-name proofql --pooled --project-id $P
neonctl connection-string preview --database-name proofql          --project-id $P
neonctl connection-string prod    --database-name proofql --pooled --project-id $P
neonctl connection-string prod    --database-name proofql          --project-id $P
```

Keep them in a password manager, not a file in the repo. They all embed the
role password.

**Verify**

```sh
neonctl branches list --project-id $P            # preview, prod
psql "$(neonctl connection-string preview --database-name proofql --project-id $P)" -c 'select version();'
```

(`psql` comes with Postgres; `brew install libpq` if missing. The pgvector
docker image is not needed here.)

**Rollback:** `neonctl branches delete preview --project-id $P` or
`neonctl projects delete $P`. Nothing is in them yet.

## 7. Hyperdrive configs

One per environment, pointing at that branch's **pooled** string. Hyperdrive
holds the string from here on; no worker and no GitHub secret ever contains
it.

```sh
W="pnpm --filter @proofql/api exec wrangler"
$W hyperdrive create proofql-hyperdrive-preview --connection-string="<preview POOLED string>"
$W hyperdrive create proofql-hyperdrive-prod    --connection-string="<prod POOLED string>"
```

Each prints an `id`. Paste the preview id into the `hyperdrive` entry of
**`env.preview`** in all three `wrangler.jsonc` files and the prod id into
**`env.prod`**; the top-level (local) entry stays `TBD-provision-in-m0`.

If `create` rejects the pooled host, use the direct string instead:
Hyperdrive runs its own pool, so the direct string also works; the pooled
one is preferred only because Neon's compute-side connection limit on the
free tier is small and PgBouncer multiplexes Hyperdrive's origin
connections.

**Verify**

```sh
$W hyperdrive list
node scripts/check-provisioning.mjs | grep -c hyperdrive       # expect 0
```

**Rollback:** `$W hyperdrive delete <id>`.

## 8. Cloudflare API token for CI

Create it at <https://dash.cloudflare.com/profile/api-tokens> → **Create
Token → Create Custom Token**. Name it `proofql-github-actions`. Permissions
(all **Account** scope, restricted to this one account under "Account
Resources"):

| Permission | Level | Why |
| --- | --- | --- |
| Workers Scripts | Edit | `wrangler deploy` |
| Workers KV Storage | Edit | the `CACHE` binding |
| Workers R2 Storage | Edit | the dashboard's `UPLOADS` bucket binding |
| Queues | Edit | attaching the pipeline consumer at deploy |
| Hyperdrive | Edit | the `HYPERDRIVE` binding (Read is enough for deploy; Edit lets a future workflow rotate the Neon string) |
| Workers AI | Read | the `AI` binding |
| Account Settings | Read | wrangler resolves the account |
| Workers Observability | Edit | the `observability` block in every config |

Plus **User → User Details: Read** and **Memberships: Read** (wrangler
calls `/user` and `/memberships` to resolve the account). No Zone
permissions until a custom domain exists (scope §7.6). Leave "Client IP
Address Filtering" empty (GitHub runners rotate IPs); set TTL to no expiry
and rely on rotation (docs/secrets.md).

If the first deploy fails with `Authentication error [code: 10000]`, the
message names the missing permission; add it to this token in the dashboard
("Edit") — the value does not change.

**Verify**

```sh
export CLOUDFLARE_API_TOKEN=<paste>
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/user/tokens/verify | jq .result.status   # "active"
```

**Rollback:** delete or roll the token in the same dashboard page.

## 9. GitHub: secrets, variables, and the `production` environment

From the repo root with `gh` authenticated as the repo owner:

```sh
R=plattegruber/proofql

# Repository secrets (both environments use them)
gh secret set CLOUDFLARE_API_TOKEN      -R $R --body "$CLOUDFLARE_API_TOKEN"
gh secret set CLOUDFLARE_ACCOUNT_ID     -R $R --body "$CLOUDFLARE_ACCOUNT_ID"
gh secret set NEON_PREVIEW_DATABASE_URL -R $R --body "<preview DIRECT string>"

# GitHub environment `production` with you as required reviewer, deployable
# only from protected branches (main). The prod jobs in deploy.yml wait for
# approval under Actions → the run → "Review deployments".
gh api -X PUT repos/$R/environments/production --input - <<EOF
{
  "reviewers": [{ "type": "User", "id": $(gh api user --jq .id) }],
  "deployment_branch_policy": { "protected_branches": true, "custom_branch_policies": false }
}
EOF

# Prod DB string lives only inside that environment
gh secret set NEON_PROD_DATABASE_URL -R $R --env production --body "<prod DIRECT string>"

# Non-secret variables: the smoke-check subdomain now; the switch in step 12
gh variable set WORKERS_SUBDOMAIN -R $R --body "$WORKERS_SUBDOMAIN"
```

`CLOUDFLARE_ACCOUNT_ID` is not sensitive but is kept as a secret so it is
masked in logs. The two Neon strings are the **direct** (non-pooled) ones:
the migrator opens one connection and runs DDL; PgBouncer adds nothing and
transaction pooling can confuse some DDL.

Now fill the dashboard's `API_URL` in `apps/dashboard/wrangler.jsonc`:
`env.preview.vars.API_URL` = `https://proofql-api-preview.<subdomain>.workers.dev`,
`env.prod.vars.API_URL` = `https://proofql-api-prod.<subdomain>.workers.dev`
(swap for `https://api.proofql.com` when the domain lands).

**Verify**

```sh
gh secret list -R $R                      # CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, NEON_PREVIEW_DATABASE_URL
gh secret list -R $R --env production     # NEON_PROD_DATABASE_URL
gh variable list -R $R                    # WORKERS_SUBDOMAIN
gh api repos/$R/environments/production --jq '.protection_rules[].type'   # required_reviewers, branch_policy
node scripts/check-provisioning.mjs       # "All bindings provisioned."
```

Commit the `wrangler.jsonc` changes, open the PR, let CI go green, merge.
(Nothing deploys yet: `DEPLOY_ENABLED` is unset, so the Deploy run on that
merge has four skipped jobs — expected.)

**Rollback:** `gh secret delete NAME -R $R [--env production]`,
`gh variable delete NAME -R $R`, `gh api -X DELETE repos/$R/environments/production`.

## 10. First migration (preview)

Run the migrator once from your machine so the first schema lands under your
eyes rather than inside a CI job:

```sh
DATABASE_URL="<preview DIRECT string>" pnpm db:migrate
```

**Verify**

```sh
psql "<preview DIRECT string>" -c '\dt' -c 'select count(*) from drizzle.__drizzle_migrations;'
```

Tables from `packages/db/migrations/0001_*.sql` and one migration row.
Re-running `pnpm db:migrate` is a no-op (idempotent by hash). Do **not**
migrate prod by hand; the `migrate-prod` job does it under the `production`
approval gate.

**Rollback:** `neonctl branches reset preview --parent --project-id $P`
returns the branch to prod's (empty) state. Never edit a merged migration
(CONTRIBUTING).

## 11. First deploy (preview) and smoke check

A manual first deploy from your machine uses your `wrangler login` session
and surfaces binding errors with full context. Pipeline (consumer) first,
then api, then dashboard — the order the workflow uses:

```sh
pnpm --filter @proofql/pipeline  exec wrangler deploy --env preview
pnpm --filter @proofql/api       exec wrangler deploy --env preview
pnpm --filter @proofql/dashboard exec wrangler deploy --env preview
```

**Verify**

```sh
curl -fsS https://proofql-api-preview.$WORKERS_SUBDOMAIN.workers.dev/health        # {"ok":true}
curl -fsS https://proofql-pipeline-preview.$WORKERS_SUBDOMAIN.workers.dev/health   # {"ok":true}
curl -fsS https://proofql-cdn-preview.$WORKERS_SUBDOMAIN.workers.dev/health        # {"ok":true,"version":…,"hash":…}
curl -fsSI https://proofql-cdn-preview.$WORKERS_SUBDOMAIN.workers.dev/v1.js | grep -i cache-control   # max-age=300, stale-while-revalidate
curl -sS -o /dev/null -w '%{http_code}\n' https://proofql-dashboard-preview.$WORKERS_SUBDOMAIN.workers.dev/   # 200 (placeholder page until #36)
pnpm --filter @proofql/api exec wrangler queues list                                # consumer on proofql-ingest-preview
pnpm --filter @proofql/api exec wrangler tail proofql-api-preview --format pretty   # ctrl-c after a request
```

A `1101` error page or a 500 on `/health` with a Hyperdrive message means
the Hyperdrive id or the Neon string is wrong: `wrangler hyperdrive get
<id>` shows the target host.

**Rollback:** `wrangler delete --env preview` from each worker's directory
removes the worker (and detaches the queue consumer); or
`wrangler rollback --env preview` after the second deploy onward.

## 12. Turn on the deploy workflow

The final switch. Every job in `deploy.yml` is gated on the repository
variable `DEPLOY_ENABLED`; until now every Deploy run has been four skipped
jobs.

```sh
gh variable set DEPLOY_ENABLED -R plattegruber/proofql --body true
gh workflow run deploy.yml -R plattegruber/proofql -f environment=preview
```

**Verify**

```sh
gh run watch -R plattegruber/proofql          # migrate-preview → deploy-preview, smoke check green
```

From here every merge to `main` migrates and deploys preview automatically.

**Rollback / kill switch:** `gh variable set DEPLOY_ENABLED -R
plattegruber/proofql --body false`. Takes effect on the next run; it does
not cancel a running one (`gh run cancel <id>` does).

## 13. First prod deploy (when M1 is demoable, not now)

```sh
gh workflow run deploy.yml -R plattegruber/proofql -f environment=prod
```

Approve `migrate-prod` under **Actions → the run → Review deployments**,
watch it, then approve `deploy-prod`. Smoke-check
`https://proofql-api-prod.$WORKERS_SUBDOMAIN.workers.dev/health`.

---

## Done when

- [ ] `node scripts/check-provisioning.mjs` prints `All bindings provisioned.`
- [ ] `$W r2 bucket list` shows `proofql-uploads-preview` and `proofql-uploads-prod`
- [ ] `gh secret list` shows the three repository secrets; `--env production` shows the fourth
- [ ] `/health` on preview api and pipeline returns `{"ok":true}` from the workers.dev URLs
- [ ] `DEPLOY_ENABLED=true` and one green manual run of `deploy.yml` for preview
- [ ] [`docs/secrets.md`](../docs/secrets.md) rows marked *now* all exist; close #14

## Custom domains (later, outside this checklist)

Scope §7.6: `api.proofql.com`, `cdn.proofql.com` and `docs.proofql.com`
replace the workers.dev URLs once the domain is owned and its zone is on this
Cloudflare account. Then:

1. Add **Zone → Workers Routes: Edit** and **Zone → DNS: Edit** for that zone
   to the `proofql-github-actions` token (step 8).
2. `workers/cdn/wrangler.jsonc`: in `env.prod`, replace the `TODO(cdn.proofql.com)`
   comment with
   `"routes": [{ "pattern": "cdn.proofql.com", "custom_domain": true }]`.
   `wrangler deploy --env prod` creates the DNS record and certificate. The
   snippet tag in the docs (`<script src="https://cdn.proofql.com/v1.js">`)
   and the demo link in the README then resolve; nothing in the worker
   changes. Give preview its own hostname (`cdn-preview.proofql.com`) the
   same way if a stable preview URL is wanted.
3. The api gets its route the same way, and `API_URL` in the dashboard
   config (step 9) and the smoke check in `deploy.yml` move to the new
   hostnames.
4. `docs/site/wrangler.jsonc`: in `env.prod`, replace the
   `TODO(docs.proofql.com)` comment with
   `"routes": [{ "pattern": "docs.proofql.com", "custom_domain": true }]`
   (#43). The api already emits `doc_url: https://docs.proofql.com/errors#<code>`
   in every error envelope (`ERROR_DOCS_BASE_URL`, `workers/api/src/errors.ts`)
   and the dashboard links `https://docs.proofql.com/query#relevance`, so until
   this step those links 404; nothing else depends on it.

## Demo project on preview (after step 11, for #35)

The hosted demo (`/demo/` on the cdn worker) reads its publishable key from
its URL and never ships one in the tree. Seed the preview database once —
`DATABASE_URL="<preview DIRECT string>" pnpm seed` prints the keys — add the
cdn worker's origin (`https://proofql-cdn-preview.<subdomain>.workers.dev`,
later `https://cdn.proofql.com`) to the demo project's `allowed_origins`
(dashboard → project settings, or SQL), and put the resulting link in the
README's "Demo" section:

```
https://proofql-cdn-preview.<subdomain>.workers.dev/demo/?key=pq_pk_live_…&api=https://proofql-api-preview.<subdomain>.workers.dev
```

A publishable key is public by design (it ships in page source and is
scoped by origin), so the link can be committed. `&api=` is dropped once the
api lives at `https://api.proofql.com`, the snippet's default.
