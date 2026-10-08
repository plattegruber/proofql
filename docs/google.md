# Google Business Profile connector

How ProofQL reads a project's Google reviews (epic #8): what is polled, how
often, how the shared Google quota is respected, what `needs_reauth` means,
and how to run everything against the fake Google server. The connect flow
(OAuth, location discovery, the dashboard's Integrations tab) is #45; this
page covers the polling side (#46) and the pieces both share.

**Production status: dark until Google approves API access (#44).** A
Google Cloud project starts with a quota of 0 QPM on every Business Profile
API, so every real call fails until the approval flips it to 300 QPM.
Nothing here needs real Google to develop or test: the fake server stands
in for every Google host. Getting the approval, switching the connector on
and taking the OAuth consent screen to production are the owner's steps in
[`google-access.md`](google-access.md).

## Connecting (#45)

**Project → Integrations → Connect Google.** The tab has three states:

| State | When | What the user sees |
|---|---|---|
| Pending approval | `GOOGLE_CONNECTOR_ENABLED` is not `"true"` (every deployed environment until #44) | "Google connection is pending approval" and a link to the approval issue; the connect route answers 503. |
| Not connected | no `connections` row, or `status = disconnected` | The pitch (read-only, every six hours) and a **Connect Google** link. |
| Connected | `status = active` or `needs_reauth` | Status badge, last synced / last run / cadence, the **location picker**, **Reconnect**, **Disconnect**. |

The flow (`apps/dashboard/app/lib/google.server.ts`, pure parts in
`packages/google/src/connect.ts`):

1. `GET /app/projects/:slug/integrations/google/connect` mints a PKCE
   verifier and a nonce, stores `oauth:<nonce>` → `{ verifier, projectId,
   accountId }` in KV (`CACHE`, ten-minute TTL), signs
   `state = { projectId, accountId, nonce, exp }` with
   `GOOGLE_OAUTH_STATE_SECRET` (HMAC-SHA256), and 302s to
   `accounts.google.com/o/oauth2/v2/auth` with
   `scope=business.manage`, `access_type=offline`, `prompt=consent`,
   `code_challenge_method=S256`.
2. Google returns to `GET /app/integrations/google/callback?code&state` —
   **one redirect URI per environment**, the project rides in the state.
   The callback requires the signed-in account to match the state, verifies
   the signature and expiry, reads **and deletes** the nonce (a replay
   finds nothing and is refused), exchanges the code with the stored
   verifier, **refuses if Google withheld a refresh token**, encrypts
   `{ access_token, refresh_token, expiry }` under `CREDENTIALS_KEY` and
   upserts the project's one Google connection (`status = active`;
   reconnecting replaces the credentials and keeps the cursor and the
   enabled locations).
3. Discovery: `accounts.list` (pages of 20) then `locations.list` per
   account with `readMask=name,title,storefrontAddress,metadata` (pages of
   100), stored as `metadata.locations[] = { id, account, title, address,
   verified, enabled, placeId? }` plus `metadata.accounts` and
   `discovered_at`. `verified` is `metadata.hasVoiceOfMerchant === true`
   (the fake models that field; **confirm against the real API when #44
   lands** — the alternative is the Verifications API's
   `VoiceOfMerchantState`). Unverified locations render disabled with the
   reason "Google only serves reviews for verified locations."
4. **Save locations** sets `enabled` on the ticked verified locations,
   `metadata.initial_sync_pending = true`, and enqueues
   `connection.sync { connectionId, projectId }` on `proofql-ingest`; the
   pipeline polls that connection within seconds. **Disconnect** (inline
   confirm) clears `credentials` and sets `status = disconnected`; the
   mapping and the reviews stay. **Reconnect** is the same connect flow;
   it is the fix for `needs_reauth`.

Local recipe (everything against the fake; no Google account involved):

```sh
pnpm run setup                                 # generates the shared CREDENTIALS_KEY
pnpm --filter @proofql/google dev:fake         # :8802
pnpm dev --filter @proofql/dashboard           # :8799, local auth stub
pnpm dev --filter @proofql/pipeline            # consumes connection.sync
open http://localhost:8799/app/projects/cedar-ridge-dental/integrations
```

Click **Connect Google**: the fake's consent screen auto-approves and
bounces straight back; tick North and South, save, and the pipeline's
`connection.sync` imports 113 reviews. The owner's steps for the real OAuth
client, the redirect URIs and the testing-mode caveat are in
[`infra/provisioning.md`](../infra/provisioning.md).

## What is polled

For every `connections` row with `kind = google` and `status = active`:

| | |
|---|---|
| **Locations** | The ones in `metadata.locations` that are both `enabled` (the user ticked them in the dashboard) and `verified` (Google only serves reviews for verified locations; discovery derives the flag from the Business Information v1 `metadata.hasVoiceOfMerchant` — the fake models that field; confirm against the real API when #44 lands, the alternative is the Verifications API's `VoiceOfMerchantState`). |
| **Endpoint** | My Business **v4** `GET /v4/accounts/{a}/locations/{l}/reviews?pageSize=50&orderBy=updateTime desc` — reviews never moved to the v1 APIs. |
| **Cursor** | Per location, in `connections.cursor` as JSON `{ "<locationId>": "<newest updateTime seen>" }`. A tick walks newest-first and stops at the first review whose `updateTime` is at or before the cursor, so an incremental tick is one request per location. `updateTime`, not `createTime`, so an **edited** review re-enters and its text is updated (the upsert re-indexes on a text change). |
| **Shape** | `packages/google/src/adapter.ts`: `external_id` = the full resource name `accounts/…/locations/…/reviews/…` (stable across edits), `rating` from `starRating` (`ONE`..`FIVE`; anything else, including `STAR_RATING_UNSPECIFIED`, is rejected and counted), `occurred_at` = `createTime`, `author_name` (anonymous → "Google user"), `author_avatar_url`, `url` = `https://search.google.com/local/reviews?placeid=…` when discovery saw a place id, `metadata.location` / `metadata.location_title` so a multi-location site can filter by branch (`"metadata.location": "201"`). Unknown fields anywhere in Google's payload are tolerated. |
| **Star-only reviews** | A rating with no comment is skipped and counted (`skipped`): the review schema requires text, and an excerpt search has nothing to show for an empty review. |
| **Write path** | `upsertReviews` from `@proofql/db` — the same function the push API and the CSV import use — in batches of 100 with `onLimit: "truncate"`; the reviews it refuses at the plan cap count as `failed` on the run and log `google.cap_reached`. Each committed batch enqueues its `review.index` messages. |
| **Record** | One `ingest_runs` row (`kind = google`, `environment = live`) per connection per tick with `received` / `created` / `updated` / `skipped` / `failed`; `connections.last_synced_at` is stamped on success. |

Connections carry no environment: a connected Google account produces live
reviews. Reply publishing and profile snapshots are out of scope.

## Cadence and first sync

- **Cron:** the pipeline's single five-minute cron runs the poll on the 00:00, 06:00, 12:00 and 18:00 UTC ticks (`workers/pipeline/src/schedule.ts`, #174). Review latency is therefore up to six hours; a skipped tick defers it to the next one six hours later.
- **First sync in seconds:** saving the location mapping in the dashboard sets `metadata.initial_sync_pending` and enqueues a `connection.sync` message on `proofql-ingest`; the pipeline consumes it and polls just that connection right away (`pollGoogleConnections({ connectionIds })`). If the message is lost, the next cron tick processes pending connections first.
- **Order within a tick:** pending initial syncs first, then every other connection in a deterministic shuffle seeded by the tick's hour (`stableOrder`), so the order is reproducible for one tick and no connection is always last.
- **Budget:** a tick stops after ten minutes and defers the rest to the next one (`google.tick.budget_exhausted`); cursors are persisted per completed location, so a cut-off tick never re-walks finished work.

A `connection.sync` message and a cron tick can overlap on one connection.
Both are idempotent — the upsert is keyed on the review's resource name and
cursors only move forward — so the worst case is one redundant page.

## Superseding the Places bootstrap (#116)

Onboarding can seed a project with up to five reviews from the Places API
(#115) before Google approves the connector. Those rows are `source =
google` with an `external_id` under `places/` (and `metadata.place_id`).
When a connection completes its **first** successful sync — `last_synced_at`
was null, or `metadata.initial_sync_pending` was set — the poller deletes
the project's bootstrap rows in the same transaction that clears the
pending flag (`supersedePlacesBootstrap`), lowers `projects.review_count`
by the same number, and bumps the project's cache generation
(`google.bootstrap_superseded`), because the connector now holds the same
reviews under their Business Profile ids. Later syncs find nothing to
delete and bump nothing. Other Google reviews — a push-API review with an
`accounts/…` id, say — are never touched. The 25-day Places refresh of
#116 item 1 is a separate follow-up.

## Quota math

All of ProofQL shares one Google Cloud project, and every Business Profile
API is quota'd at **300 QPM per project** after approval. The pacer
(`packages/google/src/pacing.ts`) is global to a tick: at most **240
requests per minute** (80%), evenly spaced (250 ms) with up to 100 ms of
jitter added, sequential pagination, never a parallel fan-out — Google's own
guidance. Token-endpoint calls are not under this quota and are not paced.

Incremental cost is one `reviews.list` call per enabled verified location per
tick; a first sync costs ⌈reviews / 50⌉ calls (a 5,000-review free-tier
project is 100 calls, 25 seconds).

| Projects | Locations (×2) | Calls / tick | Tick at 240 QPM | Calls / day |
|---|---|---|---|---|
| 10 | 20 | 20 | 5 s | 80 |
| 100 | 200 | 200 | ~50 s | 800 |
| 1,000 | 2,000 | 2,000 | ~8 min | 8,000 |
| 10,000 | 20,000 | 20,000 | ~83 min | 80,000 |

Ten minutes of budget per tick covers ~2,400 calls, i.e. roughly a thousand
projects before ticks start deferring; raise the cron frequency or the
budget, or request a quota increase (Google grants one once sustained use
is past ~50% of the current quota), when the `deferred` count in
`google.tick.completed` stops being zero.

## Failure shape

| Google says | The poller does |
|---|---|
| **429** | Stops the whole tick (the quota is shared; more requests dig deeper). The connection's run is closed `failed` with a readable reason, `google.rate_limited` is logged with `Retry-After`, and everything resumes next tick from the persisted cursors with no duplicate rows. |
| **5xx** | Waits `Retry-After` (else 1 s, at most 5 s), retries once (`google.request_retry`); a second failure fails that connection's run only and the tick moves on. |
| **401** | Forces one token refresh and retries; still 401 ⇒ that connection's run fails. |
| **403 / 404 on a location** | Skips that location (`google.location.failed`), finishes the others, closes the run `failed` with the location named. |
| **`invalid_grant` on refresh** | See below. |

## `needs_reauth`

`connections.status = needs_reauth` means the refresh token is dead and
only the user can fix it, by reconnecting Google in the dashboard. The
poller sets it (and NULLs `credentials` — dead tokens are never kept) when
the token endpoint answers `invalid_grant`, or when the stored ciphertext
cannot be decrypted (a rotated `CREDENTIALS_KEY`). It logs
`google.needs_reauth` with the reason and skips the connection on every
later tick. Expected causes, none of them bugs:

- the consent screen is in **Testing** publishing status: Google expires
  refresh tokens after **7 days**. Every connection will churn weekly until
  the OAuth app is published (scope §7.2);
- the user revoked ProofQL's access in their Google account;
- the token sat unused for six months (our polling keeps it warm);
- the Google account passed the 100-refresh-tokens-per-client cap.

Access tokens live an hour; the poller refreshes one that expires within
five minutes and stores the new token re-encrypted.

## Credentials

`connections.credentials` is `v1:<iv>:<ciphertext>` — AES-256-GCM over
`{ access_token, refresh_token, expiry }` under `CREDENTIALS_KEY` (base64 of
32 random bytes, `openssl rand -base64 32`; `docs/secrets.md`). The pipeline
and the dashboard must hold the **same** key. Rotating it means every
connection goes `needs_reauth` and users reconnect; the `v1:` prefix leaves
room for a re-encrypt migration later. Tokens never reach the logs: lines
carry connection, project, location and run ids only.

## Running against the fake

`packages/google/src/fake` is a Hono app that serves every Google host from
one origin: the consent screen (auto-approving), the token endpoint (PKCE,
refresh, an `invalid_grant` knob), `accounts.list`, `locations.list`
(`readMask` required) and v4 `reviews.list` — with one account, three
locations (two verified, one not) and 120 reviews spread over two years, a
few edited, a few replied, one star-only and one anonymous per location.

```sh
pnpm --filter @proofql/google dev:fake        # http://localhost:8802 (inspector 9244)
curl http://localhost:8802/                   # lists the endpoints
curl "http://localhost:8802/v1/accounts?scenario=429" -H "Authorization: Bearer x"
```

`?scenario=429|500|503` on any `/v1` or `/v4` request returns that status
(`Retry-After: 1` on 429). `workers/pipeline/.dev.vars.example` already
points `GOOGLE_OAUTH_BASE`, `GOOGLE_TOKEN_URL` and `GOOGLE_API_BASE` at
port 8802 and carries placeholder client credentials (the fake ignores
them); unset, each endpoint falls back to its real Google host
(`packages/google/src/endpoints.ts`).

To fire the cron locally:

```sh
pnpm --filter @proofql/pipeline dev -- --test-scheduled
curl "http://localhost:8798/cdn-cgi/local/scheduled?time=1790812800000"  # 2026-10-01T00:00Z
```

It finds work only if an `active` Google connection exists whose encrypted
refresh token the fake honours — which is what the connect flow (#45)
creates. The quickest full run is the integration suite, which builds that
state itself: `DATABASE_URL=postgres://proofql:proofql@localhost:54323/proofql
pnpm --filter @proofql/pipeline test:integration`
(`src/google-poll.integration.test.ts`). Tests inject `createFakeGoogle().fetch`
in-process; no port is involved.

## Tests

- `packages/google`: adapter (fixtures, unknown fields, star-only, unknown
  enum, anonymous), credentials (round trip, tamper, wrong key), pacer
  (spacing, rolling-window cap, jitter, stable order), client (paging,
  429/5xx/401 typing, readMask), OAuth (refresh, `invalid_grant`, exchange),
  the fake itself.
- `workers/pipeline/src/google-poll.integration.test.ts`: first sync,
  incremental tick with one new and one edited review, 429 stop-and-resume
  without duplicates, `invalid_grant` → `needs_reauth`, token refresh,
  disabled and unverified locations skipped, plan-cap truncation counted,
  5xx retry, the queue path, the unconfigured and rotated-key cases.
- `workers/pipeline/src/handlers.test.ts`: `connection.sync` routing and
  the tick's job isolation; `src/schedule.test.ts`: which jobs are due when.

Log events: `docs/observability.md` → pipeline → `google.*`.
