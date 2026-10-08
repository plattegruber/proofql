# Observability

How ProofQL's workers log, what they log, and how to read it (#30). This is
the contract for log lines: the shape, the event catalogue, the redaction
rule, and the one question the query logs exist to answer — *is the
relevance floor right for this project?* Error tracking and alerting are
not here yet; they land on top of these lines.

## The one logging convention

Every worker logs **single-line JSON through the shared logger** in
[`packages/core/src/log.ts`](../packages/core/src/log.ts). Nothing under
`workers/`, `apps/`, or `packages/core` calls `console.*` directly — Biome's
`noConsole` fails the build if it does; the logger's sink is the one
sanctioned call.

```ts
import { createLogger } from "@proofql/core";

const log = createLogger({ service: "pipeline", environment: env.ENVIRONMENT });
const message = log.child({ message_id: msg.id, attempt: msg.attempts });
message.log("review.indexed", { review_id, chunks: 3, embedding_ms: 41 });
```

emits

```json
{"ts":"2026-10-01T12:00:00.000Z","service":"pipeline","environment":"prod","event":"review.indexed","level":"info","message_id":"…","attempt":1,"review_id":"…","chunks":3,"embedding_ms":41}
```

The shape, in order:

| Field | Meaning |
|---|---|
| `ts` | ISO 8601, when the line was emitted. |
| `service` | `api` \| `pipeline` \| `dashboard` — which deployable. |
| `environment` | The worker's deployment environment from wrangler `vars`: `local` \| `preview` \| `prod` (`test` under Vitest, `unknown` when a test drives the app with no bindings). **Not** the API key's environment — that is `key_environment` (`live` \| `test`), where it applies. |
| `event` | A stable dotted name from the catalogue below. Variability goes in fields, never in the event, so lines stay countable. |
| `level` | `info` \| `warn` \| `error`. `info` unless the call passes `level`, or the fields carry an `error` — a line that reports an error is an error. |
| …fields | snake_case, matching the API's wire format. `child()` bindings come first, then the call's fields (later keys win). |

`Error` values are flattened to `{ name, message, cause? }`; stacks are
never serialized except on `request.failed` (below). `undefined` fields
are dropped. Field names mean one thing everywhere: `project_id` is always
the tenant, `review_id` always a `reviews.id`, `took_ms` always wall time
for the whole unit of work.

### Redaction

Any field named `text`, `excerpt`, `author_name`, `key`, `plaintext`, or
`authorization` — **at any depth** — is replaced with `"[redacted]"` before
serialization (`REDACTED_FIELDS` in `log.ts`; a unit test pins the list).
Review text, excerpts, author names, and API keys therefore cannot reach the
logs through this logger even when a call site passes them by mistake.

That is a seatbelt, not permission. The rule for call sites is: log
**identifiers and measurements, never content**. `q_length`, not `q`;
`review_id`, not the review; `returned`, not the results. Nothing in the
catalogue below carries user-provided text, and the api's integration tests
assert that the query line never contains the query.

## Correlation ids

| Context | Binding | Where it comes from |
|---|---|---|
| `workers/api` request | `request_id`, `method`, `path` | `requestContext` middleware ([`request-id.ts`](../workers/api/src/request-id.ts)), first in the chain. The id honours an inbound `x-request-id` (≤128 chars), else Cloudflare's `cf-ray`, else `crypto.randomUUID()`. Echoed on every response as `x-request-id` and inside every error envelope as `request_id`, so a support ticket quotes one string. `path` excludes the query string, so a `?key=` never lands in a line. |
| `workers/pipeline` queue message | `queue`, `message_id`, `attempt`, then `review_id`, `project_id`, `environment` once the body parses | `handleQueueBatch` ([`handlers.ts`](../workers/pipeline/src/handlers.ts)) creates one child per message and hands it to `indexReview` in the context, so `review.indexed` and the `ingest.message.*` decision carry the same ids without passing them around. `handleDeadLetters` ([`dlq.ts`](../workers/pipeline/src/dlq.ts)) binds the same fields for `proofql-ingest-dlq` deliveries; `queue` tells the two apart. |
| `workers/pipeline` cron | `trigger: "cron"`, then for the Google poll `connector`, `connection_id`, `project_id`, `ingest_run_id`, `location` | `handleScheduled`; `pollGoogleConnections` binds the rest per connection and location ([`google-poll.ts`](../workers/pipeline/src/google-poll.ts)). A `connection.sync` queue message runs the same code under the queue bindings with `trigger: "queue"`. |
| `apps/dashboard` request | `request_id`, `method`, `path` | The worker entry ([`workers/app.ts`](../apps/dashboard/workers/app.ts)) resolves the id with the api's rule, binds the child, and hands it to every middleware/loader/action as `getCloudflare(context).log`; echoed as `x-request-id`. Loaders never touch `console`. |

Route and indexer code never adds these fields itself: it logs through the
child it was given (`c.get("log")` in Hono; `ctx.log` in the pipeline).

The api's `request_id` is **not** propagated into the queue message today.
The ingest route answers `202`-style before the pipeline runs, and the
review's lifecycle is already keyed on `review_id`, which both the ingest
response and every pipeline line carry; join on that. If a request-to-index
trace is ever needed, add `request_id` to `IngestMessage` (optional on the
wire) and bind it in `handleQueueBatch`.

## Event catalogue

### api

| Event | Level | Fields beyond the request bindings | When |
|---|---|---|---|
| `query.completed` | info | `project_id`, `key_environment`, `key_kind`, `mode`, `fallback`, `has_q`, `q_length`, `limit`, `min_rating`, `similarity_floor`, `category`, `returned`, `match`, `cached`, `took_ms`, `embedding_ms`, `search_ms`, plus `rerank_ms` only when experimental reranking ran (`RERANK=true`, #147) | Exactly once per answered `/v1/query`, hit or miss. See [Tuning the floor](#tuning-the-similarity-floor). |
| `query.rerank_failed` | error | `project_id`, `q_length`, `error` | Only with `RERANK=true` (off by default, #147): the reranker call failed and the candidates were held to the ordinary two-tier floor instead. |
| `query.rejected` | warn (error for 5xx) | `code`, `status`, and `project_id`, `key_environment`, `key_kind` when auth had run | Any `ApiError` on `/v1/query`: 401/403 auth and CORS, 422 validation, 429 rate limit or quota, 503 `embedding_unavailable`. |
| `query.embedding_failed` | error | `project_id`, `key_environment`, `key_kind`, `q_length`, `embedding_ms`, `error` | Workers AI failed or is unbound; the response is 503 and there is deliberately no full-text fallback. Followed by a `query.rejected` with `code: embedding_unavailable`. |
| `query.cache_error` | warn | `project_id`, `key_environment`, `op` (`get` \| `put`), `error` | A **Cache API** read or write threw (custom domains, #158). The request is served as a miss; the cache can slow the endpoint down, never take it down. A KV fault on the result cache is a `kv.*` line instead (site `api.query_cache`). |
| `reviews.rejected` | warn | as `query.rejected` | Any `ApiError` on `/v1/reviews*`. |
| `request.rejected` | warn | as `query.rejected` | Any other refused request, including unknown routes (404). |
| `request.failed` | error | `error`, `stack` (first 2,000 chars) | An unhandled exception became a 500 `internal`. The only line that carries a stack, and the only place the cause is recorded; the client sees the request id and nothing else. |
| `ratelimit.rejected` | warn | `project_id`, `key_environment`, `key_kind`, `api_key_id`, `limit`, `period`, `retry_after` | A key hit its per-kind limit ([`rate-limit.ts`](../workers/api/src/rate-limit.ts)). Also produces a `*.rejected` with `code: rate_limited`; this line has the limiter's numbers. |
| `quota.rejected` | warn | `project_id`, `key_environment`, `key_kind`, `plan`, `limit`, `uncached`, `queries`, `cache_hits`, `retry_after` | The project is at its plan's monthly uncached-query quota ([`quota.ts`](../workers/api/src/quota.ts)); only a cache miss can trigger it. |
| `auth.cache_error` | warn | `op` (`get` \| `put`), `error` | The auth cache's Cache API tier ([`auth-cache.ts`](../workers/api/src/auth-cache.ts), #108, #158) threw on `/v1/query`; the key was resolved from the isolate or the database instead. The cache can slow auth down, never take it down. |
| `auth.stale_served` | warn | `project_id`, `age_s`, `error` | The database lookup for a key failed as unavailable (connection failure or Hyperdrive's daily limit) and a cached entry past its 60 s freshness, at most an hour old and with an unchanged generation, stood in (stale-if-error, #158). Expect a burst of these during a Hyperdrive outage; that is the HIT path staying up. |
| `quota.exhausted` | error | `resource` (`hyperdrive` \| `kv`), `retry_after`, `renews_at` (ISO, or null), `error` (the `queues` form is under [Every service: ingest queue faults](#every-service-ingest-queue-faults-159)) | A daily platform allowance is spent (#142, #158): Hyperdrive's `Usage limit for account exceeded, usage renews at …` or KV's `… limit exceeded for the day` reached the error handler. The response is 503 `service_unavailable` with `Retry-After` set to the seconds until the renewal (300 when none is stated), and a `*.rejected` with that code follows. Level error so it alerts: until the renewal every request needing the resource fails, for every tenant (docs/launch.md §16). |
| `db.unavailable` | warn | `code` (SQLSTATE such as `53300`, or a driver code such as `CONNECT_TIMEOUT`), `error` | The database refused or timed out a connection ([`db.ts`](../workers/api/src/db.ts) `isDatabaseUnavailable`); the response is 503 `service_unavailable` with `Retry-After: 1`, and a `*.rejected` with that code follows. `53300` is Hyperdrive's origin limit or Neon's `max_connections`; `CONNECT_TIMEOUT` is a pool queue that outlasted the 10 s connect timeout. No stack: the cause is a known shape, not a bug. |
| `usage.flush_failed` | error | `projects`, `queries`, `cache_hits`, `error` | The batched `usage` write ([`usage-buffer.ts`](../workers/api/src/usage-buffer.ts), #108) failed and that window's counts were dropped — the totals in the line are what the dashboard will under-report. Not retried: the database just refused a connection. |
| `auth.throttled` | warn | `phase` (`failure` \| `penalty_box`), `limit`, `period`, `retry_after` | An address exceeded the per-IP budget of authentication failures ([`auth-throttle.ts`](../workers/api/src/auth-throttle.ts), #49): `failure` is the 401/403 that overflowed and was answered 429 instead; `penalty_box` is a later request from the same address refused before auth. The address is deliberately not logged (identifiers and measurements, never personal data); Cloudflare's request logs carry it. No `*.rejected` accompanies the `penalty_box` form. |

`query.completed` field notes:

- `cached` is `HIT`, `MISS`, or `BYPASS` (the caller sent `Cache-Control:
  no-cache`; the fresh answer was still stored) — the same value as the
  `x-cache` response header. On a `HIT`, `embedding_ms` and `search_ms`
  are `0` and `took_ms` is the cache round-trip.
- `has_q` / `q_length`: whether a query was sent and how long it was, in
  UTF-16 code units. Without `q` the endpoint returns the newest publishable
  reviews and `similarity_floor` played no part.
- `min_rating` is the **effective** floor: `max(project.min_rating,
  filters.min_rating)`.
- `category` is the project's business category (`projects.category`,
  #151), or `null` when unset. It picks the generic words the floor's
  partial word match ignores, so group by it when tuning per category.
- `fallback` is the request's option (`none` | `recent`) and `match` the
  response's verdict (`query` | `fallback` | `none` | `recent`, #86). A
  `match = fallback` line is a query nothing cleared the floor for that was
  answered with the newest reviews instead — count it with `returned = 0`
  when measuring the empty rate below, since to the floor it was empty.
- `returned` is the length of `results`. There is no `candidates` count: the
  search statement returns only the top `limit` rows after the floor, and
  the number that cleared the floor before `LIMIT` would need a window
  count in `@proofql/db` (a cheap follow-up if the signal below proves
  insufficient). `returned < limit` means `returned` *is* the candidate
  count; `returned == limit` means at least that many.
- `took_ms` is the same number as the response body's `took_ms`;
  `embedding_ms` is the Workers AI call; `search_ms` is `searchChunks` —
  the one SQL statement — so `took_ms - embedding_ms - search_ms` is
  everything else (auth, KV, serialization).

### pipeline

| Event | Level | Fields beyond the message bindings | When |
|---|---|---|---|
| `ingest.message.invalid` | warn | `issues[]` (`path`, `message`) | The body failed `ingestMessageSchema`. Acked, never retried. |
| `ingest.message.processed` | info | `status` (`indexed` \| `skipped`), and for `indexed`: `chunks`, `windows`, `embedded`, `newly_indexed`, `sentiment`, `sentiment_source`; for `skipped`: `reason` | The handler's ack decision for one delivery. |
| `ingest.message.failed` | error | `error` | `indexReview` threw; the message is retried with backoff (`attempt` says which delivery this was), then DLQ'd by Queues after `max_retries`. |
| `ingest.dlq.recorded` | info | `review_found`, `max_attempts` | A dead-lettered message was written to `ingest_runs` as a failed `api` run with `error: index.dead_lettered: review <id> exhausted <attempts> queue retries`, and the review's `index_attempts` was raised to `max_attempts` so the sweep stops re-sending it ([`dlq.ts`](../workers/pipeline/src/dlq.ts), #82). `review_found: false` means the review row is gone; the run row is still written under the message's `project_id`. Acked. |
| `ingest.dlq.unparseable` | warn | `issues[]` (`path`, `message`) | A DLQ body failed `ingestMessageSchema`. Acked; the ingest consumer would have acked it too, so one arriving here means the wire shape changed between the two consumers. |
| `ingest.dlq.failed` | error | `error` | The `ingest_runs` insert or `reviews` update threw (database down, or the project is gone and the foreign key refused the row). Acked anyway: the DLQ consumer runs with `max_retries: 0` and no further DLQ, so a retry would only drop the message silently. This line is the record of last resort — a non-empty count here is the one DLQ signal that did not reach the dashboard. |
| `review.indexed` | info | `chunks`, `windows`, `sentences`, `embedded`, `embedding_ms`, `newly_indexed`, `sentiment`, `sentiment_source` | The one line per indexed review, from `indexReview`. `chunks` is `1 + windows + sentences`; `sentences` is 0 for a one-sentence review (#127). `newly_indexed` is whether this run flipped `indexed_at` (and therefore bumped the project's cache generation). |
| `cache.generation_bumped` | info | `projects` | A queue batch's held generation bumps were written, one KV write per project (#158: bumps are coalesced per batch, not per review). A failure is a `kv.*` line with site `pipeline.generation_bump` instead. |
| `review.skipped` | info | `reason` (`not_found` \| `hidden` \| `empty_text`) | A property of the review that redelivery cannot change. Acked. |
| `cron.tick` | info (warn if a job failed) | `jobs[]` (the jobs that ran), `failed[]` | One per cron tick ([`handlers.ts`](../workers/pipeline/src/handlers.ts) `runScheduledJobs`). The single five-minute cron (#174) runs `sweep` every tick, plus `google_poll` at 00/06/12/18:00, `places_refresh` at 03:30 and `account_purge` at 04:15 UTC ([`schedule.ts`](../workers/pipeline/src/schedule.ts)). |
| `cron.job_failed` | error | `job`, `error` | One job of a tick threw. The tick's other jobs still run; every job is idempotent and runs again at its next due time (the next tick for the sweep, six hours for the Google poll, a day for the Places refresh and account purge, both age-based so nothing is lost). |
| `sweep.completed` | info | `older_than_minutes`, `limit`, `enqueued`, `deferred`, `exhausted`, `batches`, `review_ids[]` (the ones sent) | Every cron tick ([`sweep.ts`](../workers/pipeline/src/sweep.ts)). `deferred > 0` means the Queues daily limit stopped the tick (a `quota.exhausted` with `site: pipeline.sweep` precedes it); those reviews kept their attempt count and go on the first tick after 00:00 UTC. |
| `sweep.exhausted` | warn | `max_attempts`, `count`, `review_ids[]` | Reviews stuck past the attempt cap, listed once per tick and not re-sent. A non-empty one is a review the pipeline cannot index: look at its last `ingest.message.failed`, or its `ingest.dlq.recorded` (a dead letter sets the counter to the cap directly). |
| `ingest.dlq.skipped` | warn | `type`, `connection_id`, `project_id` | A dead-lettered `connection.sync` (#46). Nothing to record: the six-hourly cron picks the connection up again. Acked. |

Google connector (#46, [`google-poll.ts`](../workers/pipeline/src/google-poll.ts); [docs/google.md](google.md)). Every line carries `trigger` (`cron` \| `queue`) and `connector: "google"`; per-connection lines add `connection_id`, `project_id`, and once the run is open `ingest_run_id`; per-location lines add `location`. A `connection.sync` message additionally carries the queue bindings (`message_id`, `attempt`). Tokens never appear: ids and counts only.

| Event | Level | Fields | When |
|---|---|---|---|
| `google.poll.skipped` | warn | `reason: not_configured`, `missing[]` | The tick found no `CREDENTIALS_KEY` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (or a `TBD-` placeholder) and did nothing. Expected in every deployed environment until #44 is approved. |
| `google.tick.started` | info | `connections`, `connection_ids[]`, `initial_sync` | A tick began; `initial_sync` counts connections with `metadata.initial_sync_pending`, which go first. |
| `google.tick.completed` | info | `connections`, `synced`, `needs_reauth`, `failed`, `deferred`, `rate_limited`, `received`, `created`, `updated`, `skipped`, `rejected`, `requests`, `indexing_deferred`, `paced_wait_ms`, `took_ms` | Every tick. `deferred > 0` means the tick stopped early (429 or budget); `requests` is the Google data-API call count the pacer admitted. `indexing_deferred` counts index messages not sent (#162): after the Queues daily limit the tick stops calling the queue, and the sweep indexes those reviews. |
| `google.tick.budget_exhausted` | warn | `budget_ms`, `deferred` | The ten-minute budget ran out between connections. Persistent ⇒ raise the budget or the quota (docs/google.md "Quota math"). |
| `google.sync.started` | info | `locations`, `location_ids[]`, `initial_sync` | A connection's run opened. |
| `google.sync.location` | info | `pages`, `received`, `created`, `updated`, `star_only`, `invalid`, `rejected`, `cursor_before`, `cursor_after` | One location finished (its cursor is persisted right after). |
| `google.sync.completed` | info | `locations`, `received`, `created`, `updated`, `skipped`, `rejected`, `indexing_deferred`, `superseded`, `took_ms` | The run closed `succeeded`; `last_synced_at` stamped. `indexing_deferred` is this connection's share of the tick's unsent index messages (#162); a refused send never fails the sync. |
| `google.sync.failed` | warn / error | the completed fields plus `error_message` (warn: the run closed `failed` with that reason), or `error` + `stage` (error: the token refresh threw something other than `invalid_grant`) | The run did not succeed. The warn form is the 429 / budget / per-location case and resumes next tick; the error form is the one to look at. |
| `google.sync.no_locations` | info | `mapped` | The connection has no enabled verified location; nothing to poll, the pending flag is cleared. |
| `google.token_refreshed` | info | `expiry` | The access token was refreshed and re-encrypted. |
| `google.needs_reauth` | warn | `reason` (`invalid_grant` \| `credentials_decrypt_failed` \| `credentials_bad_format` \| …) | The connection was set to `needs_reauth` and its credentials cleared; the user must reconnect (docs/google.md). |
| `google.rate_limited` | warn | `location`, `retry_after_ms` | Google answered 429; the tick stopped. A steady rate of these is the signal to request a quota increase. |
| `google.request_retry` | warn | `status`, `wait_ms` | A 5xx (one retry after `Retry-After`) or a 401 (one forced refresh). |
| `google.location.failed` | warn | `location`, `status`, `google_status` | A non-retryable Google error on one location (403 `PERMISSION_DENIED` on a location that lost verification, 404 on one that was removed); the others still sync. |
| `google.review.invalid` | warn | `issues[]` (`path`, `message`) | A review failed the adapter's schema (an unknown `starRating`, a malformed name or time); counted as skipped. Several in a row mean Google changed the payload. |
| `google.bootstrap_superseded` | info | `deleted`, `generation` | A connection's first successful sync deleted the project's Places bootstrap rows (`external_id` under `places/`, #115/#116) and bumped the cache generation (docs/google.md). |
| `google.cap_reached` | warn | `rejected`, `limit`, `review_count` | The plan's review cap refused part of a batch (`onLimit: "truncate"`); the refused count lands in the run's `failed`. |

Places bootstrap refresh (#116, [`places-refresh.ts`](../workers/pipeline/src/places-refresh.ts); [docs/places.md](places.md#refresh)). Every line carries `trigger: "cron"` and `job: "places_refresh"`; per-place lines add `project_id`, `environment`, `place_id`, `ingest_run_id` and `last_run_at` (when the run being refreshed finished).

| Event | Level | Fields | When |
|---|---|---|---|
| `places.refresh.skipped` | warn | `reason: not_configured`, `missing: ["GOOGLE_PLACES_API_KEY"]` | The tick found no Places key (or a `TBD-` placeholder) and did nothing. Expected until the key is set on the pipeline (docs/secrets.md). |
| `places.refresh.started` | info | `candidates`, `limit`, `after_days`, `oldest_run_at` | A tick began; `candidates` is how many `(project, environment, place)` triples are due (latest `places` run older than 25 days — a day for a failed one — no active google connection, bootstrap rows still present), capped at `limit` (200), oldest first. |
| `places.refresh.refreshed` | info | `received`, `created`, `updated`, `skipped`, `rejected`, `deleted`, `enqueued`, `indexing_deferred`, `category_set`, `generation` | One place refreshed and its run closed `succeeded`. `deleted` is the bootstrap rows Google no longer returned (also in the run's `error` note); `generation` is the project's new cache generation, or `null` when nothing changed. `indexing_deferred` counts index messages not sent (#162); the run still succeeds and the sweep indexes the reviews. `category_set: true` means the place's `primaryType` filled a null `projects.category` (#151). |
| `places.refresh.cap_reached` | warn | `rejected`, `limit`, `review_count` | The plan's review cap refused new reviews (`onLimit: "truncate"`); the count lands in the run's `failed`. |
| `places.refresh.failed` | warn / error | warn: `status`, `code`, `error_message` — Google refused (404: the place is gone; 403: the key; 429: quota) and the run closed `failed` with the human description; error: `error` — something after the run row opened threw | The warn form retries the place tomorrow; the error form is the one to look at. |
| `places.refresh.rate_limited` | warn | `deferred` | Google answered 429; the tick stopped and `deferred` places wait for tomorrow. A steady rate is the signal that the free Place Details quota is spent (docs/places.md "Quota math"). |
| `places.refresh.completed` | info | `candidates`, `refreshed`, `failed`, `deferred`, `rate_limited`, `received`, `created`, `updated`, `skipped`, `rejected`, `deleted`, `enqueued`, `indexing_deferred`, `requests`, `took_ms` | Every tick that ran. `requests` is the Place Details calls sent to Google; it should equal `refreshed + failed`. |

Account purge (#169, [`account-purge.ts`](../workers/pipeline/src/account-purge.ts) → `purgeDeletedAccounts` in [`packages/db/src/tenancy/purge.ts`](../packages/db/src/tenancy/purge.ts)). Daily on the 04:15 UTC tick; every line carries `trigger: "cron"`. The same function runs from `pnpm db:purge-accounts` (docs/launch.md §15), which prints instead of logging.

| Event | Level | Fields | When |
|---|---|---|---|
| `account.purged` | info | `account_id`, `deleted_at`, `projects`, `reviews` (sum of the projects' `review_count`), `upload_objects` (R2 objects removed; `null` without an `UPLOADS` binding) | One account soft-deleted more than 30 days ago was hard-deleted; FK cascades removed its projects and every tenant row. |
| `account.purge.completed` | info | `dry_run`, `cutoff`, `accounts`, `projects`, `reviews`, `upload_objects`, `remaining` | Every tick, including empty ones. `remaining: true` means more than 50 accounts were due and the rest wait for tomorrow; several days of it in a row means the purge is falling behind. |
| `uploads.delete_failed` | warn | `account_id`, `project_id`, `site: pipeline.account_purge`, `error` | A purged project's R2 prefix could not be deleted. The database purge is not undone; the bucket's 7-day lifecycle rule removes the objects anyway. |

### dashboard

| Event | Level | Fields beyond the request bindings | When |
|---|---|---|---|
| `ssr.stream_error` | error | `error` | React's streamed render threw after the shell was sent ([`entry.server.tsx`](../apps/dashboard/app/entry.server.tsx)); the response is already in flight, so the status flips to 500 only if the shell had not committed. |
| `import.uploaded` | info | `project_id`, `ingest_run_id`, `environment`, `bytes`, `profile` | A CSV/JSON export was stored in R2 and its `ingest_runs` row opened ([import step 1](../apps/dashboard/app/routes/app.projects.$slug.import._index.tsx), #38). |
| `import.confirmed` | info | `project_id`, `ingest_run_id`, `environment`, `total_rows`, `profile`, `fields[]` | The mapping was confirmed; the run was handed to `waitUntil`. `fields` lists the mapped target fields, never column values. |
| `import.started` | info | `ingest_run_id`, `project_id`, `environment`, `total_rows`, `resume_from` | `runImport` began (or resumed — `resume_from` is the row count already in the counts) ([`csv.server.ts`](../apps/dashboard/app/lib/csv.server.ts)). |
| `import.batch` | info | `ingest_run_id`, `rows`, `created`, `updated`, `skipped`, `failed` | One batch of up to 100 rows committed and enqueued. |
| `import.paused` | info | `ingest_run_id`, `processed`, `total_rows`, `indexing_deferred` | The run yielded at its time budget; the progress page offers "Resume". A run that logs this and never a later `import.started` was abandoned by the user. |
| `import.finished` | info | `ingest_run_id`, `created`, `updated`, `skipped`, `failed`, `indexing_deferred`, `duration_ms` | `ingest_runs.status = succeeded`. `indexing_deferred` counts index messages this call could not send (#159); the sweep indexes those reviews. |
| `import.failed` | warn / error | `ingest_run_id`, `error_message` (warn: a readable cause written to `ingest_runs.error`) or `error` (error: the background task threw) | The run was marked `failed`, or the `waitUntil` task died before it could. The second form is the one to alert on. |
| `uploads.deleted` | info | `project_id`, `count`, `site: dashboard.project_delete` | A deleted project's `uploads/<projectId>/` prefix was removed from R2 (#169), in `waitUntil` after the delete redirect ([`projects.server.ts`](../apps/dashboard/app/lib/projects.server.ts)). Follows `project.deleted`. |
| `uploads.delete_failed` | warn | `project_id`, `site: dashboard.project_delete`, `error` | That prefix delete failed. Nothing to do by hand: the bucket's 7-day lifecycle rule removes the objects. |
| `places.searched` | info | `project_id`, `q_length`, `results`, `cached` | A "Find your business on Google" search answered ([`app.projects.$slug.places.ts`](../apps/dashboard/app/routes/app.projects.$slug.places.ts), #47). `cached: false` is a billable Places call ([`docs/places.md`](places.md#cost-and-quota)); the query text is never logged. |
| `places.imported` | info | `ingest_run_id`, `project_id`, `environment`, `place_id`, `received`, `created`, `updated`, `skipped`, `failed`, `enqueued`, `indexing_deferred`, `cached`, `primary_type`, `category_set` | A place's reviews were written and the `places` run row closed `succeeded` ([`places.server.ts`](../apps/dashboard/app/lib/places.server.ts)). `skipped` counts rating-only reviews; `failed` counts reviews refused by the plan cap; `indexing_deferred: true` means the index messages could not be sent (#159) and the sweep indexes the reviews. `primary_type` is Google's type for the place (or `null`); `category_set: true` means it filled a null `projects.category` (#151). |
| `places.failed` | warn / error | warn: `project_id`, `op` (`search` \| `import`), `place_id`, `status`, `code`, `error_message` — Google refused (403: the key; 429: quota; 404: the place) and the card said so; error: `ingest_run_id`, `place_id`, `error` — the write after the run row was opened threw and the run is `failed` | The warn form is expected in small numbers; the error form is the one to alert on. |
| `onboarding.step` | info | `step` (`project` \| `reviews` \| `indexing` \| `snippet`), `elapsed_ms`, `account_id`, `project_id` (from step 2) | A guided-onboarding step was shown ([#53](../apps/dashboard/app/routes/app.onboarding.tsx)). `elapsed_ms` is measured from the first time step 1 was shown (the `startedAt` in the onboarding cookie; null when the cookie is gone). This is how the five-minute target (scope §1) is measured: the distribution of `elapsed_ms` on `step = snippet`. |
| `onboarding.completed` | info | `account_id`, `project_id`, `elapsed_ms` | "Finish" on step 4: `accounts.onboarding_completed_at` set. `elapsed_ms` here is the number to report against the five-minute target. |
| `onboarding.dismissed` | info | `account_id`, `elapsed_ms` | "I'll do this later" (or `?skip=1`): the flag is set without a project. A high dismiss rate on `elapsed_ms` near zero means step 1 asks too much. |
| `waitlist.joined` | info | `created` (false for a repeat address), `source` | A POST to `/sign-up` while public signup is closed stored (or re-saw) an address ([`waitlist.server.ts`](../apps/dashboard/app/lib/waitlist.server.ts), #51). The address is never logged. |
| `waitlist.throttled` | warn | `limit`, `period` | A client address exceeded its waitlist window (5 per hour per `cf-connecting-ip`, counted in KV); the request was answered 429. The address is not logged. |
| `waitlist.rejected` | warn | `reason` (`honeypot`) | The hidden form field was filled: a bot. Answered 200, nothing stored. |

| `google.connect.started` | info | `project_id`, `account_id` | The connect route minted PKCE + nonce and redirected to Google ([`app.projects.$slug.integrations.google.connect.ts`](../apps/dashboard/app/routes/app.projects.$slug.integrations.google.connect.ts), #45). |
| `google.connect.completed` | info | `project_id`, `connection_id`, `locations`, `verified`, `discovery_error?` | The callback stored encrypted credentials and ran discovery. `discovery_error` set means the connection exists but Google refused to list locations (the flash says so; Reconnect retries). |
| `google.connect.rejected` | info | `account_id`, `reason` (`state_expired` \| `state_bad_signature` \| `nonce_missing` \| `account_mismatch` \| `no_refresh_token` \| `exchange_failed` \| …), `detail?` | The callback refused the connect and wrote nothing. `nonce_missing` is a replayed or expired callback; `no_refresh_token` means Google withheld offline access. |
| `google.connect.denied` | info | `account_id`, `error` | Google returned `?error=` (the user cancelled) or no code. |
| `google.locations_saved` | info | `project_id`, `connection_id`, `enabled`, `location_ids[]`, `sync_enqueued`, `sync_deferred`, `category_set` | The location picker was saved; `sync_enqueued` says a `connection.sync` went on the queue. `sync_deferred` says the send was refused (#162; a `quota.exhausted` or `ingest.enqueue_deferred` with `site: dashboard.connection_sync` precedes it): `initial_sync_pending` stays set, so the next Google poll takes the connection first, and the flash says "Sync queued". `category_set: true` means an enabled location's primary category filled a null `projects.category` (#151). |
| `google.disconnected` | info | `project_id`, `connection_id` | Credentials cleared, `status = disconnected`. |

The import rows are the dashboard's first mutating surface; the loaders'
account and project queries remain plain reads. The onboarding (#53) also
emits `project.created` (with `onboarding: true`) and two `api_key.created`
lines from its step-1 action, the same events the project and Keys surfaces
log. No onboarding line carries a key: `plaintext` and `key` are redacted
fields, and the call sites log ids only.

### Every service: KV faults (#158)

Every KV call in every worker goes through the guards in
[`packages/core/src/kv-guard.ts`](../packages/core/src/kv-guard.ts). A
failure degrades the request (a cache miss, a live fetch, an in-memory
limiter, a swallowed write) and is logged at **warn** at most **once per
isolate per minute** per (event, op), because a spent daily quota fails
every call until 00:00 UTC.

| Event | Level | Fields | When |
|---|---|---|---|
| `kv.limit_exceeded` | warn | `op` (`get` \| `put` \| `delete` \| `list`), `site`, `suppressed`, `error` | The message is Cloudflare's daily-limit error (`KV get() limit exceeded for the day.` / `KV put() …`): the Workers Free plan's 100,000 reads or 1,000 writes are spent. `suppressed` counts the failures the throttle swallowed since the previous line. |
| `kv.read_failed` | warn | as above | Any other failed read. |
| `kv.write_failed` | warn | as above | Any other failed write. |

`site` names the call: `api.generation`, `api.generation_bump`,
`api.query_cache`, `pipeline.index`, `pipeline.generation_bump`,
`pipeline.google_poll`, `pipeline.places_refresh`, `pipeline.places_cache`,
`dashboard.generation_bump`, `dashboard.places_cache`,
`dashboard.waitlist_limiter`, `dashboard.oauth_nonce`. A `…generation_bump`
failure is the one that costs correctness: cached results stay stale until
their 24 h TTL (docs/performance.md §7).

### Every service: ingest queue faults (#159)

Every ingest path enqueues its index messages after the rows commit, through
`enqueueOrDefer` in
[`packages/core/src/queue-guard.ts`](../packages/core/src/queue-guard.ts).
A refused send never fails the write: the rows stay `indexed_at IS NULL`,
the pipeline's five-minute sweep re-enqueues them, and the api's
`POST /v1/reviews` answers 200 with `indexing: "deferred"`.

| Event | Level | Fields | When |
|---|---|---|---|
| `quota.exhausted` | error | `resource: "queues"`, `site`, `messages`, `retry_after`, `renews_at` (the next 00:00 UTC), `error` | The send failed with the Workers Free plan's daily Queues limit (`Queue sendBatch failed: Free tier limit exceeded`, Queues error 10253): the 10,000 operations are spent. Ingest keeps accepting reviews; indexing resumes after 00:00 UTC. One line per refused request; a CSV import stops sending after the first one, the sweep stops its tick, and the Google poll and Places refresh stop calling the queue for the rest of their tick (#162). |
| `ingest.enqueue_deferred` | warn | `site`, `messages`, `error` | Any other send failure. The sweep covers it within minutes. |

`site` is `api.ingest` (with `project_id` and `key_environment`),
`dashboard.csv_import` (with `ingest_run_id`), `dashboard.places_import`
(with the run's bindings), `dashboard.connection_sync` (the location
picker's `connection.sync`), `pipeline.sweep`, `pipeline.google_poll` (with
the connection, run and location bindings) or `pipeline.places_refresh`
(with the project, place and run bindings).

## Tuning the similarity floor

The floor (`projects.similarity_floor`, default `0.66` cosine) is the
product's most important quality knob: candidates below it are dropped and
the snippet renders nothing rather than nonsense (scope.md §1 "Empty beats
irrelevant"). `query.completed` logs the floor that was applied and what
came of it, so the knob is tuned from data instead of vibes.

For one project, over a window of real traffic (filter `event =
query.completed`, `project_id = …`, `has_q = true`, `cached != HIT` — hits
repeat the miss's result and would double-count):

1. **Empty rate**: the share of lines with `returned = 0`. A high empty
   rate with the default floor on a project whose queries *should* match
   (page topics the business has reviews about) means the floor is too
   high for that corpus or that language; lower it 0.02 at a time and watch the rate.
   Multilingual corpora (bge-m3 across languages) typically sit lower than
   monolingual English.
2. **Saturation**: the share of lines with `returned = limit`. Near 100%
   with a low floor suggests the floor is not doing any work and
   irrelevant excerpts may be rendering; raise it until the empty rate
   starts to move, then back off one step.
3. **Compare floors**: a project that changed its floor shows two
   populations in `similarity_floor`; group by it and compare the two
   distributions of `returned` for the same `q_length` band. Policy changes
   bump the cache generation, so every line after the change is a real
   miss.
4. **Latency sanity**: `search_ms` should stay single-digit to low
   double-digit milliseconds for tenants under ~50k vectors (exact scan, no
   index — scope.md §2). A climbing `search_ms` for one `project_id` is the
   signal to add that tenant's partial HNSW index, not to touch the floor.

When a floor change is made for a project, record the before/after empty
rate in the issue that made it; defaults change in `docs/scope.md` only
with that evidence attached. The default itself is re-measured with
`pnpm db:tune-floor` (labelled fixtures, real embeddings; method in the
docs site's [query#tuning-the-floor](../docs/site/src/content/docs/query.md)),
and every run is kept in `docs/floor-tuning/`.

## Where the logs go

[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
is enabled for both workers in their `wrangler.jsonc`:

```jsonc
"observability": {
  "enabled": true,
  "head_sampling_rate": 1 // keep every line at launch volumes
}
```

`observability` is an inheritable wrangler key, so the top-level block
covers `env.preview` and `env.prod` without repetition (unlike bindings,
which must be). Workers Logs ingests everything written to `console.*`,
parses JSON lines, and indexes their fields — which is why the logger emits
one object per line. Retention is 3 days (Free) / 7 days (Paid). Sampling
stays at `1` until volume forces a decision; any change belongs in this
file next to the reasoning.

### Querying

Cloudflare dashboard → **Workers & Pages → `proofql-api-prod` (or
`-preview`) → Logs**, and the same for `proofql-pipeline-*` (worker names:
[`infra/environments.md`](../infra/environments.md)):

- Filter by field: `event equals query.completed`, `project_id equals …`,
  `request_id equals …`, `level equals error`. Fields from JSON lines are
  auto-indexed.
- **Observability → Investigate** queries across workers on one screen:
  `review_id = "<id>"` shows a review's ingest in the api (`reviews.*`
  lines) and its indexing in the pipeline (`ingest.message.*`,
  `review.indexed`).

### `wrangler tail`

Live tail during an incident, from the worker's directory:

```sh
# every line from the prod api, as JSON, filtered locally
cd workers/api && pnpm wrangler tail --env prod --format json \
  | jq -c 'select(.logs[]?.message[0]? | fromjson? | .event == "query.completed")
           | .logs[].message[0] | fromjson
           | {ts, project_id, similarity_floor, returned, cached, took_ms}'

# one request end to end
pnpm wrangler tail --env prod --format json | grep '"request_id":"<id>"'

# the pipeline's failures only
cd workers/pipeline && pnpm wrangler tail --env prod --format json \
  | jq -c '.logs[].message[0] | fromjson? | select(.level == "error")'
```

`--format json` wraps each invocation's console output in `logs[].message`;
the inner string is our line, hence the `fromjson`. Locally, `pnpm dev`
prints the lines straight to the terminal (`environment: "local"`).

## Tests

- `packages/core/src/log.test.ts` pins the shape, key order, level
  inference, redaction (deep, including bindings), child merging, and
  `Error` flattening.
- `workers/api/src/query/route.integration.test.ts` ("logging") asserts a
  `query.completed` line with every documented field via an injected sink,
  `MISS` → `HIT`, `query.rejected` with the code, and
  `query.embedding_failed` — and that no line contains the query text or a
  key. `errors.test.ts` and `app.test.ts` cover `request.failed`,
  `*.rejected`, and that every line in a request carries its `request_id`.
- `workers/pipeline/src/handlers.test.ts` and
  `index-review.integration.test.ts` assert `review.indexed` carries the
  message's `message_id` / `attempt` as well as the review's ids.
- `workers/pipeline/src/google-poll.integration.test.ts` asserts the
  `google.*` lines above against the fake Google server — bindings, the
  tick summary, `needs_reauth`, `rate_limited`, `cap_reached` — and that no
  line contains a token.
- `workers/pipeline/src/dlq.test.ts` and `dlq.integration.test.ts` assert
  the `ingest.dlq.*` lines carry the same bindings, that `recorded` matches
  the `ingest_runs` row written, and that `failed` is emitted (and the
  message still acked) when the database refuses the row.

Tests inject `recordingSink()` from `@proofql/core` (`createApp({ logSink
})` in the api; `ctx.log` in the pipeline) and assert on parsed records, so
they exercise the real logger, redaction included.
