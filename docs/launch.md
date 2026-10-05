# Launch checklist (issue #51)

The one document to work through before public signup opens. Every item has
an **owner** (you, or "agent" for something already in the tree), the exact
command or click path, and a **verify** step. Work top to bottom; the order
is the dependency order (domains before Clerk production, legal before
Google verification, everything before Go). Tick the boxes in this file in a
PR, or in a copy of this file in the #51 issue body, so the state is
visible. #51 closes when the Go step is done and 48 hours of day-one
monitoring have passed without a rollback.

What is already built and only needs switching on is marked **agent**. What
needs a human with the real accounts is marked **owner** and carries an
effort estimate. Nothing here needs new code except where it says so.

| # | Section | Owner | Effort | Gate for |
|---|---|---|---|---|
| 1 | [Accounts and provisioning](#1-accounts-and-provisioning) | owner | 2–3 h once | everything |
| 2 | [Domains](#2-domains) | owner | 1 h + DNS propagation | Clerk prod, WAF, Google verification |
| 3 | [Secrets](#3-secrets) | owner | 30 min | first prod deploy |
| 4 | [Google](#4-google) | owner | 1 h + 1–6 weeks lead time | connector only, not launch |
| 5 | [Legal](#5-legal) | owner + counsel | 1–2 h, plus counsel's time | Clerk prod, Google verification |
| 6 | [Clerk production instance](#6-clerk-production-instance) | owner | 1 h | sign-in on prod |
| 7 | [Billing](#7-billing) | — | 0 (deferred) | not a gate |
| 8 | [Observability](#8-observability) | owner | 30 min | day-one monitoring |
| 9 | [Status page](#9-status-page) | owner | 30 min (placeholder) | not a gate |
| 10 | [Backups](#10-backups) | owner | 15 min | launch |
| 11 | [Support](#11-support) | owner | 20 min | launch |
| 12 | [Smoke test on prod](#12-smoke-test-on-prod) | owner | 30 min | Go |
| 13 | [Go](#13-go) | owner | 5 min | — |
| 14 | [Day-one monitoring](#14-day-one-monitoring) | owner | 10 min × a few, 48 h | closing #51 |
| 16 | [Running on the free plan](#16-running-on-the-free-plan) | owner | 5 min a day | upgrading to Workers Paid (#143) |

Companion documents: [`infra/provisioning.md`](../infra/provisioning.md)
(the accounts, step by step), [`docs/secrets.md`](secrets.md) (every value
and where it lives), [`docs/security.md`](security.md) (§7 WAF rules),
[`docs/observability.md`](observability.md) (the event catalogue),
[`docs/places.md`](places.md) (Google Places terms), the roadmap
[#52](https://github.com/plattegruber/proofql/issues/52).

---

## 1. Accounts and provisioning

**Owner.** Everything in [`infra/provisioning.md`](../infra/provisioning.md)
steps 1–14, issue #14. Nothing in the launch depends on code that is not
merged; it depends on these resources existing.

- [ ] Cloudflare: `wrangler login`, Account ID noted (step 1).
- [ ] KV namespaces, queues, R2 buckets, Hyperdrive configs created; ids pasted into the three `wrangler.jsonc` env blocks (steps 3, 4, 7).
- [ ] Neon project `proofql` with branches `prod` and `preview` (step 6).
- [ ] CI token and GitHub secrets, `production` environment with you as required reviewer (steps 8–9).
- [ ] First preview migration and manual deploy; `DEPLOY_ENABLED=true` (steps 10–12).
- [ ] First **prod** deploy: `gh workflow run deploy.yml -f environment=prod`, approve `migrate-prod` then `deploy-prod` (step 13).
- [ ] Places API key on the dashboard in both envs (step 14).

**Verify** — "done" is all four lines true:

```sh
node scripts/check-provisioning.mjs                       # All bindings provisioned.
gh secret list -R plattegruber/proofql                    # CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, NEON_PREVIEW_DATABASE_URL
gh secret list -R plattegruber/proofql --env production   # NEON_PROD_DATABASE_URL
for w in api pipeline cdn dashboard; do curl -fsS "https://proofql-$w-prod.$WORKERS_SUBDOMAIN.workers.dev/health"; echo; done
```

Then close #14.

## 2. Domains

**Owner.** Scope §7.6. Five hostnames on the `proofql.com` zone, all served
by Workers with Cloudflare-managed certificates (no certificate step; a
`custom_domain` route creates the DNS record and the certificate on
deploy):

| Host | Worker | Where the route goes |
|---|---|---|
| `proofql.com` (apex) | none yet | a redirect rule (below) until a landing site exists |
| `api.proofql.com` | `proofql-api-prod` | `workers/api/wrangler.jsonc` → `env.prod.routes` (the `TODO(api.proofql.com)` comment) |
| `cdn.proofql.com` | `proofql-cdn-prod` | `workers/cdn/wrangler.jsonc` → `env.prod.routes` (`TODO(cdn.proofql.com)`) |
| `app.proofql.com` | `proofql-dashboard-prod` | `apps/dashboard/wrangler.jsonc` → `env.prod.routes` (`TODO(app.proofql.com)`) |
| `docs.proofql.com` | `proofql-docs-prod` | `docs/site/wrangler.jsonc` → `env.prod.routes` (`TODO(docs.proofql.com)`) |

1. [ ] **Zone.** Register or transfer `proofql.com` and add it to the Cloudflare account (Dashboard → Add a domain → follow the nameserver change). Verify: `dig NS proofql.com +short` shows two `*.ns.cloudflare.com` names and the zone says **Active**.
2. [ ] **Token scopes.** Add **Zone → Workers Routes: Edit** and **Zone → DNS: Edit** for this zone to the `proofql-github-actions` token (provisioning step 8). Verify: `curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify | jq .result.status` → `"active"`, and the next prod deploy does not fail with code 10000.
3. [ ] **Routes.** In each of the four `wrangler.jsonc` files above, replace the TODO comment in `env.prod` with
   `"routes": [{ "pattern": "<host>", "custom_domain": true }]`. In the same PR: `apps/dashboard/wrangler.jsonc` `env.prod.vars.API_URL` → `https://api.proofql.com`; the smoke step in `.github/workflows/deploy.yml` (prod job) → the new hosts; the README "Demo" link → `https://cdn.proofql.com/demo/?key=…`; remove the "Where the dashboard is" caution from `docs/site/src/content/docs/getting-started.md`. Title: `infra: custom domains`, `Part of #51`. Merge; run the prod deploy. Verify:

   ```sh
   curl -fsS https://api.proofql.com/health            # {"ok":true}
   curl -fsSI https://cdn.proofql.com/v1.js | grep -i cache-control
   curl -fsS https://app.proofql.com/health            # {"ok":true,"worker":"dashboard"}
   curl -fsSI https://docs.proofql.com/errors | head -1  # 200
   ```

4. [ ] **Apex.** Until a landing site exists the apex and `/pricing` redirect to the docs: DNS → add a proxied `AAAA proofql.com 100::` record (a placeholder origin so the redirect rule has something to attach to), then Rules → Redirect Rules → create: `(http.host eq "proofql.com" and http.request.uri.path eq "/pricing")` → `https://docs.proofql.com/limits` (301), and a second rule `(http.host eq "proofql.com")` → `https://docs.proofql.com/` (302, so it can change). `PRICING_URL` in `@proofql/core` stays `https://proofql.com/pricing`; the Limits page is where the plan table lives. Verify: `curl -sI https://proofql.com/pricing | grep -i location` → the limits page.
5. [ ] **WAF.** Apply the four rules in [`docs/security.md` §7](security.md#7-owner-side-settings-cloudflare-dashboard) (rate-limit backstop by IP on `api.`, no-User-Agent block on ingest, Bot Fight Mode on the dashboard host only, Managed Ruleset). Verify: Security → WAF lists W1, W2; Security → Bots shows Bot Fight Mode on; `for i in $(seq 1 700); do curl -s -o /dev/null https://api.proofql.com/v1/query; done` ends in 429s from Cloudflare (then wait 10 s).
6. [ ] **Clerk DNS** happens in §6 (Clerk needs the zone first).

Preview keeps its `workers.dev` hostnames; give it `*-preview.proofql.com`
hosts the same way only if a stable preview URL is wanted.

## 3. Secrets

**Owner.** Every row marked *now* in [`docs/secrets.md`](secrets.md) exists
in both environments. The deploy rows were created in §1; this is the
runtime set, per worker, per env.

```sh
cd apps/dashboard
for env in preview prod; do
  pnpm exec wrangler secret put CLERK_SECRET_KEY               --env $env   # development instance for preview, production for prod (§6)
  pnpm exec wrangler secret put CLERK_WEBHOOK_SIGNING_SECRET   --env $env   # one endpoint per env (§6)
  openssl rand -base64 32 | pnpm exec wrangler secret put SESSION_SECRET --env $env
  pnpm exec wrangler secret put GOOGLE_PLACES_API_KEY          --env $env   # provisioning step 14
done
cd ../..
```

Non-secret vars live in `wrangler.jsonc` and are committed: `CLERK_PUBLISHABLE_KEY`
(`pk_test_…` in `env.preview`, `pk_live_…` in `env.prod`), `API_URL`,
`SUPPORT_EMAIL` (§11). `SIGNUP_OPEN` is a var in preview (`"true"`) and a
wrangler secret in prod (§13) — deliberately absent from `env.prod.vars`.

The api and pipeline need **no** runtime secret today. When the Google
connector merges (#45, #46) its rows (`CREDENTIALS_KEY`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_STATE_SECRET`) flip to *now* in
secrets.md and get set the same way from `workers/api` and
`workers/pipeline`; that PR says so.

- [ ] preview: all four dashboard secrets set.
- [ ] prod: all four dashboard secrets set.
- [ ] `node scripts/check-provisioning.mjs` still prints `All bindings provisioned.` (the publishable keys are placeholders it checks).

**Verify**

```sh
cd apps/dashboard && for env in preview prod; do echo $env; pnpm exec wrangler secret list --env $env; done; cd ../..
# four names per env: CLERK_SECRET_KEY, CLERK_WEBHOOK_SIGNING_SECRET, SESSION_SECRET, GOOGLE_PLACES_API_KEY (+ SIGNUP_OPEN in prod after §13)
```

## 4. Google

**Owner.** Four separate tracks; only the fourth gates the launch.

1. [ ] **Business Profile API access (#44).** File it **now**; lead time 1–6 weeks and nothing else on this page waits for it. Steps and the exact wording are in the issue. Verify: Cloud Console → APIs & Services → Business Profile APIs → Quotas shows 300 QPM (was 0); record the case number in #44.
2. [ ] **OAuth verification (scope §7.2).** Needed before the public can connect Google accounts through the connector (#45) — not before launch, because the connector ships behind #44 anyway. Prerequisites it will ask for, all produced here: the homepage (`https://proofql.com`, §2), the privacy policy and terms URLs (§5), a demo video of the connect flow (record once #45 is on preview), and the sensitive scope `https://www.googleapis.com/auth/business.manage` with its justification ("read the business's own reviews, with its consent, to display them on its own website"). Click path: Cloud Console → APIs & Services → OAuth consent screen → Publishing status → **Publish app** → **Prepare for verification**. Verify: the consent screen status reads *In production* with no "unverified app" warning on the connect flow.
3. [ ] **Places API key (#47).** Provisioning step 14; §3 sets it. Verify: the prod dashboard → a project → Import → "Find your business on Google" shows a search box, not "Not configured"; a search logs `places.searched`.
4. [ ] **Places retention decision (#116).** Decide before Go, record the decision in `docs/places.md` "Terms and attribution" and close #116. Recommendation (from the issue): option 2 — expire bootstrap-only rows after 30 days unless the connector has re-imported them; that is a small pipeline sweep, filed as its own task when you decide. If you choose option 1, paste the source (Google support reply or the terms text) into the doc. Verify: #116 closed; `docs/places.md` no longer says "Open point for the owner".

## 5. Legal

**Owner + counsel.** Three things need the privacy policy and terms URLs:
Clerk's production instance (sign-up consent links), Google's OAuth consent
screen (§4.2), and the API spec's `info` block. The URLs exist now and are
stable — `https://docs.proofql.com/privacy` and `https://docs.proofql.com/terms`
(`PRIVACY_URL`, `TERMS_URL` in `@proofql/core`) — so every integration can
be wired today; the **text** is a placeholder.

**Agent (done):** the two pages in `docs/site/src/content/docs/privacy.mdx`
and `terms.mdx`, each under a "Draft — needs counsel" banner
(`src/components/LegalNotice.astro`), with every unconfirmed statement
marked `[PLACEHOLDER]`; `docs/api/openapi.yaml` `info.contact`,
`info.termsOfService` and `info.license.url` point at them; the dashboard and
docs footers link them.

1. [ ] Send counsel the two pages plus the facts they need: the legal entity, address and jurisdiction; the processors table (Cloudflare, Neon, Clerk, Google); log retention (decide a number — Workers Logs keep 7 days on Free, 30 on Paid, which bounds what you can promise); the deletion grace period after a workspace is deleted; the liability cap. Effort: an hour to brief, counsel's time to draft.
2. [ ] Replace the text, delete every `[PLACEHOLDER]`, remove the `<LegalNotice />` line from both pages, set the "Last updated" date. One PR, `Part of #51`. Verify: `grep -rn "PLACEHOLDER\|LegalNotice" docs/site/src/content/docs/privacy.mdx docs/site/src/content/docs/terms.mdx` prints nothing; `pnpm --filter @proofql/docs check` passes; the pages render without the caution box on `https://docs.proofql.com/privacy` and `/terms` after the deploy.
3. [ ] Paste both URLs into Clerk (§6.6) and the Google consent screen (§4.2).

## 6. Clerk production instance

**Owner.** The development instance (`pk_test_…`) serves local and preview;
prod needs the production instance of the same application
(`app_3K61mygiVkqZZcrltxAu8UpG5kx`). It needs the domain (§2) first: Clerk's
production Frontend API lives on your zone.

1. [ ] **Create it.** Clerk dashboard → the ProofQL application → instance switcher (top left, "Development") → **Create production instance** → clone settings from development. Domain: `proofql.com` (the dashboard is `app.proofql.com`; Clerk serves `clerk.proofql.com` and `accounts.proofql.com`).
2. [ ] **DNS.** Clerk → Configure → **Domains** lists the records (CNAMEs for `clerk`, `accounts`, `clkmail`, and two DKIM `clk._domainkey`/`clk2._domainkey`). Add each in Cloudflare DNS with the proxy **off** (grey cloud, "DNS only") — Clerk terminates TLS itself and a proxied record breaks its certificate issuance. Verify: Clerk's Domains page shows every record **Verified** and the SSL certificate **Issued**; `dig CNAME clerk.proofql.com +short` returns a `*.clerk.services` host.
3. [ ] **Keys.** Configure → API keys: paste `pk_live_…` into `apps/dashboard/wrangler.jsonc` `env.prod.vars.CLERK_PUBLISHABLE_KEY` (PR, `Part of #51`); `wrangler secret put CLERK_SECRET_KEY --env prod` with `sk_live_…` (§3). The CSP derives Clerk's origin from the publishable key, so nothing else changes.
4. [ ] **Paths and redirects.** Configure → **Paths**: sign-in `https://app.proofql.com/sign-in`, sign-up `https://app.proofql.com/sign-up`, after sign-in/sign-up `https://app.proofql.com/app`, home `https://app.proofql.com`. Allowed redirect origins: only needed for non-Clerk-domain hosts; the `workers.dev` prod hostname is one — add `https://proofql-dashboard-prod.<subdomain>.workers.dev` there only if you keep using it after the domain exists (you should not).
5. [ ] **Organizations.** Configure → Organizations: enabled, "Allow users to create organizations" on (a workspace is an organization; `requireAccount` needs one). Same as development.
6. [ ] **Legal links.** Configure → Settings → **Legal**: privacy `https://docs.proofql.com/privacy`, terms `https://docs.proofql.com/terms`, "Require express consent" on (§5).
7. [ ] **Webhook.** Configure → Webhooks → Add endpoint `https://app.proofql.com/webhooks/clerk`, events `organization.created`, `organization.updated`, `organization.deleted`; copy the signing secret → `wrangler secret put CLERK_WEBHOOK_SIGNING_SECRET --env prod` (§3). Verify: the endpoint's **Testing** tab → send `organization.created` → `2xx`; `wrangler tail proofql-dashboard-prod` shows the webhook line.
8. [ ] **Google sign-in.** Configure → SSO connections → Google: production instances must use **your own** OAuth client (the shared development credentials do not work in production). Cloud Console (the project from §4) → Credentials → Create OAuth client (Web) with the redirect URI Clerk shows (`https://clerk.proofql.com/v1/oauth_callback`); paste client id and secret into Clerk. Verify: "Continue with Google" on `https://app.proofql.com/sign-in` completes against a real Google account.
9. [ ] **Sign-up mode.** Configure → **Restrictions** → Sign-up mode **Restricted** until §13 (the `/sign-up` page is closed by `SIGNUP_OPEN`, this is the server-side belt behind it). Allowlist your own address(es) so §12 can create a test account.

**Verify** (end to end): sign up with an allowlisted address at
`https://app.proofql.com/sign-up`, create a workspace at `/app/workspace`,
land on `/app/onboarding`; the `accounts` row exists
(`psql "<prod DIRECT string>" -c "select name, created_at from accounts order by created_at desc limit 3"`).

## 7. Billing

**Not required to launch the free tier.** Stripe (#48) is user-gated on the
Stripe account and lands after launch. Until then:

- The paid plan is **"contact us"**: `PRICING_URL` (`https://proofql.com/pricing`) redirects to the docs Limits page (§2.4), whose plan table shows both tiers, and the footer's support address is how someone asks. Upgrading an account is the ops command `pnpm db:set-plan -- --account <org_…> --plan paid` (`packages/db/README.md`), run by you against the prod branch (`DATABASE_URL=<prod DIRECT string>`).
- [ ] Add one sentence to the Limits page when the first paid customer asks ("Paid plans are arranged by email until self-serve billing opens"), or leave it: the terms page already says so.
- The `STRIPE_*` rows in secrets.md stay *M3* until #48.

## 8. Observability

**Agent (done):** every `wrangler.jsonc` has `observability.enabled: true`
with `head_sampling_rate: 1`, so Workers Logs captures every request's
structured lines ([`docs/observability.md`](observability.md)).

- [ ] **Workers Logs is on per worker.** Verify after the first prod deploy: Dashboard → Workers & Pages → `proofql-api-prod` → **Logs** shows lines; repeat for `proofql-pipeline-prod`, `proofql-dashboard-prod`, `proofql-cdn-prod`, `proofql-docs-prod`. Retention is 7 days on Workers Free, 30 on Paid (which is also what §5 can promise).
- **`wrangler tail` recipes** (from the repo root; `--format pretty` for eyes, `--format json` for `jq`):

  ```sh
  W="pnpm --filter @proofql/api exec wrangler"
  $W tail proofql-api-prod       --format pretty --status error          # 5xx only
  $W tail proofql-api-prod       --format pretty --search query.rejected
  $W tail proofql-pipeline-prod  --format pretty                          # queue batches, review.indexed, dlq
  $W tail proofql-dashboard-prod --format pretty --search onboarding      # onboarding.step / completed / dismissed
  $W tail proofql-cdn-prod       --format pretty                          # /health, 404s and / only: snippet loads are static assets (#158)
  $W tail proofql-docs-prod      --format pretty
  # One event's fields, as JSON: the logger prints one JSON object per line
  $W tail proofql-api-prod --format json \
    | jq -c '.logs[].message[0] | fromjson? | select(.event == "query.completed") | {returned, cached, took_ms, search_ms}'
  ```

- [ ] **Alert on 5xx.** Cloudflare Notifications has **no Workers error-rate alert** below Enterprise ("Advanced Error Rate Alert" and "Traffic Anomalies" are Enterprise; "Health Checks" needs Pro). So:
  1. Dashboard → Notifications → **Add** → search "Workers"; if your plan offers a Workers error alert, pick it for `proofql-api-prod` and `proofql-dashboard-prod` with an email destination, and skip the next line.
  2. Otherwise use a free external monitor on the health endpoints: Better Stack (free tier), UptimeRobot (free, 5-min interval) or the Upptime repo from §9, checking `https://api.proofql.com/health`, `https://app.proofql.com/health`, `https://cdn.proofql.com/health`, `https://proofql-pipeline-prod.<subdomain>.workers.dev/health` (the pipeline has no custom host), each with "expected body contains `"ok":true`" and email/SMS on failure. This catches a worker that is down, not an elevated 5xx rate; the 5xx rate is a Workers Logs query during day one (§14) and the Logs page's status-code chart, until the account is on a plan with error alerts.
  3. Verify: break something on purpose — `wrangler secret delete SESSION_SECRET --env preview` on **preview**, load the preview dashboard, confirm the monitor (or the alert) fires within its interval, then `wrangler secret put` it back.
- [ ] **Billing alerts.** Dashboard → Notifications → Add → **Usage Based Billing** (Workers requests, Workers AI neurons, KV, Queues) with thresholds a little above the expected first-month numbers; and in Google Cloud a budget on the Places project (provisioning step 14).

## 9. Status page

**Owner, placeholder.** Not a launch gate; the GitHub issues are the public
status and roadmap until a page exists (the docs footer and the landing
page's "Status and roadmap" line link to them).

- [ ] Pick one: **Upptime** (free, a public GitHub repo of scheduled Actions that probe URLs and publish a static status site — fits a public repo and a `status.proofql.com` CNAME to GitHub Pages), Better Stack or Instatus (free tiers, hosted). Create it with the four health URLs from §8.
- [ ] DNS: `CNAME status.proofql.com` → the provider's target, proxy off if the provider manages TLS.
- [ ] Add `STATUS_URL` to `packages/core/src/contact.ts` and a "Status" link beside "Status and roadmap" in `apps/dashboard/app/components/shell/site-footer.tsx` and `docs/site/src/components/Footer.astro` (one small PR; the constants are the only place the URLs live).

**Verify:** `curl -sI https://status.proofql.com | head -1` → 200; the page shows the four checks green.

## 10. Backups

**Owner.** Neon keeps a point-in-time history per branch; a restore is a
branch created at a timestamp. The retention window is a project setting.

- [ ] **Window.** Neon console → project `proofql` → **Settings** → **Storage** (or "History retention") → set the restore window to the plan's maximum (Free: 6 hours; Launch: 7 days; Scale: 30 days). Decide whether 6 hours is acceptable for launch; if not, upgrade the project to Launch before Go. Verify: the setting page shows the chosen window.
- [ ] **Restore test, one line.** Create a branch of `prod` as it was ten minutes ago, count rows, delete it:

  ```sh
  P=<project-id>
  TS=$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)          # GNU date: date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ
  neonctl branches create --name restore-test --parent "$TS" --project-id $P   # `--parent` takes a branch, LSN or RFC 3339 timestamp; prod is the default branch
  psql "$(neonctl connection-string restore-test --database-name proofql --project-id $P)" -c 'select count(*) from accounts, (select count(*) from reviews) r;'
  neonctl branches delete restore-test --project-id $P
  ```

  Verify: the `psql` line prints counts (the branch is a real, queryable copy). To restore for real, Neon console → Branches → `prod` → **Restore** → pick the timestamp (it renames the current branch `prod_old_<ts>` and keeps it), then `wrangler hyperdrive update <prod id> --connection-string=<new pooled string>` if the connection string changed — it does not change on an in-place restore.
- [ ] Note the window in the privacy policy's retention section if counsel wants it (§5).

## 11. Support

**Owner.** The address shown in every footer, the OpenAPI `info.contact`,
and the "Contact" sections of the legal pages.

- [ ] **Mailbox.** Cheapest: Cloudflare **Email Routing** on the zone (Email → Email Routing → **Create address** `support@proofql.com` → forward to your mailbox; add the MX/TXT records it asks for — the wizard adds them). Replying "from" `support@` needs a sending mailbox (Google Workspace, Fastmail) or Gmail's "Send mail as" with Cloudflare's SMTP relay; decide one. Verify: `echo test | mail -s test support@proofql.com` (or any mail client) arrives in your inbox; a reply shows `support@proofql.com` as sender.
- [ ] **The address in the product.** If the mailbox is not `support@proofql.com`, change it in three places: `SUPPORT_EMAIL` in the three `vars` blocks of `apps/dashboard/wrangler.jsonc` (footer and sign-in pages read it), the repository variable the docs build reads (`gh variable set SUPPORT_EMAIL -R plattegruber/proofql --body "<address>"`; `.github/workflows/deploy.yml` passes it to `astro build`), and `DEFAULT_SUPPORT_EMAIL` in `packages/core/src/contact.ts` (the fallback, the spec's `info.contact.email`, and `docs/api/openapi.yaml` which repeats it as text). If it **is** `support@proofql.com`, nothing to change: that is the default everywhere.
- [ ] Verify: the footer on `https://app.proofql.com/sign-in` and on `https://docs.proofql.com/` shows the address as a `mailto:` link; `curl -s https://docs.proofql.com/ | grep -o 'mailto:[^"]*'`.

## 12. Smoke test on prod

**Owner.** Two passes, both against `api.proofql.com` / `app.proofql.com`
after §1–§11: the browser walkthrough below, and the curl pass, which is
[`scripts/demo.sh`](../scripts/demo.sh) (#31) pointed at prod.

**Browser walkthrough** (the M2 exit, now on prod):

1. [ ] `https://app.proofql.com/sign-up` with an allowlisted address (§6.9) → create a workspace → land on `/app/onboarding`.
2. [ ] Step 1: name a project; copy both keys from the page (they are shown once).
3. [ ] Step 2: upload `packages/core/test/fixtures/csv/` any `*.csv`, or use "Find your business on Google" with a real business (one billable Places call), or run the curl below with the secret key.
4. [ ] Step 3: the meter reaches "Indexed N of N"; `wrangler tail proofql-pipeline-prod` shows `review.indexed` lines and no `dlq`.
5. [ ] Step 4: copy the snippet; the preview iframe renders results; Finish lands on the Playground.
6. [ ] Paste the snippet into a plain HTML file with the project's origin allowed (Keys → allowed origins; `file://` cannot be allowed, so serve it with `python3 -m http.server 8000` and allow `http://localhost:8000`) and see reviews render. Stopwatch from step 1 to here: the target is under five minutes (`onboarding.completed` logs `elapsed_ms`).

**curl pass** (with the secret and publishable keys from step 2, and an
origin you added under Keys → allowed origins):

```sh
API_URL=https://api.proofql.com ORIGIN=https://<an allowed origin> \
PQ_SECRET_KEY=pq_sk_live_… PQ_PUBLISHABLE_KEY=pq_pk_live_… pnpm demo
```

The script ingests six throwaway reviews (`external_id` `demo-<epoch>-n`),
waits for them to index, runs the three queries (a match, the policy gate's
`match: "none"`, a labelled `fallback=recent`), checks the cache HIT, the
highlight offsets, hide, and finally deletes the six — also on any failure
— so it leaves the project as it found it. Every step prints PASS/FAIL with
its timing and the last line carries the three numbers to record.

- [ ] `demo: 8/8 steps passed`; the 2-star review never appears (policy `min_rating` 4, asserted by the script); a wrong key is a `401`: `curl -s -o /dev/null -w '%{http_code}\n' "$API_URL/v1/query" -H "Authorization: Bearer pq_sk_live_wrong" -d '{}'`.
- [ ] Record the summary line's cold `took_ms`, HIT `took_ms`, and ingest→indexed seconds next to the preview numbers in `docs/performance.md` §5.
- [ ] Optional, recommended (#108): `pnpm load:run warm` against prod or preview with `RATE` stepped 100 → 300 for 60 s; no 53300 in `wrangler tail --status error`; record the numbers in `docs/performance.md`.

## 13. Go

**Owner.** Two switches, in this order, five minutes.

1. [ ] Clerk → production instance → Configure → Restrictions → Sign-up mode **Public** (§6.9 set it to Restricted).
2. [ ] Open the dashboard's `/sign-up`:

   ```sh
   cd apps/dashboard
   echo true | pnpm exec wrangler secret put SIGNUP_OPEN --env prod
   cd ../..
   ```

   No deploy, no PR: `SIGNUP_OPEN` is read per request (`app/lib/signup-gate.ts`). Preview is already open (`"SIGNUP_OPEN": "true"` in its vars) and local defaults open.

**Verify**

```sh
curl -s https://app.proofql.com/sign-up | grep -c "not open yet"      # 0 (was 1)
cd apps/dashboard && pnpm exec wrangler secret list --env prod | grep SIGNUP_OPEN; cd ../..
```

and in a private window `https://app.proofql.com/sign-up` shows Clerk's
card; sign up with a **non**-allowlisted address and reach `/app/onboarding`.

**Close again** (anything goes wrong): `echo false | pnpm exec wrangler secret put SIGNUP_OPEN --env prod` from `apps/dashboard`, and Clerk Restrictions back to Restricted. The waitlist page returns on the next request; signed-in accounts are unaffected.

After Go: email the waitlist (`psql "<prod DIRECT string>" -c "copy (select email from waitlist order by created_at) to stdout"`), update the README "Status" line, and the roadmap #52 (M3 exit: public signup open).

## 14. Day-one monitoring

**Owner.** For 48 hours after Go, a few times a day, Workers & Pages →
`proofql-api-prod` → **Logs** (filter by `event`), or the `wrangler tail`
recipes from §8. What to watch and what it means:

| Watch | How | Healthy | If not |
|---|---|---|---|
| **5xx** | Logs → status chart; `wrangler tail proofql-api-prod --status error`; `request.failed` lines | 0 outside your own tests | `request.failed` carries the stack: fix forward or `wrangler rollback --env prod` from the worker's directory |
| **`query.completed` floor/returned ratio** | filter `event = query.completed`; compare `returned = 0` against all | well under half of queries empty; `took_ms` p95 under 300 ms, `search_ms` p50 under 20 ms | many empty answers for real queries ⇒ the default `similarity_floor` (0.66, #138) trades recall for "empty beats irrelevant": lower it per project in Settings, or re-measure the default with `pnpm db:tune-floor` (docs/observability.md "Tuning the similarity floor"). `search_ms` climbing with one `project_id` ⇒ docs/performance.md recommendation 2 |
| **`auth.throttled`** | filter `event = auth.throttled` | none, or a handful of `phase = failure` | a sustained stream from one source is enumeration: confirm WAF rule W1 is live (§2.5); nothing else to do, the throttle is working |
| **`quota.rejected`, `ratelimit.rejected`** | filter by event | none in week one | a real customer hitting the free limits on day one is a conversation, not a bug |
| **DLQ depth** | Dashboard → Queues → `proofql-ingest-dlq-prod` → backlog; `wrangler tail proofql-pipeline-prod --search dlq`; `select count(*) from reviews where indexed_at is null and created_at < now() - interval '10 minutes'` | 0 | #72's sweep re-enqueues stuck reviews on the next cron; a growing DLQ means every review fails the same way — read one `review.index_failed` line |
| **`onboarding.completed` count and `elapsed_ms`** | filter `event = onboarding.completed` on `proofql-dashboard-prod`; `onboarding.dismissed` beside it | completions ≥ dismissals; `elapsed_ms` median under 300,000 (five minutes) | dismissals at `elapsed_ms` near 0 mean step 1 asks too much; completions slow at step 2 means imports are the wall — both are product issues to file, not incidents |
| **`import.failed` / `places.failed` (error form)** | filter by event, `level = error` | none | the error form is the one to alert on (observability.md); the warn form is expected in small numbers |
| **Workers AI / Neon** | Cloudflare → AI → usage; Neon → Monitoring → connections, storage | connections flat under the compute's `max_connections`; AI neurons within the free daily allocation | connection count climbing with RPS is #108; upgrade the Neon compute or move to the KV-served key lookup it proposes |
| **`quota.exhausted`, `kv.limit_exceeded`** | filter by event (both are free-plan daily limits, §16) | none | §16: what degrades, and the trigger to upgrade |
| **Signups** | `select count(*), max(created_at) from accounts` on prod; Clerk → Users | whatever it is — write the number down | — |

After 48 hours with no rollback: tick the last box, close #51, and update
#52 (M3 exit reached).

- [ ] 48 hours of the table above with nothing red.

## 15. Day-two operations

Things that are not part of Go but will come up in the first weeks. Each is
a documented ops command run by you against the prod branch
(`DATABASE_URL=<prod DIRECT string>`); none needs a deploy.

| Task | Command | Notes |
|---|---|---|
| **Upgrade an account to paid** | `pnpm db:set-plan -- --account <org_…> --plan paid` | §7; `packages/db/README.md` "Migration workflow". |
| **Re-index a project's reviews after a chunker change** | `pnpm db:reindex -- --project <slug\|uuid> --dry-run`, then without `--dry-run`; `--all --environment live` for every project | #127 added `sentence` chunks (migration 0008); reviews indexed before it keep `full` + `window` chunks only, so their highlights stay window-wide until re-indexed. The script marks reviews (`indexed_at = NULL`, `index_attempts = 0`) and the pipeline's five-minute sweep re-enqueues them 500 per tick, so a 5,000-review project takes about 50 minutes and one Workers AI embedding batch per review; search keeps serving the old chunks until each review is replaced. Watch `review.indexed` lines with `sentences > 0` (`wrangler tail proofql-pipeline-prod --search review.indexed`). Details: `packages/db/README.md` "Re-indexing". |
| **Check a tenant's search cost** | `pnpm --filter @proofql/db exec tsx scripts/bench-search.ts --project <slug\|uuid>` against a branch of prod | `docs/performance.md` §2: ~2.5–3 ms per 1,000 chunks; `search_ms` p50 above ~50 ms for one `project_id` is the trigger for a per-tenant partial HNSW index. |

## 16. Running on the free plan

**Owner.** ProofQL runs on the **Workers Free plan** until the first paying
customer (#143 deferred). Every allowance below is daily, resets at **00:00
UTC**, and is shared by every tenant and every worker on the account
(preview and prod included, if they share the account). #158 made sure that
spending one degrades requests rather than taking every tenant down. The
counts behind these numbers are in
[`docs/performance.md` §7](performance.md#7-running-inside-the-workers-free-plan-2026-10-05-158).

### Ceilings

| Allowance | Daily limit | Roughly what it buys today (`*.workers.dev`) |
|---|---|---|
| Workers requests (all workers) | 100,000 | ~100,000 snippet elements rendered (one api request per `[data-proofql]`; loading the snippet itself is a free static asset), minus dashboard page views and ~300 cron runs |
| KV reads | 100,000 | ~50,000–100,000 queries (1–2 reads each; ≤ 1 on a custom domain) |
| KV writes | 1,000 | ~1,000 *repeated* uncached queries stored (a one-off query never writes; none at all on a custom domain), ~10,000 reviews indexed (one write per batch), every dashboard edit that changes results (one each) |
| Hyperdrive queries | 100,000 | ~40,000 uncached queries, or ~10,000 reviews indexed |
| Queues operations | 10,000 | **~3,300 reviews indexed** (3 operations each). This is the tightest limit for imports |
| Workers AI | 10,000 neurons | ~30,000 reviews indexed, or far more queries. Not the constraint |

Cached queries cost no database queries and, on a custom domain, no KV
writes. Once `api.proofql.com` is routed (§2), the result and auth caches
move to the Workers Cache API by themselves
([`infra/environments.md`](../infra/environments.md) "Cache API").

### What degrades first

1. **A large import or re-index** (`pnpm db:reindex`, a CSV of thousands of
   reviews) hits **Queues** at ~3,300 reviews a day. The rest wait for the
   next day's sweep. Plan big imports across days, or upgrade first.
2. **KV writes** (1,000). When they run out, results stop being stored in
   KV and **cache purges are lost**: a hide, a policy edit or a newly
   indexed review can take up to the cache's 24 h TTL to show in cached
   answers. Edits still succeed. Look for `kv.limit_exceeded` with
   `site: …generation_bump`. On a custom domain query results no longer
   use KV writes at all.
3. **KV reads** (100,000). Queries are then served uncached. Every query is
   still answered, but each one spends Hyperdrive, so this leads to 4.
4. **Hyperdrive** (100,000). Uncached queries, ingest and the dashboard
   answer 503 with `Retry-After` until midnight UTC, logged as
   `quota.exhausted` at level error. **Cached answers keep being served**
   for every tenant.
5. **Workers requests** (100,000). Cloudflare error 1027 for everything,
   and nothing in code can help. Customer sites show their fallback text,
   because the snippet renders nothing on an error.

### Watch

- [ ] Once a day in week one, then weekly: Cloudflare dashboard → **Workers
  & Pages** → Overview (requests today), **Storage & Databases → KV** →
  `proofql-cache-prod` → Metrics (reads, writes), **Hyperdrive** →
  `proofql-hyperdrive-prod` → Metrics (queries), **Queues** → operations,
  **AI** → neurons. Write the day's peak beside each limit.
- [ ] Any `quota.exhausted` (level error) or `kv.limit_exceeded` line in
  Workers Logs means a limit was reached that day.

### The trigger to upgrade

Upgrade to **Workers Paid** ($5/month, #143) when **any** allowance runs
above **50 % of its daily limit on 3 days in a week**, or reaches 100 % even
once in front of customers. Upgrade immediately if the first paying customer
signs up, as the owner decided. At 50 % there is still a day's headroom for
a traffic spike or an import. Nothing in code changes on upgrade: the same
paths simply stop hitting limits. Load runs against preview spend the same
shared allowances (performance.md §6), so do not run one on the free plan.

