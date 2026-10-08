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

**Current state:** [`docs/go-live.md`](go-live.md) audits every item below against production (2026-10-08) and lists the remaining owner steps in order, with `scripts/signup-switch.sh` for §13.

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
curl -fsS "https://proofql-pipeline-prod.$WORKERS_SUBDOMAIN.workers.dev/health"; echo
for h in api cdn app; do curl -fsS "https://$h.proofql.dev/health"; echo; done   # after the first prod deploy (§2)
```

Then close #14.

## 2. Domains

**Owner.** Scope §7.6, #167. The zone is **`proofql.dev`**, already active
on the Cloudflare account (`6f9565cb51f0bb050c420ca18dfff22f`, nameservers
`aarav.ns.cloudflare.com` / `laylah.ns.cloudflare.com`). The four product
hosts are Workers Custom Domains already in the tree: the first prod deploy
creates their proxied DNS records and Cloudflare-managed certificates, with
no DNS or certificate step from you. The apex and `www` are yours (a
redirect rule, below).

| Host | Served by | Configured in |
|---|---|---|
| `proofql.dev`, `www.proofql.dev` | redirect rules (step 4) today; `proofql-www-prod` after the cutover (step 7) | Cloudflare dashboard; then `apps/www/wrangler.jsonc` → `env.prod.routes` |
| `api.proofql.dev` | `proofql-api-prod` | `workers/api/wrangler.jsonc` → `env.prod.routes` |
| `cdn.proofql.dev` | `proofql-cdn-prod` | `workers/cdn/wrangler.jsonc` → `env.prod.routes` |
| `app.proofql.dev` | `proofql-dashboard-prod` | `apps/dashboard/wrangler.jsonc` → `env.prod.routes` |
| `docs.proofql.dev` | `proofql-docs-prod` | `docs/site/wrangler.jsonc` → `env.prod.routes` |
| `clerk.`, `accounts.`, `clkmail.`, `clk._domainkey.`, `clk2._domainkey.` | Clerk | DNS records from Clerk (§6, step 2) |

1. [x] **Zone.** `proofql.dev` is on the account. Verify: `dig NS proofql.dev +short` → `aarav.ns.cloudflare.com.`, `laylah.ns.cloudflare.com.`.
2. [ ] **Token scopes.** API Tokens → `proofql-github-actions` → Edit → add **Zone → Workers Routes: Edit** and **Zone → DNS: Edit**, Zone Resources "Specific zone → `proofql.dev`" (provisioning step 8). The token value does not change. Verify: `curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify | jq .result.status` → `"active"`, and the prod deploy does not fail with code 10000.
3. [ ] **First prod deploy.** The routes are in the tree; provisioning step 13 runs it (`gh workflow run deploy.yml -R plattegruber/proofql -f environment=prod`). Its "Smoke check custom domains" step checks all four hosts. Verify by hand:

   ```sh
   curl -fsS https://api.proofql.dev/health              # {"ok":true}
   curl -fsSI https://cdn.proofql.dev/v1.js | grep -i cache-control
   curl -fsS https://app.proofql.dev/health              # {"ok":true,"worker":"dashboard"}
   curl -fsSI https://docs.proofql.dev/errors | head -1  # 200
   ```

   Workers & Pages → each prod worker → Settings → **Domains & Routes** lists its custom domain as Active. `workers_dev` is `false` in these four `env.prod` blocks, so their prod `*.workers.dev` URLs stop answering at this deploy (only the pipeline keeps one); that is intended (no WAF bypass, and Clerk's production instance only works on `proofql.dev` hosts anyway). Then update the README "Demo" link to `https://cdn.proofql.dev/demo/?key=…` (no `&api=`) and remove the "Where the dashboard is" note from `docs/site/src/content/docs/getting-started.md`.
4. [ ] **Apex, `www` and `/pricing`.** Until the marketing site is live (step 7) the apex redirects to the docs. `PRICING_URL` in `@proofql/core` is `https://proofql.dev/pricing` (the dashboard's upgrade link), so `/pricing` needs its own rule.
   1. DNS → Records → **Add record**: type `AAAA`, name `@`, IPv6 `100::`, **Proxied** (orange cloud). Again for name `www`. `100::` is a discard address: the records only exist so the proxy (and so the redirect rules) sees the requests.
   2. Rules → **Redirect Rules** → Create rule "pricing": custom filter expression `(http.host in {"proofql.dev" "www.proofql.dev"} and http.request.uri.path eq "/pricing")` → URL redirect, type **Static**, URL `https://docs.proofql.dev/limits`, status **302**, preserve query string off.
   3. Create a second rule "apex to docs", ordered **after** "pricing": `(http.host in {"proofql.dev" "www.proofql.dev"})` → Static `https://docs.proofql.dev`, status **302** (temporary, so browsers do not cache it once a landing page replaces it), preserve query string off.
   4. Verify: `curl -sI https://proofql.dev/pricing | grep -i '^location'` → `https://docs.proofql.dev/limits`; `curl -sI https://www.proofql.dev/ | grep -i '^location'` → `https://docs.proofql.dev/`.
5. [ ] **WAF** ([`docs/security.md` §7](security.md#7-owner-side-settings-cloudflare-dashboard)), on the `proofql.dev` zone after step 3:
   1. Security → WAF → **Rate limiting rules** → Create "W1 api backstop": expression `(http.host eq "api.proofql.dev" and starts_with(http.request.uri.path, "/v1/"))`, counting characteristic **IP**, **600 requests per 10 seconds**, action **Block**, duration **10 seconds**. (The Free plan allows one rate limiting rule; this is it.)
   2. Security → WAF → **Custom rules** → Create "W2 ingest without User-Agent": `(http.host eq "api.proofql.dev" and starts_with(http.request.uri.path, "/v1/reviews") and len(http.user_agent) eq 0)` → **Block**.
   3. Security → Bots: **Bot Fight Mode stays off** (W3). It is zone-wide and would challenge `api.` and `cdn.`, which blanks customer pages.
   4. Security → WAF → **Managed rules**: deploy the Cloudflare Managed Ruleset with its default action (W4), if the plan offers it; on Free the "Cloudflare Free Managed Ruleset" is on by default — leave it on.
   5. Verify: Security → WAF lists W1 and W2; `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.proofql.dev/v1/reviews -A ''` → `403`; `for i in $(seq 1 700); do curl -s -o /dev/null -w '%{http_code}\n' https://api.proofql.dev/v1/query; done | sort | uniq -c` shows 429s from Cloudflare (wait 10 s afterwards).
6. [ ] **Clerk DNS** happens in §6, step 2; **Email Routing** for `support@proofql.dev` in §11.
7. [ ] **Marketing site cutover** (`apps/www`, the landing page at `proofql.dev`). The site already deploys to preview on every push to `main` (`https://proofql-www-preview.<subdomain>.workers.dev/`, smoke-checked by the deploy). Its prod config is in the tree (`apps/www/wrangler.jsonc` → `env.prod`: Workers Custom Domains `proofql.dev` and `www.proofql.dev`, `workers_dev: false`), but the prod deploy skips it until you set `WWW_PROD_ENABLED`: a custom domain cannot attach to a hostname that already has DNS records, so deploying it over step 4's setup would fail the whole prod deploy. In this order:
   1. Check the preview: open the workers.dev URL above, read the page, try the demo tabs.
   2. Rules → **Redirect Rules** → delete **"apex to docs"**. **Keep "pricing"** (recommended): Redirect Rules run before Workers, so `https://proofql.dev/pricing` (`PRICING_URL`, the dashboard's upgrade link) keeps going to `https://docs.proofql.dev/limits` until a pricing page exists. `apps/www/public/_redirects` sends `/pricing` to the same place, so dropping the rule instead also works; it just moves the redirect into the Worker.
   3. DNS → Records → delete the two **AAAA `100::`** records (names `@` and `www`). From here until the deploy below, `proofql.dev` and `www` do not resolve, so do steps 3–5 together.
   4. `gh variable set WWW_PROD_ENABLED --body true -R plattegruber/proofql`, then `gh workflow run deploy.yml -R plattegruber/proofql -f environment=prod` and approve it. The "Deploy proofql-www-prod" step creates both custom domains (proxied records and certificates); "Smoke check marketing site domains" retries until they answer.
   5. Verify: `curl -fsSI https://proofql.dev/ | head -1` → `200`; `curl -fsSI https://www.proofql.dev/ | head -1` → `200`; `curl -sI https://proofql.dev/pricing | grep -i '^location'` → `https://docs.proofql.dev/limits`; Workers & Pages → `proofql-www-prod` → Settings → **Domains & Routes** lists both as Active.
   6. Rollback: `gh variable set WWW_PROD_ENABLED --body false`, delete the two custom domains on `proofql-www-prod` (Domains & Routes), then redo step 4's records and "apex to docs" rule.

Preview keeps its `workers.dev` hostnames; give it `*-preview.proofql.dev`
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
2. [ ] **OAuth verification (scope §7.2).** Needed before the public can connect Google accounts through the connector (#45) — not before launch, because the connector ships behind #44 anyway. Prerequisites it will ask for, all produced here: the homepage (`https://proofql.dev`, §2), the privacy policy and terms URLs (§5), a demo video of the connect flow (record once #45 is on preview), and the sensitive scope `https://www.googleapis.com/auth/business.manage` with its justification ("read the business's own reviews, with its consent, to display them on its own website"). The connector's OAuth client (infra/provisioning.md "Track 2") lists exactly two authorised redirect URIs: the preview `workers.dev` one and, for prod, **`https://app.proofql.dev/app/integrations/google/callback`**; add `proofql.dev` under the consent screen's **Authorised domains**. Click path: Cloud Console → APIs & Services → OAuth consent screen → Publishing status → **Publish app** → **Prepare for verification**. Verify: the consent screen status reads *In production* with no "unverified app" warning on the connect flow.
3. [ ] **Places API key (#47).** Provisioning step 14; §3 sets it. Verify: the prod dashboard → a project → Import → "Find your business on Google" shows a search box, not "Not configured"; a search logs `places.searched`.
4. [ ] **Places retention decision (#116).** Decide before Go, record the decision in `docs/places.md` "Terms and attribution" and close #116. Recommendation (from the issue): option 2 — expire bootstrap-only rows after 30 days unless the connector has re-imported them; that is a small pipeline sweep, filed as its own task when you decide. If you choose option 1, paste the source (Google support reply or the terms text) into the doc. Verify: #116 closed; `docs/places.md` no longer says "Open point for the owner".

## 5. Legal

**Owner + counsel.** Three things need the privacy policy and terms URLs:
Clerk's production instance (sign-up consent links), Google's OAuth consent
screen (§4.2), and the API spec's `info` block. The URLs exist now and are
stable — `https://docs.proofql.dev/privacy` and `https://docs.proofql.dev/terms`
(`PRIVACY_URL`, `TERMS_URL` in `@proofql/core`) — so every integration can
be wired today; the **text** is a placeholder.

**Agent (done):** the two pages in `docs/site/src/content/docs/privacy.mdx`
and `terms.mdx`, each under a "Draft — needs counsel" banner
(`src/components/LegalNotice.astro`), with every unconfirmed statement
marked `[PLACEHOLDER]`; `docs/api/openapi.yaml` `info.contact`,
`info.termsOfService` and `info.license.url` point at them; the dashboard and
docs footers link them.

1. [ ] Send counsel the two pages plus the facts they need: the legal entity, address and jurisdiction; the processors table (Cloudflare, Neon, Clerk, Google); log retention (decide a number — Workers Logs keep 3 days on Free, 7 on Paid, which bounds what you can promise); the deletion grace period after a workspace is deleted; the liability cap. Effort: an hour to brief, counsel's time to draft.
2. [ ] Replace the text, delete every `[PLACEHOLDER]`, remove the `<LegalNotice />` line from both pages, set the "Last updated" date. One PR, `Part of #51`. Verify: `grep -rn "PLACEHOLDER\|LegalNotice" docs/site/src/content/docs/privacy.mdx docs/site/src/content/docs/terms.mdx` prints nothing; `pnpm --filter @proofql/docs check` passes; the pages render without the caution box on `https://docs.proofql.dev/privacy` and `/terms` after the deploy.
3. [ ] Paste both URLs into Clerk (§6.6) and the Google consent screen (§4.2).

## 6. Clerk production instance

**Owner.** The development instance (`pk_test_…`) serves local and preview;
prod uses the production instance of the same application
(`app_3K61mygiVkqZZcrltxAu8UpG5kx`) on the domain **`proofql.dev`**: the
dashboard is `app.proofql.dev`, Clerk's Frontend API is `clerk.proofql.dev`
and its account portal `accounts.proofql.dev`.

1. [x] **Create it.** Done: the production instance exists with domain `proofql.dev`.
2. [ ] **DNS.** Clerk dashboard → instance switcher → **Production** → Configure → **Domains**. It lists the records to add, typically five CNAMEs: `clerk`, `accounts`, `clkmail`, `clk._domainkey`, `clk2._domainkey`. Copy each name and target **exactly as Clerk shows it** (the targets are per-instance; do not guess them). In Cloudflare → `proofql.dev` → DNS → Records → **Add record** for each: type `CNAME`, name as shown, target as shown, **Proxy status: DNS only** (grey cloud, proxy **off**). Clerk terminates TLS on these hosts itself; a proxied record breaks its certificate issuance and the DKIM lookups. Then **Verify configuration** on Clerk's Domains page. Verify: every record shows **Verified** and the SSL certificates show **Issued** (can take up to a few hours); `dig CNAME clerk.proofql.dev +short` returns the target Clerk showed (not a Cloudflare IP).
3. [x] **Keys.** Done: `pk_live_…` (Frontend API `clerk.proofql.dev`) is in `apps/dashboard/wrangler.jsonc` `env.prod.vars.CLERK_PUBLISHABLE_KEY`, and `CLERK_SECRET_KEY` is set with `wrangler secret put CLERK_SECRET_KEY --env prod`. That `secret put` created an empty `proofql-dashboard-prod` worker; the first prod deploy uploads over it (infra/provisioning.md step 13). The CSP derives `https://clerk.proofql.dev` from the publishable key (unit-tested in `apps/dashboard/app/lib/security-headers.test.ts`), so nothing else changes. Verify: `cd apps/dashboard && wrangler secret list --env prod` lists `CLERK_SECRET_KEY`.
4. [ ] **Paths.** Configure → **Paths**: sign-in `https://app.proofql.dev/sign-in`, sign-up `https://app.proofql.dev/sign-up`, after sign-in and after sign-up `https://app.proofql.dev/app`, home `https://app.proofql.dev`. `app.proofql.dev` is a subdomain of the instance's domain, so no allowed-redirect-origin entry is needed; do not add the `workers.dev` prod hostname.
5. [ ] **Organizations.** Configure → Organizations: enabled, "Allow users to create organizations" on (a workspace is an organization; `requireAccount` needs one). Same as development.
6. [ ] **Legal links.** Configure → Settings → **Legal**: privacy `https://docs.proofql.dev/privacy`, terms `https://docs.proofql.dev/terms`, "Require express consent" on (§5).
7. [ ] **Email sender.** Configure → **Emails**: the sender is `@proofql.dev` once the `clkmail` and DKIM records verify (step 2). Set the "from" name to `ProofQL` and the reply-to (or support email in Customization) to `support@proofql.dev`, which §11 makes a real inbox.
8. [ ] **Webhook.** Configure → Webhooks → Add endpoint `https://app.proofql.dev/webhooks/clerk`, events `organization.created`, `organization.updated`, `organization.deleted`; copy the signing secret → `cd apps/dashboard && wrangler secret put CLERK_WEBHOOK_SIGNING_SECRET --env prod` (§3). Verify (after the first prod deploy): the endpoint's **Testing** tab → send `organization.created` → `2xx`; `wrangler tail proofql-dashboard-prod` shows the webhook line.
9. [ ] **Google sign-in.** Configure → SSO connections → Google: production instances need **your own** OAuth client (the shared development credentials do not work in production). Cloud Console (the project from §4) → Credentials → Create OAuth client (Web) with the redirect URI Clerk shows (`https://clerk.proofql.dev/v1/oauth_callback`); paste client id and secret into Clerk. This client is for sign-in only; the Business Profile connector's client (§4) has its own redirect URI, `https://app.proofql.dev/app/integrations/google/callback`. Verify: "Continue with Google" on `https://app.proofql.dev/sign-in` completes against a real Google account.
10. [ ] **Sign-up mode.** Configure → **Restrictions** → Sign-up mode **Restricted** until §13 (the `/sign-up` page is closed by `SIGNUP_OPEN`; this is the server-side belt behind it). Allowlist your own address(es) so §12 can create a test account.

**Verify** (end to end): sign up with an allowlisted address at
`https://app.proofql.dev/sign-up`, create a workspace at `/app/workspace`,
land on `/app/onboarding`; the `accounts` row exists
(`psql "<prod DIRECT string>" -c "select name, created_at from accounts order by created_at desc limit 3"`).

## 7. Billing

**Not required to launch the free tier.** Stripe (#48) is user-gated on the
Stripe account and lands after launch. Until then:

- The paid plan is **"contact us"**: `PRICING_URL` (`https://proofql.dev/pricing`) redirects to `https://docs.proofql.dev/limits` (§2.4), whose plan table shows both tiers, and the footer's support address is how someone asks. Upgrading an account is the ops command `pnpm db:set-plan -- --account <org_…> --plan paid` (`packages/db/README.md`), run by you against the prod branch (`DATABASE_URL=<prod DIRECT string>`).
- [ ] Add one sentence to the Limits page when the first paid customer asks ("Paid plans are arranged by email until self-serve billing opens"), or leave it: the terms page already says so.
- The `STRIPE_*` rows in secrets.md stay *M3* until #48.

## 8. Observability

**Agent (done):** every `wrangler.jsonc` has `observability.enabled: true`
with `head_sampling_rate: 1`, so Workers Logs captures every request's
structured lines ([`docs/observability.md`](observability.md)).

- [ ] **Workers Logs is on per worker.** Verify after the first prod deploy: Dashboard → Workers & Pages → `proofql-api-prod` → **Logs** shows lines; repeat for `proofql-pipeline-prod`, `proofql-dashboard-prod`, `proofql-cdn-prod`, `proofql-docs-prod`. Retention is 3 days on Workers Free, 7 on Paid ([Cloudflare docs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), checked 2026-10-05; also what §5 can promise). On the free plan an incident older than 3 days has no logs left to read, so `quota.exhausted` and 5xx alerting cannot rely on going back through Workers Logs: they need the external monitor below (step 2 of "Alert on 5xx").
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
  2. Otherwise use a free external monitor on the health endpoints: Better Stack (free tier), UptimeRobot (free, 5-min interval) or the Upptime repo from §9, checking `https://api.proofql.dev/health`, `https://app.proofql.dev/health`, `https://cdn.proofql.dev/health`, `https://proofql-pipeline-prod.<subdomain>.workers.dev/health` (the pipeline has no custom host), each with "expected body contains `"ok":true`" and email/SMS on failure. This catches a worker that is down, not an elevated 5xx rate; the 5xx rate is a Workers Logs query during day one (§14) and the Logs page's status-code chart, until the account is on a plan with error alerts.
  3. Verify: break something on purpose — `wrangler secret delete SESSION_SECRET --env preview` on **preview**, load the preview dashboard, confirm the monitor (or the alert) fires within its interval, then `wrangler secret put` it back.
- [ ] **Billing alerts.** Dashboard → Notifications → Add → **Usage Based Billing** (Workers requests, Workers AI neurons, KV, Queues) with thresholds a little above the expected first-month numbers; and in Google Cloud a budget on the Places project (provisioning step 14).

## 9. Status page

**Owner, placeholder.** Not a launch gate; the GitHub issues are the public
status and roadmap until a page exists (the docs footer and the landing
page's "Status and roadmap" line link to them).

- [ ] Pick one: **Upptime** (free, a public GitHub repo of scheduled Actions that probe URLs and publish a static status site — fits a public repo and a `status.proofql.dev` CNAME to GitHub Pages), Better Stack or Instatus (free tiers, hosted). Create it with the four health URLs from §8.
- [ ] DNS: `CNAME status.proofql.dev` → the provider's target, proxy off if the provider manages TLS.
- [ ] Add `STATUS_URL` to `packages/core/src/contact.ts` and a "Status" link beside "Status and roadmap" in `apps/dashboard/app/components/shell/site-footer.tsx` and `docs/site/src/components/Footer.astro` (one small PR; the constants are the only place the URLs live).

**Verify:** `curl -sI https://status.proofql.dev | head -1` → 200; the page shows the four checks green.

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

**Owner.** The address is **`support@proofql.dev`**: the default
everywhere (`DEFAULT_SUPPORT_EMAIL` in `packages/core/src/contact.ts`, the
`SUPPORT_EMAIL` var in all three `vars` blocks of
`apps/dashboard/wrangler.jsonc`, the docs build's fallback, the OpenAPI
`info.contact.email`). It shows in every footer, the sign-up page, the
OpenAPI spec and the "Contact" sections of the legal pages. Make it a real
inbox with Cloudflare **Email Routing** (free, receive-only):

1. [ ] **Enable Email Routing.** Cloudflare → `proofql.dev` → **Email** → **Email Routing** → **Get started** / **Enable Email Routing**. It asks to add its MX records (`route1/2/3.mx.cloudflare.net`) and an SPF TXT record (`v=spf1 include:_spf.mx.cloudflare.net ~all`) to the zone; click **Add records and enable**. If Clerk's `clkmail` records (§6.2) are already there they do not conflict (they are on a subdomain). Verify: Email Routing → Settings shows the DNS records as **Configured** and routing **Enabled**.
2. [ ] **Destination address.** Email Routing → **Destination addresses** → **Add destination address** → your own mailbox. Cloudflare emails a verification link; click it. Verify: the address shows **Verified**.
3. [ ] **Rule.** Email Routing → **Routing rules** → **Create address**: custom address `support` (→ `support@proofql.dev`), action **Send to an email**, destination the verified address → **Save**. Optionally turn on the **Catch-all** to the same destination so `hello@`/`security@` do not bounce. Verify: send a mail to `support@proofql.dev` from an outside account; it arrives in your inbox, and Email Routing → **Activity log** shows it as forwarded.
4. [ ] **Replying.** Email Routing only receives. Until you pick a sending mailbox (Google Workspace or Fastmail on `proofql.dev`, or Gmail "Send mail as" via that provider's SMTP), reply from your own address and say so. If you add a provider later, its SPF/DKIM records go in the same zone; merge its SPF `include:` into the one TXT record, never two SPF records.
5. [ ] **Docs build variable (optional).** The docs site uses `SUPPORT_EMAIL` from the repository variable if set, else the default. No repository variable is set today (`gh variable list -R plattegruber/proofql`), so the default `support@proofql.dev` is what builds; set one only if the address ever differs (and then change the three `wrangler.jsonc` vars and `DEFAULT_SUPPORT_EMAIL` with it).
6. [ ] **Where the address is also typed by hand** (outside the repo, all `support@proofql.dev`): Clerk → Emails (reply-to / support email, §6.7); Google OAuth consent screen "User support email" and "Developer contact" (§4); the privacy policy and terms "Contact" sections (§5, they read `DEFAULT_SUPPORT_EMAIL`; check the rendered pages once the counsel text lands). The OpenAPI `info.contact.email` already says it.
7. [ ] Verify: the footer on `https://app.proofql.dev/sign-in` and on `https://docs.proofql.dev/` shows `support@proofql.dev` as a `mailto:` link: `curl -s https://docs.proofql.dev/ | grep -o 'mailto:[^"]*' | sort -u`.

## 12. Smoke test on prod

**Owner.** Two passes, both against `api.proofql.dev` / `app.proofql.dev`
after §1–§11: the browser walkthrough below, and the curl pass, which is
[`scripts/demo.sh`](../scripts/demo.sh) (#31) pointed at prod.

**Browser walkthrough** (the M2 exit, now on prod):

1. [ ] `https://app.proofql.dev/sign-up` with an allowlisted address (§6.10) → create a workspace → land on `/app/onboarding`.
2. [ ] Step 1: name a project; copy both keys from the page (they are shown once).
3. [ ] Step 2: upload `packages/core/test/fixtures/csv/` any `*.csv`, or use "Find your business on Google" with a real business (one billable Places call), or run the curl below with the secret key.
4. [ ] Step 3: the meter reaches "Indexed N of N"; `wrangler tail proofql-pipeline-prod` shows `review.indexed` lines and no `dlq`.
5. [ ] Step 4: copy the snippet; the preview iframe renders results; Finish lands on the Playground.
6. [ ] Paste the snippet into a plain HTML file with the project's origin allowed (Keys → allowed origins; `file://` cannot be allowed, so serve it with `python3 -m http.server 8000` and allow `http://localhost:8000`) and see reviews render. Stopwatch from step 1 to here: the target is under five minutes (`onboarding.completed` logs `elapsed_ms`).

**curl pass** (with the secret and publishable keys from step 2, and an
origin you added under Keys → allowed origins):

```sh
API_URL=https://api.proofql.dev ORIGIN=https://<an allowed origin> \
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

**Owner.** Two switches, in this order, five minutes. **They are a pair:
flip both or neither.** `SIGNUP_OPEN=true` with Clerk still Restricted
renders `/sign-up` as a **blank card** (Clerk's `<SignUp/>` shows nothing
to an uninvited visitor, with no error), and Clerk Public with
`SIGNUP_OPEN` unset keeps the waitlist. The same pairing holds on preview,
whose `SIGNUP_OPEN` is `"true"`: its Clerk development instance must stay
**Public**, or the acceptance run warns that it could only test the
invitation path (e2e/README.md).

1. [ ] Clerk → production instance → Configure → Restrictions → Sign-up mode **Public** (§6.10 set it to Restricted).
2. [ ] Open the dashboard's `/sign-up`:

   ```sh
   cd apps/dashboard
   echo true | pnpm exec wrangler secret put SIGNUP_OPEN --env prod
   cd ../..
   ```

   No deploy, no PR: `SIGNUP_OPEN` is read per request (`app/lib/signup-gate.ts`). Preview is already open (`"SIGNUP_OPEN": "true"` in its vars) and local defaults open.

**Verify**

```sh
curl -s https://app.proofql.dev/sign-up | grep -c "not open yet"      # 0 (was 1)
cd apps/dashboard && pnpm exec wrangler secret list --env prod | grep SIGNUP_OPEN; cd ../..
```

and in a private window `https://app.proofql.dev/sign-up` shows Clerk's
card with its email and password fields (a blank card means step 1 was
skipped); sign up with a **non**-allowlisted address and reach `/app/onboarding`.

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
| **Purge deleted workspaces by hand** | `pnpm db:purge-accounts -- --dry-run`, then without `--dry-run` (`--limit <n>`, default 50) | #169. The pipeline's 04:15 UTC cron tick already hard-deletes accounts soft-deleted (Clerk `organization.deleted`) more than 30 days ago, 50 per tick, logging `account.purged` (`wrangler tail proofql-pipeline-prod --search account.purge`). Use the script to see what is due or to catch up after an outage. It touches the database only; the purged projects' R2 uploads are removed by the cron, or by the bucket's 7-day lifecycle rule (`infra/provisioning.md` §4). A purged workspace is gone: the next sign-in with that Clerk organization creates a new, empty account. |
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
| Queues operations | 10,000 | **~3,300 reviews indexed** (3 operations each). This is the tightest limit for imports. Past it, ingest still accepts reviews and indexing catches up after 00:00 UTC |
| Workers AI | 10,000 neurons | ~30,000 reviews indexed, or far more queries. Not the constraint |

Cached queries cost no database queries and, on a custom domain, no KV
writes. Once the first prod deploy routes `api.proofql.dev` (§2), the result and auth caches
move to the Workers Cache API by themselves
([`infra/environments.md`](../infra/environments.md) "Cache API").

**Cron triggers.** The Free plan allows **5 cron triggers per account**
(Paid: 250), counted across every environment on it. The pipeline declares
one per environment (`*/5 * * * *`, #174) and picks the jobs due on each
tick itself (`workers/pipeline/src/schedule.ts`): the sweep every tick, the
Google poll at 00/06/12/18:00, the Places refresh at 03:30 and the account
purge at 04:15 UTC. A skipped tick skips that run; each job is idempotent
and age-based, so it catches up at its next due time (six hours for
Google, a day for the other two). Do not add crons to `wrangler.jsonc`;
add a row to `DUE_JOBS` instead.

### What degrades first

1. **A large import or re-index** (`pnpm db:reindex`, a CSV of thousands of
   reviews) hits **Queues** at ~3,300 reviews a day. Ingest keeps accepting
   reviews past the limit (#159): `POST /v1/reviews` still answers 200, with
   `indexing: "deferred"`, and CSV and Places imports still finish. The
   reviews are stored but stay unindexed, so they do not appear in query
   results yet. Indexing catches up after 00:00 UTC, when the five-minute
   sweep re-enqueues them, 500 per tick. The Google poll, the Places
   refresh and the location picker's `connection.sync` degrade the same way
   (#162): runs succeed and cursors advance, and a refused first sync stays
   pending for the next poll. The dashboard's import and onboarding progress
   says indexing is delayed instead of "searchable within seconds". Look for
   `quota.exhausted` with `resource: "queues"`. Plan big imports across
   days, or upgrade first.

**Dashboard polling cost.** An open import or onboarding progress page
reloads its counts every 2 s for the first minute, every 10 s until five
minutes, every 30 s until thirty minutes, and then stops with a "Check
again" button (#162). That is at most 104 page loads per open tab, each
one Workers request and ~3–5 Hyperdrive queries, so ~500 queries. A flat
2 s poll left open on a deferred import used to cost ~1,800 requests and
~9,000 queries an hour, against the 100,000 queries the whole account gets
per day.
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

