# Security: threat model and controls

What ProofQL protects, from whom, with what, and what is left (#49). Three
public surfaces — the **api** (`workers/api`), the **cdn** (`workers/cdn`),
the **dashboard** (`apps/dashboard`) — and the **pipeline**
(`workers/pipeline`), which is not public but consumes what the public
surfaces produce. Every control names the file that implements it; every
residual names an owner. Companion documents: [secrets.md](secrets.md) (what
is secret and how it rotates), [observability.md](observability.md) (the log
lines the controls emit), [scope.md](scope.md) §3 (the key model this all
rests on).

## 1. Assets

| Asset | Where | Why it matters |
|---|---|---|
| Review text, excerpts, author names, ratings | Postgres (`reviews`, `review_chunks`), KV query cache | A tenant's data. Publishable through `/v1/query` by design *for the tenant's own site*; a hidden or low-rated review must never appear anywhere. |
| Secret keys (`pq_sk_…`) | Hashed in `api_keys.key_hash`; plaintext shown once | Full read/write on one project's reviews. |
| Publishable keys (`pq_pk_…`) | Same table; plaintext ships in every customer page | **Public by design.** Query-only. The threat is spend, not data. |
| Clerk sessions and organizations | Clerk; cookies on the dashboard origin | Account takeover ⇒ keys, review management, policy. |
| Clerk webhook signing secret, session secret | wrangler secrets | Forged webhooks could rename or soft-delete accounts; forged flash cookies are only toasts. |
| Uploaded CSV/JSON exports | R2 `UPLOADS`, keyed `uploads/<project>/<run>.<ext>` | Tenant data at rest; never served back as a file. |
| Queue messages | `proofql-ingest` | Ids only (`reviewId`, `projectId`, `environment`); content is re-read from the row. |
| Availability and cost | Workers, Workers AI, Hyperdrive/Neon | The free tier's economics (scope §1): an attacker who can make us embed or search at will spends our money. |
| Deploy credentials | GitHub secrets (`CLOUDFLARE_API_TOKEN`, Neon URLs) | Covered in [secrets.md](secrets.md); out of scope here beyond the token scopes in `infra/provisioning.md` step 8. |

## 2. Trust boundaries

```
 browser on a customer site ──(pk in URL, Origin)──► api /v1/query ──► Postgres, KV, Workers AI
 customer server ───────────(sk in Authorization)──► api /v1/*      ──► Postgres, KV, Queue ──► pipeline
 browser (customer staff) ──(Clerk session cookie)──► dashboard     ──► Postgres, KV, R2, Queue
 Clerk ─────────────────────(Svix-signed POST)─────► dashboard /webhooks/clerk
 any browser ───────────────(nothing)──────────────► cdn /v1.js, /demo/
```

- **A publishable key is not a secret.** Everything a `pq_pk_` can do must be
  acceptable for the whole internet to do with that project's spend: query
  publishable reviews, within the per-key rate limit and the project's
  monthly quota. It can never read hidden reviews, write, or touch another
  project. The CORS allowlist does *not* add a boundary — see §4.3.
- **A secret key is the project.** Its guarantees are entropy (~190 bits),
  show-once, hash-only storage, header-only transport
  (`packages/core/src/apiKeys.ts`, `workers/api/src/auth.ts`).
- **The dashboard trusts Clerk for identity** and its own database for
  authorization: every loader resolves the account from the Clerk
  organization and scopes every query by it (`app/lib/account.server.ts`,
  `app/lib/accounts.ts`). Machine routes (`/webhooks/clerk`, `/health`)
  bypass Clerk and have their own authentication (Svix) or none (liveness).
- **Workers trust bindings, not the network.** No worker holds a database
  URL or an AI key (`secrets.md`); Hyperdrive and the `AI` binding are
  account-scoped capabilities the platform injects.
- **The pipeline trusts the queue only as a hint.** A message names a row;
  the consumer re-reads the row and applies the publication policy itself,
  so a stale or malicious message cannot publish anything the row would not.

## 3. Threats considered

| # | Threat | Surface | Outcome if unmitigated |
|---|---|---|---|
| T1 | Key brute force / enumeration | api | Attacker finds a valid key by guessing. |
| T2 | Spend abuse with a copied publishable key | api | Someone else's site, or a script, burns a project's quota and our Workers AI budget. |
| T3 | Origin spoofing | api | Script sends a fake `Origin` with a pk. |
| T4 | Oversized or malformed bodies | api, dashboard webhook, dashboard upload | Memory, CPU, storage; parser edge cases. |
| T5 | Log injection via `x-request-id` | api, dashboard | Forged log lines; broken log tooling. |
| T6 | Response sniffing, caching of per-request data, referrer leakage | api, cdn | Key in a referrer; a shared cache serving one caller's response to another. |
| T7 | Clickjacking / framing the dashboard | dashboard | A hostile page frames the keys page and tricks a click. |
| T8 | XSS on the dashboard | dashboard | Session riding; key exfiltration. |
| T9 | Forged or replayed Clerk webhooks | dashboard | Accounts renamed or soft-deleted. |
| T10 | Disguised or oversized uploads | dashboard | Storage abuse; a parser fed something it was not written for. |
| T11 | Poisoned or garbage queue messages | pipeline | Retry storms; DLQ noise; indexing a hidden review. |
| T12 | Cross-tenant reads via ids | api, dashboard | One tenant reads another's review by uuid. |
| T13 | Supply chain: vulnerable dependency, leaked secret in git | repo | Everything above. |
| T14 | Volumetric DDoS | all | Availability; cost. |

## 4. Controls

### 4.1 Authentication and keys (T1, T12)

- Keys are 32 base62 characters (~190 bits) after a self-describing prefix;
  the database stores the SHA-256 and a display prefix; the plaintext exists
  in one response (`packages/core/src/apiKeys.ts`). Lookup is by hash
  equality on a unique index, so **there is no comparison to make
  constant-time**: `timingSafeEqual` would protect a compare that never
  happens, and a timing side channel on an indexed digest lookup leaks
  nothing about the preimage. The module doc explains why plain SHA-256,
  not bcrypt, is correct for high-entropy tokens; do not "upgrade" it.
- Order of checks is cheapest first: header shape, key pattern, kind, then
  the digest and lookup (`workers/api/src/auth.ts`). Garbage never costs a
  digest.
- **Per-IP throttle on authentication failures** (new in #49,
  `workers/api/src/auth-throttle.ts`): a 401 or 403 that resolved no key
  counts one failure against `cf-connecting-ip`; thirty in sixty seconds
  (`RL_AUTH_FAIL`, namespace 1005, in-memory fallback without the binding)
  turns the overflowing failure into a 429 and boxes the address for the
  rest of the period, refused before auth. Authenticated traffic never
  counts and is never affected by another address. The point is not to
  make guessing harder — entropy does that — but to cap what enumeration
  costs us. Logs `auth.throttled` without the address.
- Every row the api touches is scoped by the key's `(project_id,
  environment)` in SQL, so another tenant's uuid is a 404 indistinguishable
  from a nonexistent one (`routes/reviews-crud.ts` `scope()`,
  `query/route.ts`). The dashboard does the same by account
  (`app/lib/accounts.ts`, `csv.server.ts` `findProjectRun`).

### 4.2 Spend and volume (T2, T14)

- Per-key rate limits by plan and kind via Cloudflare rate limiting
  bindings; 429 with `Retry-After` and IETF `RateLimit-*` headers
  (`workers/api/src/rate-limit.ts`, numbers in `packages/core/src/plans.ts`).
- Monthly quota of **uncached** queries per project; cached answers are
  served at quota, so a popular page degrades to "slightly stale", never to
  "blank" (`workers/api/src/quota.ts`).
- Query results cached in KV by project, environment, generation and
  normalized request, purged by generation bump on any change
  (`workers/api/src/query/cache.ts`, `packages/core` `bumpProjectGeneration`).
  The cache key carries no API key, so **a cached response carries no
  key**.
- The resolved key itself is cached in KV for 60 s, on `/v1/query` only,
  under its SHA-256 hash and tagged with the project's generation
  (`workers/api/src/auth-cache.ts`, #108), so a request that is also a
  query-cache hit opens no database connection. The dashboard bumps the
  generation when a key is revoked or the origin allowlist changes, so the
  entry is dropped at once in the writing colo; elsewhere it lasts until KV
  propagates the bump or the TTL ends — about a minute, at most two (§6).
  Write routes never read it.
- The WAF rate-limit rule in §7 is the coarser backstop in front of all of
  this, and the only thing that acts before the worker runs.

### 4.3 Origin and the publishable key (T3)

`Origin` is set by the browser and binds only browsers. Any script holding a
`pq_pk_` — which is in page source on purpose — can send any `Origin` with
`curl` and pass the allowlist. The allowlist in `workers/api/src/cors.ts` is
therefore a **UX guard, not a security boundary**: it stops another
*website* from embedding a project's reviews under its own domain, because
that request comes from a browser that reports the true origin. The
controls that bound a copied publishable key do not depend on `Origin`:

- kind: `requireApiKey` refuses it on every route but `/v1/query`, and the
  query path reads only publishable rows (`auth.ts`; tests in `auth.test.ts`
  and the contract suite assert a secret key is never accepted from `?key=`
  on any method, and `?key=` is GET-only);
- the per-key rate limit and the project's quota (§4.2);
- the auth-failure throttle (§4.1).

A leaked publishable key is somebody else's quota spend, bounded by the
plan; the runbook is §6.

### 4.4 Request shape (T4, T5)

- `Content-Type: application/json` is required on every `/v1` request that
  carries a body (415 `unsupported_media_type`, before the body is read and
  before any key lookup); body ceilings per path — 16 KiB on `/v1/query`,
  1 MiB elsewhere as the floor under the route-level 1 MiB (ingest) and
  64 KiB (PATCH) — from `Content-Length` when present and while streaming
  otherwise (`workers/api/src/request-guards.ts`, route limits in
  `routes/reviews.ts`, `routes/reviews-crud.ts`). Every body is validated
  with closed zod schemas; unknown fields are 422, never ignored
  (`query/request.ts`, `@proofql/core` review schemas).
- `x-request-id` from the caller is accepted only as ≤128 chars of
  `A-Za-z0-9._:-`; anything else is replaced with a fresh uuid, on both
  the api (`workers/api/src/request-id.ts`) and the dashboard
  (`apps/dashboard/workers/app.ts`). The structured logger also redacts
  `text`, `excerpt`, `author_name`, `key`, `plaintext`, `authorization` at
  any depth (`packages/core/src/log.ts`).
- Error envelopes carry the code, a message, the request id and nothing
  about the cause; stack traces exist in one log line (`errors.ts`).

### 4.5 Response headers (T6, T7, T8)

- **api** (`workers/api/src/security-headers.ts`): `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on
  everything but a successful `GET /v1/query`, which is `private,
  max-age=0, must-revalidate` (#112: the response varies by key, so a shared
  cache must never hold it; the result cache is server-side, with `Vary:
  Origin`), and HSTS in preview and prod. On every response including
  envelopes, 404s and the preflight.
- **cdn** (`workers/cdn/src/handler.ts`): `nosniff` on everything; the
  snippet files (and only they) get `Access-Control-Allow-Origin: *` and
  `Cross-Origin-Resource-Policy: cross-origin` because embedding is their
  purpose; errors are `no-store` so an edge never caches a 404 for the
  TTL; `Set-Cookie` from the asset layer is stripped.
- **dashboard** (`apps/dashboard/app/lib/security-headers.ts`, applied in
  `workers/app.ts`): a `Content-Security-Policy` built from the env —
  `script-src 'self' 'unsafe-inline' <Clerk FAPI> <Turnstile> <SNIPPET_SRC
  origin>`, `connect-src 'self' <Clerk> <API_URL> <snippet origin>`,
  `frame-src 'self' <Turnstile> <Clerk>`, `frame-ancestors 'none'`,
  `img-src https:`, `object-src 'none'`, `base-uri 'self'`; the Clerk host
  is decoded from the publishable key so prod's `clerk.<domain>` needs no
  configuration. The onboarding preview
  (`/app/onboarding/:slug/preview`) sets its own `frame-ancestors 'self'`
  and keeps it; a route-owned CSP is never overridden and gets no
  `X-Frame-Options` beside it. Plus `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a
  `Permissions-Policy` that disables camera, microphone and geolocation,
  and HSTS in preview/prod. The flash cookie is `httpOnly`, `secure`
  outside local, `sameSite=lax`, signed with `SESSION_SECRET`
  (`app/lib/flash.server.ts`). Clerk's session cookies are Clerk's.

### 4.6 Webhooks (T9)

`POST /webhooks/clerk` verifies the Svix signature over
`${id}.${timestamp}.${body}` with the environment's signing secret and the
Standard Webhooks 5-minute timestamp tolerance (Clerk's `verifyWebhook`),
answers 400 on any failure and 503 when the secret is unset
(`apps/dashboard/app/lib/clerk-webhook.server.ts`). New in #49: bodies over
256 KiB are refused (413) from `Content-Length` and again on the bytes read,
before the HMAC. Tests cover a wrong secret, a tampered body, missing
headers, an hour-old and a 5.5-minute-old timestamp, and an oversized but
correctly signed body (`clerk-webhook.server.test.ts`).

### 4.7 Uploads (T10)

`createUpload` (`apps/dashboard/app/lib/csv.server.ts`) enforces, server
side and before anything reaches R2: non-empty, ≤10 MiB
(`MAX_UPLOAD_BYTES`; the route also refuses a `Content-Length` over it
before reading the form), and the extension allowlist `.csv .tsv .txt
.json`. New in #49: the browser's declared `Content-Type` only breaks a tie
for a file with **no** extension — `payload.exe` sent as `text/csv` is
refused (`csv.server.test.ts`, and a disguised case in
`csv.server.integration.test.ts` asserting nothing was stored). The stored
key uses our extension, the bytes are only ever parsed (streaming CSV
parser, JSON shape-checked), and the original file is never served back.

### 4.8 Pipeline (T11)

Every `proofql-ingest` body is validated with `ingestMessageSchema`
(`packages/core/src/queue.ts`) before anything runs; a body that does not
parse is **acknowledged and logged** (`ingest.message.invalid`), never
retried, because garbage does not become valid on redelivery
(`workers/pipeline/src/handlers.ts`, #68). The schema is `z.object`, so an
unknown extra field is stripped rather than refused (harmless: nothing
reads it), and the ids are non-empty strings with no length cap — a
non-uuid `reviewId` fails at the database on the first attempt and lands in
the DLQ after three retries (`dlq.ts`, #82). Both are acceptable because the
queue has no public producer: only the api (after a secret key) and the
dashboard (after a Clerk session) write to it, and the consumer re-reads
the row and applies the publication policy itself, so no message can
publish a hidden review.

### 4.9 Supply chain and secrets (T13)

- `pnpm audit --prod --audit-level=high` runs in CI as a report-only job
  (`.github/workflows/ci.yml` `audit`, `continue-on-error`): a new upstream
  advisory must not block every PR at once; the red mark is the signal.
  Transitive pins go in the root `pnpm.overrides` (`form-data >= 4.0.6`,
  GHSA-hmw2-7cc7-3qxx, build-time only under `starlight-openapi`). An
  advisory with **no patched version** may be listed in
  `pnpm.auditConfig.ignoreGhsas` only when the package never runs in a
  deployed worker — today `http-cache-semantics` under `astro`
  (GHSA-ch52-4w7c-c8xp, a build-time HTTP cache in the docs build; the docs
  site ships static files). Re-check the list when Dependabot bumps the
  parent, and drop the entry once a fix exists.
- Dependabot opens weekly grouped minor/patch PRs for npm and for GitHub
  Actions, majors individually (`.github/dependabot.yml`).
- Secrets scanning is **GitGuardian** on the GitHub app side, already
  active on the repository; a second scanner (gitleaks) would duplicate
  it. The tree-side rule is in [secrets.md](secrets.md): `.dev.vars` and
  `.env` are gitignored and nothing secret enters `wrangler.jsonc` vars.
- The deploy token's scopes are the minimum for `wrangler deploy`
  (`infra/provisioning.md` step 8); a zone permission is added only when a
  custom domain exists.

## 5. Gaps this PR closed

| Gap | Now |
|---|---|
| No limit on authentication failures per address | `auth-throttle.ts`, `RL_AUTH_FAIL` |
| `POST /v1/query` had no body limit; no media-type check anywhere | `request-guards.ts`: 16 KiB, 415 |
| No security headers on api responses | `security-headers.ts` |
| `x-request-id` accepted any 128 bytes | token charset, api and dashboard |
| Dashboard had no CSP, framing, referrer or HSTS headers | `app/lib/security-headers.ts` |
| Clerk webhook accepted any body size | 256 KiB cap before HMAC |
| Upload allowlist bypassable with a declared type | extension decides |
| Snippet lacked `Cross-Origin-Resource-Policy` | `cross-origin` on `/v1*.js` |
| No dependency audit, no Dependabot | `audit` job, `dependabot.yml` |
| Threat model not written down | this file |

## 6. Runbook: a key leaked

**Publishable key (`pq_pk_…`)** — it was always public; a "leak" means
someone is spending the project's quota from outside its sites.

1. Dashboard → project → **Keys** → revoke it. Takes effect on the next
   request everywhere but `/v1/query`, where the api may hold the resolved
   key in KV for up to 60 s (`workers/api/src/auth-cache.ts`, #108): the
   revoke action bumps the project's cache generation, which ends the
   entry at once in the colo that sees the bump and within KV propagation
   (≤ 60 s) elsewhere — so budget **about a minute, at most two**, during
   which the old key can still *read* the project's publishable reviews
   (the thing a publishable key publishes to every visitor anyway) and
   nothing else.
2. Create a new publishable key, update the snippet tag on the customer's
   pages (`data-key` / `?key=`).
3. **No manual cache generation bump is needed**; the revoke does one.
   Cached query responses are keyed by project, environment, generation and
   request — never by key — and carry no key in their body or headers, so
   nothing cached was wrong or newly readable; the bump exists for the
   auth entry above and costs one round of cache misses.
4. Check `quota.rejected` / `ratelimit.rejected` lines for the project to
   see what the abuse cost; the monthly quota resets on the first.

**Secret key (`pq_sk_…`)** — treat as full compromise of that project's
reviews.

1. Revoke in **Keys** immediately; create the replacement; deploy it to the
   customer's server (the Authorization header). Old key fails on the next
   **write** at once (write routes resolve the key from the database on
   every request); on `/v1/query` it can still read for the minute above.
2. Audit: `reviews.rejected` and the `ingest_runs` rows (kind `api`) for
   the project since the suspected time tell you what was written or
   deleted; `GET /v1/reviews` with the new key shows the current state.
   Deleted reviews are re-imported from the source (CSV, push API, Google).
3. No manual generation bump needed: the revoke does one. If reviews
   *were* changed, the routes that changed them already bumped it too.

**Clerk signing secret, `SESSION_SECRET`, deploy token, Neon password** —
[secrets.md](secrets.md) "Incident checklist".

## 7. Owner-side settings (Cloudflare dashboard)

These are zone-level features and **need a custom domain** (`api.proofql.com`,
`cdn.proofql.com`, the dashboard's hostname; `infra/provisioning.md`
"Custom domains"). On `workers.dev` there is no WAF; until then the
worker-side controls in §4 are the whole defence. Apply in **Security →
WAF** of the zone:

| # | Rule | Where | Expression / setting | Action |
|---|---|---|---|---|
| W1 | Rate limiting rule, backstop by IP | api host | `(http.host eq "api.proofql.com" and starts_with(http.request.uri.path, "/v1/"))`, characteristic **IP**, **600 requests / 10 s** (above any plan's per-key limit, so a legitimate client never meets it before the worker's 429 does) | Block for 10 s |
| W2 | Custom rule: no User-Agent on ingest | api host | `(http.host eq "api.proofql.com" and starts_with(http.request.uri.path, "/v1/reviews") and len(http.user_agent) eq 0)` | Block |
| W3 | Bot Fight Mode | dashboard zone | Security → Bots → **Bot Fight Mode** on; leave **Super Bot Fight Mode** off for the api and cdn hosts (the snippet is fetched by every browser and the api by servers — a bot challenge there blanks customer pages) | — |
| W4 | Managed rules | all three | Cloudflare Managed Ruleset, default action | — |

Owner: @plattegruber, when the zone exists; add a line to
`infra/provisioning.md` "Custom domains" pointing here at that time.

## 8. Residual risks

| Risk | Why accepted | Owner / follow-up |
|---|---|---|
| Dashboard CSP allows `'unsafe-inline'` scripts | React Router emits an inline hydration script per page; nonces need the framework's `nonce` plumbing through `entry.server.tsx` and `Scripts` | File: nonce-based CSP (dashboard) |
| Auth-failure throttle boxes a shared NAT for ≤60 s after thirty failures | A working integration never produces thirty failures a minute; the alternative (never refusing before auth) leaves enumeration cost uncapped | Accepted; W1 is the coarser twin |
| Penalty box is per isolate | The binding is the authoritative count; the box only saves the lookup on the isolate that saw the overflow | Accepted |
| Cloudflare rate limiting bindings are approximate and per colo | Abuse protection, not billing; documented in `rate-limit.ts` | Accepted |
| Queue schema strips unknown fields and caps no id length | No public producer; consumer re-reads the row | Accepted |
| No WAF until a custom domain exists | `workers.dev` has none; §7 lists the rules to apply then | @plattegruber |
| `pnpm audit` is report-only, and ignores `GHSA-ch52-4w7c-c8xp` | A blocking audit would stall every PR on an upstream advisory with no fix; the ignored advisory has no patched version and is build-time only (§4.9) | Accepted; Dependabot is the fix path |
| Secret-key lookup cost on enumeration is a digest + indexed miss per guess until the throttle engages (30) | Entropy makes success impossible; cost is bounded by the throttle and W1 | Accepted |
| Review avatars load from any `https:` host (`img-src`) | Source-hosted images; images cannot execute | Accepted |
