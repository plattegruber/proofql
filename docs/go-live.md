# Go-live audit: opening public sign-up

Every item in [`launch.md`](launch.md) checked against production on
**2026-10-08** (UTC), read-only wherever possible, with the evidence and the
exact steps that remain. `launch.md` stays the checklist and the source of
every click path; this page records where reality stands and what to do, in
order, before running §13 "Go".

**Bottom line.** The product works end to end on prod (the acceptance
journey passes on preview and prod), and the code-side gaps found here are
fixed in the PR that adds this page. Ten owner actions block opening sign-up;
they are the ordered list in [Owner steps](#owner-steps-in-order). The
biggest ones: `support@proofql.dev` cannot receive mail (no MX); the Clerk
webhook is not configured, so deleting a workspace never schedules its data
for deletion, despite what the privacy policy says; Clerk's paths and legal
links are unset; and on the Workers Free plan, one abusive free account
can exhaust the whole account's daily request allowance (see
[Free plan under open sign-up](#free-plan-under-open-sign-up)).

Status values: **done** (verified), **owner** (needs a person with the
accounts; steps below), **engineering** (code; fixed in this PR unless it
says otherwise), **unverified** (cannot be observed from outside; the owner
confirms in a dashboard).

## How it was checked

| Check | Command (read-only) | Result |
|---|---|---|
| DNS | `dig @1.1.1.1 <type> <name> +short` for NS, MX, TXT, CNAME, A/AAAA, CAA on the apex and every host | below |
| HTTP, redirects, headers | `curl -sS -D - -o /dev/null https://<host>/…` and `http://<host>/…` | below |
| Clerk instance | `curl -s https://clerk.proofql.dev/v1/environment` (the instance's public environment, what Clerk's own JS reads) | below |
| Worker secrets | `pnpm exec wrangler secret list --env prod` (and `preview`) from each worker's directory: names only | below |
| Bindings | `node scripts/check-provisioning.mjs` | `All bindings provisioned.`, exit 0 |
| Webhook | unsigned and badly signed `POST /webhooks/clerk` against **preview** only; `GET` against prod | below |
| WAF | one `POST /v1/reviews` with no User-Agent (W2); W1 needs a 700-request burst, which is a load test, so it was not run | below |
| Zone settings, WAF rules | Cloudflare API with the wrangler login token | refused (`10000 Authentication error`: the token has `zone:read` but not settings or rulesets); confirm in the dashboard |
| Acceptance | `gh run list --workflow acceptance.yml` | runs 37715741616 (prod) and 37715554244 (preview) green on 2026-10-08 |
| Local walk | dashboard + api + pipeline + cdn on `wrangler dev`, `SIGNUP_OPEN=true`, prod's flags (no Places key, connector off), Playwright | `/sign-up` → onboarding → project and keys → API ingest → indexed → snippet preview → playground query, all working. The local auth stub replaces Clerk (no Clerk secret on this machine), so sign-up and "choose organization" are covered by the preview acceptance run instead |

## The table

| # | Item (launch.md) | Status | Evidence | Remaining steps |
|---|---|---|---|---|
| 1 | §1 Accounts, KV/queues/R2/Hyperdrive, Neon, CI | done | `check-provisioning.mjs` exit 0; repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `NEON_PREVIEW_DATABASE_URL`; env `production` has `NEON_PROD_DATABASE_URL`; `DEPLOY_ENABLED=true`; deploys green | — |
| 2 | §1 First prod deploy | done | `api.`, `app.`, `cdn.` `/health` → `{"ok":true…}`; pipeline `proofql-pipeline-prod.gruberplatte.workers.dev/health` → `{"ok":true}`; `docs.` `/errors` 200 | — |
| 3 | §1 / §4.3 Places API key | **owner** | `GOOGLE_PLACES_API_KEY` is absent from `proofql-dashboard-prod`, `proofql-dashboard-preview` and `proofql-pipeline-prod` | [O5](#o5-places-key-or-launch-without-places) |
| 4 | §2.1 Zone | done | `dig NS proofql.dev` → `aarav.` / `laylah.ns.cloudflare.com` | — |
| 5 | §2.2 Token scopes | done | the prod deploy created the custom domains (it fails with 10000 without them) | — |
| 6 | §2.3 Custom domains | done | all four hosts resolve to Cloudflare and answer; README "Demo" link still points at preview | README link: needs a prod publishable key for a demo project (owner, optional) |
| 7 | §2.4, §2.7 Apex, `www`, `/pricing` | done | `WWW_PROD_ENABLED=true`; `https://proofql.dev/` and `https://www.proofql.dev/` 200 (canonical `https://proofql.dev/`); `/pricing` → 302 `https://docs.proofql.dev/limits` | — |
| 8 | HTTPS everywhere (not in launch.md) | **owner** | `http://api.`, `http://app.`, `http://cdn.` and `http://proofql.dev/` answer **200 over plain HTTP**; no redirect | [O2](#o2-force-https) |
| 9 | Security headers (security.md §4.5) | engineering, done here | api: HSTS, nosniff, no-referrer. app: CSP (Clerk, Turnstile, api, cdn), XFO DENY, HSTS. cdn: nosniff, CORS, CORP. **docs had no security headers at all; apex had no HSTS.** This PR adds `docs/site/public/_headers` (CSP, XFO, nosniff, referrer, permissions, HSTS) and HSTS on `apps/www`; every docs page and the landing page load in Chromium with no CSP violation | deploys with the PR; verify: `curl -sI https://docs.proofql.dev/ \| grep -i content-security` |
| 10 | §2.5 WAF W1 (rate limit) | **unverified** | not observable without a burst, and the API token cannot read rulesets | [O3](#o3-waf) |
| 11 | §2.5 WAF W2 (no UA on ingest) | **owner** | `curl -A '' -X POST https://api.proofql.dev/v1/reviews` → **401 from the worker** (`x-request-id`, error envelope), not Cloudflare's 403: the rule is not live | [O3](#o3-waf) |
| 12 | §2.5 W3 Bot Fight Mode off | unverified | snippet and api answer normally with no challenge, consistent with off | — |
| 13 | §2.5 W4 Managed rules | unverified | on by default on Free | confirm in Security → WAF |
| 14 | §3 Dashboard secrets, prod | **owner** | present: `CLERK_SECRET_KEY`, `SESSION_SECRET` (+ `CREDENTIALS_KEY`, `GOOGLE_OAUTH_STATE_SECRET`). **Missing: `CLERK_WEBHOOK_SIGNING_SECRET`, `GOOGLE_PLACES_API_KEY`** | [O4](#o4-clerk-webhook), [O5](#o5-places-key-or-launch-without-places) |
| 15 | §3 Dashboard secrets, preview | **owner** | same four present and the same two missing | [O4](#o4-clerk-webhook) |
| 16 | §3 api / pipeline secrets | done | api: none (none needed); pipeline prod: `CREDENTIALS_KEY` (connector, dark) | — |
| 17 | §4.1 GBP API access (#44) | owner, not a gate | PR #184 (access kit) open | — |
| 18 | §4.2 OAuth verification | owner, not a gate | waits on #44 and the legal pages | — |
| 19 | §4.4 Places retention (#116) | done | #116 closed; `docs/places.md` has no open point | — |
| 20 | §5 Legal text | **owner + counsel** | pages live at `/privacy`, `/terms`, `/subprocessors` under the Draft banner. This PR drafts the gaps from google-access.md §4.4/§4.8 (Google data retention, derived data, stopping use, reviewer consent, corrected attribution reference); owner facts remain as `[PLACEHOLDER]` | [O9](#o9-legal-facts-the-owner-must-supply) |
| 21 | §6.1 Clerk prod instance | done | `clerk.proofql.dev/v1/environment` answers, `application_name: ProofQL` | — |
| 22 | §6.2 Clerk DNS | done | `clerk` → `frontend-api.clerk.services`, `accounts` → `accounts.clerk.services`, `clkmail` → `mail.ej58zk32mthk.clerk.services`, `clk._domainkey`/`clk2._domainkey` → `dkim1/2.ej58zk32mthk.clerk.services`, all DNS-only | — |
| 23 | §6.3 Keys | done | `pk_live` in `wrangler.jsonc`; `CLERK_SECRET_KEY` set; app CSP names `https://clerk.proofql.dev` | — |
| 24 | §6.4 Paths | **owner** | `sign_in_url`/`sign_up_url` are `https://accounts.proofql.dev/…` (the Account Portal) and `after_sign_in_url`/`after_sign_up_url` are `https://proofql.dev` (the **marketing site**). The dashboard overrides these for its own pages, but Clerk-originated links (invitation emails, the portal) send people to the portal and then to the landing page | [O6](#o6-clerk-settings) |
| 25 | §6.5 Organizations | done | `organization_settings.enabled: true`, `force_organization_selection: true`, creation enabled, `max_allowed_memberships: 5` | — |
| 26 | §6.6 Legal links | **owner** | `terms_url: null`, `privacy_policy_url: null`, `legal_consent_enabled: false` (the `/sign-up` page shows Privacy/Terms only in the footer) | [O6](#o6-clerk-settings) |
| 27 | §6.7 Email sender | **owner** | `clkmail` and DKIM resolve; `support_email: null` | [O6](#o6-clerk-settings) |
| 28 | §6.8 Webhook | **owner** | preview: unsigned `POST` → `503 {"error":"CLERK_WEBHOOK_SIGNING_SECRET is not set"}`, bad signature → same 503 (it rejects, but because it is unconfigured); `GET` → 405 on preview and prod. The secret is absent in both envs, so `organization.created/updated/deleted` are not applied. Accounts are still created on first load (`requireAccount`), but **deleting a workspace never soft-deletes the account, so the 30-day purge never runs** — the privacy policy promises it does | [O4](#o4-clerk-webhook) |
| 29 | §6.9 Google sign-in | unverified | `oauth_google` enabled; whether it uses your own OAuth client cannot be seen from outside | [O6](#o6-clerk-settings): one real "Continue with Google" |
| 30 | §6.10 Sign-up mode | done | `user_settings.sign_up.mode: "restricted"`; captcha `turnstile`, widget `smart`. Allowlist **disabled**, so §12's test account needs an invitation | [O6](#o6-clerk-settings) |
| 31 | Abuse controls in Clerk (not in launch.md) | **owner** | `block_disposable_email_domains: false`, `block_email_subaddresses: false`; `second_factors: []` (no MFA, though the Terms recommend it) | [O6](#o6-clerk-settings) |
| 32 | Free-tier multiplication (not in launch.md) | engineering, done here | any Clerk user can create unlimited organizations, and each was a fresh free account (1 project, 5,000 reviews, 50,000 queries). Fixed: the free allowance now counts per person | see [Free plan under open sign-up](#free-plan-under-open-sign-up) |
| 33 | §7 Billing | n/a | deferred by design | — |
| 34 | §8 Workers Logs | done (config) | `observability.enabled: true`, `head_sampling_rate: 1` in all six `wrangler.jsonc` | confirm lines appear per worker in the dashboard |
| 35 | §8 Error tracking | n/a by design | no Sentry or other error tracker; `observability.md` says error tracking is not built yet. `request.failed` lines carry stacks in Workers Logs (3-day retention on Free) | — |
| 36 | §8 Alert on 5xx / uptime monitor | **owner** | nothing observable; no status host | [O7](#o7-monitoring-backups-status) |
| 37 | §8 Billing / usage notifications | unverified | — | [O7](#o7-monitoring-backups-status) |
| 38 | §9 Status page | owner, not a gate | `status.proofql.dev` has no DNS record | optional |
| 39 | §10 Backups | unverified | Neon console only | [O7](#o7-monitoring-backups-status) |
| 40 | §11 Support inbox | **owner** | **`dig MX proofql.dev` is empty; no SPF or DMARC TXT on the apex.** Email Routing is not enabled, so mail to `support@proofql.dev` (every footer, the sign-up page, the OpenAPI spec, the legal pages' contact sections, the reviewer-removal route) bounces | [O1](#o1-support-inbox) |
| 41 | §11.7 Footers | done | `mailto:support@proofql.dev` on `docs.proofql.dev/` and `app.proofql.dev/sign-in` | — |
| 42 | §12 Smoke test on prod | **owner** | acceptance on prod signs in an existing user (sign-in token) and passes the whole journey; nobody has **signed up** on the prod instance through the public path yet | [O8](#o8-smoke-test-on-prod) |
| 43 | Onboarding: no dead options | engineering, partly done | this PR hides the Integrations tab while the connector is dark, drops "connected Google account" and the GitHub links from the Reviews empty state, and omits the unconfigured Places card on the Import tab. **Still visible on onboarding step 2** (not edited here; see [Conflicts](#conflicts-with-other-work)): "Connect Google — Coming soon", and, without a Places key, "Not configured in this environment. The owner adds the Places API key…" | [O5](#o5-places-key-or-launch-without-places) and the takeout-import branch |
| 44 | Docs "Where the dashboard is" note (§2.3) | engineering, done here | removed | — |
| 45 | §13 Go | owner, last | `bash scripts/signup-switch.sh status` → `restricted / waitlist / absent`, exit 0 | [Launch-day runbook](#launch-day-runbook) |
| 46 | Waitlist notification | **owner, no mechanism** | rows are stored in `waitlist` (email, created_at, source). Nothing sends mail, and there is no sending mailbox (Email Routing only receives). launch.md §13 "After Go" is a `psql` export | [Waitlist](#waitlist) |
| 47 | §14 Day-one monitoring, §16 free plan | owner, after Go | — | launch.md §14, §16 |
| 48 | Issue #51 | note | #51 is **closed** although Go has not happened; launch.md says it closes after Go plus 48 hours | reopen it, or track Go elsewhere |

## Free plan under open sign-up

**Sign-up velocity.** Clerk's bot protection is on (Turnstile, "smart"
widget) and Clerk rate-limits its own sign-up endpoints. Disposable-domain
and `+subaddress` blocking are off, which makes it cheap to create many
Clerk users. Turn both on if your Clerk plan offers them ([O6](#o6-clerk-settings)).

**One person, many workspaces (fixed in this PR).** A workspace is a Clerk
Organization and an `accounts` row; the free plan's limits are per account,
and the instance allowed any user to create organizations without limit.
Now `accounts.created_by_user_id` (migration 0010, additive) records each
organization's creator, from the webhook's `created_by` or, on first load,
Clerk's `createdBy` (or the signed-in user). `projectQuota` counts the
creator's projects in their other free, not-deleted workspaces against the
allowance, so a second free workspace starts at its limit. Paid workspaces,
workspaces someone else created, deleted ones and pre-existing rows (null
creator) are not counted; null never blocks. Onboarding step 1 and New
project explain it, and the Limits page states the rule (the Terms already
forbid spreading use over extra accounts). The bypass that remains is many
Clerk users, which the sign-up controls above cover.

**One abusive account against the daily ceilings (not fixed: owner
decision).** The Workers Free allowances (launch.md §16) are per Cloudflare
account and shared by every tenant, preview included. The per-key limits do
not keep one tenant inside them:

| Ceiling (daily, account-wide) | What one free project can do |
|---|---|
| Workers requests, 100,000 | One publishable key is allowed 120 requests a minute, about **172,800 a day**: one key alone can exhaust the account. Cached hits still invoke the worker, so the monthly 50,000 uncached-query quota does not cap this. A project can also create any number of keys. WAF W1 (600 per 10 s per IP) is far above this. When the allowance runs out, **every** tenant's snippet gets Cloudflare error 1027 and renders its fallback until 00:00 UTC; the dashboard is down too. |
| Queues operations, 10,000 | A single 5,000-review import (the free cap per project) needs ~15,000 operations: it exhausts the day's indexing for every tenant. Ingest keeps accepting (`indexing: "deferred"`) and catches up after 00:00 UTC. |
| Hyperdrive queries, 100,000 | Uncached queries and the dashboard degrade to 503 with `Retry-After`; cached answers keep serving. |

Options, cheapest first: **(a)** upgrade to Workers Paid ($5/month, #143)
before running Go. Requests and queue operations become metered instead of
capped, which removes the "one tenant takes everyone down" failure. This is
the recommendation; launch.md §16's trigger was written for organic growth,
not for open sign-up. **(b)** Stay on Free and accept the risk for a quiet
launch, watching `quota.exhausted` and the Workers overview daily (launch.md
§16), with the rollback being `signup-switch.sh close` plus revoking the
abuser's keys. **(c)** Engineering follow-ups, not in this PR: a cap on
active keys per project, and a per-account daily request budget in the api.
Neither replaces (a), because one key at its legitimate rate limit already
exceeds the account ceiling.

## Waitlist

There is no notification mechanism. People on the waitlist are not told
when sign-up opens unless you email them. To notify them after Go:

1. Export: `psql "<prod DIRECT string>" -c "copy (select email from waitlist order by created_at) to stdout" > waitlist.txt` (the prod string is in GitHub env `production` / Neon; do not commit the file).
2. Send from a mailbox you control, with every address in **Bcc**, never To/Cc. There is no sending provider on `proofql.dev` (Email Routing only receives, launch.md §11.4), so send from your own address or set one up first. Mention that replies go to `support@proofql.dev` once O1 is done.
3. The privacy policy says waitlist addresses are kept "until signup opens and we have told you". After sending, delete them: `psql "<prod DIRECT string>" -c "delete from waitlist"`, or keep them only if you settle the `[PLACEHOLDER: confirm.]` on that line differently.

## Conflicts with other work

- **takeout-import** (another branch, adding a Google Takeout option to onboarding step 2). Not touched here: `apps/dashboard/app/routes/app.onboarding.$slug.reviews.tsx` and the shared `app/components/import/places-finder.tsx`. On that step today, with prod's configuration:
  - The "Connect Google" card is always rendered disabled with a "Coming soon" badge and a link to GitHub issue #44. It should render only when `connectorEnabled(env)` is true, the same rule this PR applies to the Integrations tab.
  - The "Find your business on Google" card renders, when `GOOGLE_PLACES_API_KEY` is unset, as "Not configured in this environment. The owner adds the Places API key for the dashboard; until then, upload an export or use the API." (`PLACES_NOT_CONFIGURED_COPY`), which is developer copy. Omit the card when `places.enabled` is false, as this PR does on the Import tab.
  - `PLACES_CARD_BODY` ends "connect your Google Business Profile later for all of them", promising the dark connector; it shows on the Import tab too.
  - Its test `app.onboarding.$slug.reviews.test.tsx` asserts the "Not configured in this environment." copy.
- **PR #184** (google-readiness) also edits `docs/launch.md`. This PR adds one line near the top of that file, so the two should merge cleanly; if not, keep both.

## Owner steps, in order

Each step is one sitting; the verify line is the gate for the next.

### O1. Support inbox

launch.md §11 steps 1–3 (Email Routing → enable and add its MX and SPF
records → verify your destination → rule `support@` → your inbox; turn on
the catch-all for `security@`/`hello@`). Add a DMARC record while in DNS:
`TXT _dmarc` → `v=DMARC1; p=none; rua=mailto:support@proofql.dev`.
Verify: `dig MX proofql.dev +short` lists `route1/2/3.mx.cloudflare.net`;
a mail from an outside account to `support@proofql.dev` arrives.

### O2. Force HTTPS

Cloudflare → `proofql.dev` → SSL/TLS → Edge Certificates → **Always Use
HTTPS: On**. Leave the zone-level HSTS setting off; the workers send their
own. Verify: `curl -sI http://app.proofql.dev/health | head -1` → `301`
with `location: https://…`, likewise `http://proofql.dev/`.

### O3. WAF

launch.md §2.5 steps 1–2 (W1 rate limiting rule, W2 custom rule), exactly
as written. Verify W2 with one request: `curl -s -o /dev/null -w '%{http_code}\n' -A '' -X POST https://api.proofql.dev/v1/reviews` → `403` (today: 401).
Do **not** run §2.5.5's 700-request loop on the free plan; check that W1
appears under Security → WAF → Rate limiting rules instead.

### O4. Clerk webhook

For **prod** and **preview** (each Clerk instance has its own endpoint and
secret):

1. Clerk dashboard → the instance (Production; then Development for preview) → Configure → **Webhooks** → Add endpoint: `https://app.proofql.dev/webhooks/clerk` (preview: `https://proofql-dashboard-preview.gruberplatte.workers.dev/webhooks/clerk`), events `organization.created`, `organization.updated`, `organization.deleted`. Copy the signing secret.
2. From `apps/dashboard`, paste it on stdin when prompted (never as an argument): `pnpm exec wrangler secret put CLERK_WEBHOOK_SIGNING_SECRET --env prod`, then the preview one with `--env preview`.
3. Verify: the endpoint's **Testing** tab → send `organization.created` → `2xx`; `curl -s -X POST https://proofql-dashboard-preview.gruberplatte.workers.dev/webhooks/clerk -d '{}'` now answers **400** `invalid signature` (was 503).

Until this is done, a workspace deleted in Clerk keeps all its data
indefinitely.

### O5. Places key, or launch without Places

Either set the key (provisioning step 14; from `apps/dashboard` **and**
`workers/pipeline`, `pnpm exec wrangler secret put GOOGLE_PLACES_API_KEY --env prod`, then `--env preview`; verify: the Import tab shows "Find your business on Google" with a search box),
or decide to launch without it. In that case the takeout-import branch
should hide the onboarding card (see [Conflicts](#conflicts-with-other-work)),
and the docs' "Find your business on Google" section (`imports.md`)
describes a feature prod does not offer yet.

### O6. Clerk settings

Clerk dashboard → Production:

1. **Paths** (launch.md §6.4): sign-in `https://app.proofql.dev/sign-in`, sign-up `https://app.proofql.dev/sign-up`, after sign-in and after sign-up `https://app.proofql.dev/app`, home `https://app.proofql.dev`. Verify: `curl -s https://clerk.proofql.dev/v1/environment | jq .display_config.after_sign_up_url` → `"https://app.proofql.dev/app"`.
2. **Legal** (§6.6): privacy `https://docs.proofql.dev/privacy`, terms `https://docs.proofql.dev/terms`, "Require express consent" on. Verify: `.display_config.terms_url` is set and `.user_settings.sign_up.legal_consent_enabled` is `true`.
3. **Emails / Customization** (§6.7): from name `ProofQL`, support email `support@proofql.dev` (after O1). Verify: `.display_config.support_email`.
4. **Restrictions**: turn on **Block disposable email domains** and **Block email subaddresses** if your plan offers them. Add your own address to the **allowlist** (or send yourself an invitation) for O8; with the allowlist off and mode Restricted, nobody can sign up uninvited. Verify: `.user_settings.restrictions.block_disposable_email_domains.enabled` → `true`.
5. **Organizations**: if Clerk offers a per-user organization creation limit, set it to 2–3; the dashboard's per-person allowance (this PR) holds either way.
6. **Multi-factor** (optional): enable TOTP. If you do not, delete the 2FA sentence in `terms.mdx` (it carries a placeholder saying so).
7. **Google sign-in** (§6.9): confirm it uses your own OAuth client, then complete one "Continue with Google" on `https://app.proofql.dev/sign-in`.

Do **not** change the sign-up mode here; that is the Go step.

### O7. Monitoring, backups, status

- launch.md §8 "Alert on 5xx" step 2: a free uptime monitor on the four health URLs (`api.`, `app.`, `cdn.proofql.dev/health` and the pipeline's workers.dev `/health`), expecting `"ok":true`.
- launch.md §8 billing alerts and §10 (Neon restore window and the one-line restore test). Write the window into the privacy policy placeholder.
- §9 status page is optional.

### O8. Smoke test on prod

After merging this PR and approving its prod deploy (migration 0010 runs in
`migrate-prod` before the workers deploy): launch.md §12 with an
allowlisted or invited address. This is the first **sign-up** through the
prod Clerk instance; acceptance only signs in. Confirm the new account row
has its creator: `select name, created_by_user_id from accounts order by created_at desc limit 1`.

### O9. Legal facts the owner must supply

Hand these to counsel with the two pages (launch.md §5.1). Every one is a
`[PLACEHOLDER]`, `[COMPANY LEGAL NAME]`, `[ADDRESS]` or
`[GOVERNING LAW / JURISDICTION]` in the source:

| Fact | Where |
|---|---|
| Company legal name and postal address | privacy l.12, l.164; terms l.25, l.127 |
| Governing law, courts or venue, any arbitration clause, consumer carve-outs | terms l.115 |
| Liability cap fixed amount (e.g. US$100) | terms l.105 |
| Indemnity scope and procedure | terms l.111 |
| Notice before discontinuing the Service (N days) | terms l.80 |
| Free-account inactivity period before termination (N months) | terms l.86 |
| Notice period for Terms changes (30 days?) | terms l.123 |
| Whether agencies may manage client projects under one account | terms l.92 |
| Billing, renewal, refund, tax and price-change terms (when Stripe lands; can stay "not sold yet") | terms l.75 |
| SLA for paid plans, if any | terms l.79 |
| Keep or drop the 2FA recommendation (O6.6) | terms l.32 |
| Controller/processor split; publish a DPA with SCCs? | privacy l.38 |
| Law-enforcement request position | privacy l.96 |
| **Google connector retention**: refresh within 30 days and delete what Google drops, or keep until deleted; and on disconnect: delete within 30 days, or keep (the Service keeps today). Decide with google-access.md risk 1 | privacy l.80 (two choices), l.117 |
| Neon point-in-time restore window (N days, from O7) | privacy l.119 |
| Workers plan at launch (log retention 3 days Free, 7 Paid; see the Workers Paid decision above) | privacy l.120 |
| Waitlist retention (deleted after notifying, per [Waitlist](#waitlist)?) | privacy l.121 |
| Support email retention (N months/years) | privacy l.122 |
| GDPR legal bases; EU/UK Art. 27 representative needed? | privacy l.142 |
| International transfer mechanism (SCCs, DPF, other) | privacy l.152 |
| A dedicated `privacy@` address? (works once O1's catch-all is on) | privacy l.164 |
| DPA with each subprocessor, linked | subprocessors l.13 |
| R2/KV storage and Workers AI inference locations | subprocessors l.19 |

Then launch.md §5.2: replace the text, delete every placeholder and the
`<LegalNotice />` line, set "Last updated". Done when `grep -rn "PLACEHOLDER\|LegalNotice\|COMPANY LEGAL NAME\|\[ADDRESS\]\|GOVERNING LAW" docs/site/src/content/docs` prints nothing.

### O10. Decide the plan

Workers Paid before Go, or Free with daily watching
([above](#free-plan-under-open-sign-up)). If Paid, upgrade in the
Cloudflare dashboard (Workers & Pages → Plans); nothing in code changes.

### Then: Go

[Launch-day runbook](#launch-day-runbook), then the [Waitlist](#waitlist)
email, then launch.md §14.

## Launch-day runbook

`scripts/signup-switch.sh` pairs the two switches and checks each step
(it was run in `status` mode only; `open` and `close` change prod and are
yours to run):

```sh
bash scripts/signup-switch.sh status   # read-only; exit 3 on a mismatch
bash scripts/signup-switch.sh open     # Go
bash scripts/signup-switch.sh close    # rollback
```

**open** asks you to set Clerk → Production → Configure → Restrictions →
Sign-up mode **Public**, reads the mode back from
`https://clerk.proofql.dev/v1/environment`, and refuses to continue unless
it reports `public`. Then it pipes `true` into
`wrangler secret put SIGNUP_OPEN --env prod` (stdin, never echoed) and polls
`https://app.proofql.dev/sign-up` until the waitlist text is gone. Finish by
hand: in a private window `/sign-up` shows email and password fields (a
blank card means Clerk is not Public); sign up with a non-allowlisted
address and reach `/app/onboarding`.

**close** (rollback) does the reverse: `false` into the secret, waits for
the waitlist page, then asks you to set Clerk back to **Restricted** and
reads it back. Signed-in accounts are unaffected; nothing is deployed.
Keep the gap between the two steps short in both directions: while Clerk
is Public and the secret is not `true`, the dashboard shows the waitlist,
but Clerk's Account Portal (`https://accounts.proofql.dev/sign-up`) still
accepts sign-ups.

Equivalent by hand (launch.md §13): from `apps/dashboard`,
`echo true | pnpm exec wrangler secret put SIGNUP_OPEN --env prod` after
Clerk is Public; `echo false | …` before setting it back to Restricted.

If an abusive tenant is the reason for closing, also revoke its keys
(Keys tab, or `update api_keys set revoked_at = now() where project_id = …`
against prod), which stops its traffic on the next auth-cache expiry
(60 s at most, security.md §4.2).
