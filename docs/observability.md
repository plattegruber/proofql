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
| `workers/pipeline` cron | `trigger: "cron"` | `handleScheduled`. |
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
| `query.completed` | info | `project_id`, `key_environment`, `key_kind`, `mode`, `has_q`, `q_length`, `limit`, `min_rating`, `similarity_floor`, `returned`, `cached`, `took_ms`, `embedding_ms`, `search_ms` | Exactly once per answered `/v1/query`, hit or miss. See [Tuning the floor](#tuning-the-similarity-floor). |
| `query.rejected` | warn (error for 5xx) | `code`, `status`, and `project_id`, `key_environment`, `key_kind` when auth had run | Any `ApiError` on `/v1/query`: 401/403 auth and CORS, 422 validation, 429 rate limit or quota, 503 `embedding_unavailable`. |
| `query.embedding_failed` | error | `project_id`, `key_environment`, `key_kind`, `q_length`, `embedding_ms`, `error` | Workers AI failed or is unbound; the response is 503 and there is deliberately no full-text fallback. Followed by a `query.rejected` with `code: embedding_unavailable`. |
| `query.cache_error` | warn | `project_id`, `key_environment`, `op` (`get` \| `put`), `error` | A KV read or write threw. The request is served as a miss; the cache can slow the endpoint down, never take it down. |
| `reviews.rejected` | warn | as `query.rejected` | Any `ApiError` on `/v1/reviews*`. |
| `request.rejected` | warn | as `query.rejected` | Any other refused request, including unknown routes (404). |
| `request.failed` | error | `error`, `stack` (first 2,000 chars) | An unhandled exception became a 500 `internal`. The only line that carries a stack, and the only place the cause is recorded; the client sees the request id and nothing else. |
| `ratelimit.rejected` | warn | `project_id`, `key_environment`, `key_kind`, `api_key_id`, `limit`, `period`, `retry_after` | A key hit its per-kind limit ([`rate-limit.ts`](../workers/api/src/rate-limit.ts)). Also produces a `*.rejected` with `code: rate_limited`; this line has the limiter's numbers. |
| `quota.rejected` | warn | `project_id`, `key_environment`, `key_kind`, `plan`, `limit`, `uncached`, `queries`, `cache_hits`, `retry_after` | The project is at its plan's monthly uncached-query quota ([`quota.ts`](../workers/api/src/quota.ts)); only a cache miss can trigger it. |

`query.completed` field notes:

- `cached` is `HIT`, `MISS`, or `BYPASS` (the caller sent `Cache-Control:
  no-cache`; the fresh answer was still stored) — the same value as the
  `x-cache` response header. On a `HIT`, `embedding_ms` and `search_ms`
  are `0` and `took_ms` is the KV round-trip.
- `has_q` / `q_length`: whether a query was sent and how long it was, in
  UTF-16 code units. Without `q` the endpoint returns the newest publishable
  reviews and `similarity_floor` played no part.
- `min_rating` is the **effective** floor: `max(project.min_rating,
  filters.min_rating)`.
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
| `review.indexed` | info | `chunks`, `windows`, `embedded`, `embedding_ms`, `newly_indexed`, `sentiment`, `sentiment_source` | The one line per indexed review, from `indexReview`. `newly_indexed` is whether this run flipped `indexed_at` (and therefore bumped the project's cache generation). |
| `review.skipped` | info | `reason` (`not_found` \| `hidden` \| `empty_text`) | A property of the review that redelivery cannot change. Acked. |
| `sweep.completed` | info | `older_than_minutes`, `limit`, `enqueued`, `exhausted`, `batches`, `review_ids[]` | Every cron tick ([`sweep.ts`](../workers/pipeline/src/sweep.ts)). |
| `sweep.exhausted` | warn | `max_attempts`, `count`, `review_ids[]` | Reviews stuck past the attempt cap, listed once per tick and not re-sent. A non-empty one is a review the pipeline cannot index: look at its last `ingest.message.failed`, or its `ingest.dlq.recorded` (a dead letter sets the counter to the cap directly). |

### dashboard

| Event | Level | Fields beyond the request bindings | When |
|---|---|---|---|
| `ssr.stream_error` | error | `error` | React's streamed render threw after the shell was sent ([`entry.server.tsx`](../apps/dashboard/app/entry.server.tsx)); the response is already in flight, so the status flips to 500 only if the shell had not committed. |

The dashboard logs nothing else yet (#36 is the scaffold); the loaders'
account and project queries are plain reads. Surfaces that mutate state
(#37, #41) add their events here when they land.

## Tuning the similarity floor

The floor (`projects.similarity_floor`, default `0.55` cosine) is the
product's most important quality knob: candidates below it are dropped and
the snippet renders nothing rather than nonsense (scope.md §1 "Empty beats
irrelevant"). `query.completed` logs the floor that was applied and what
came of it, so the knob is tuned from data instead of vibes.

For one project, over a window of real traffic (filter `event =
query.completed`, `project_id = …`, `has_q = true`, `cached != HIT` — hits
repeat the miss's result and would double-count):

1. **Empty rate**: the share of lines with `returned = 0`. A high empty
   rate with a floor of 0.55 on a project whose queries *should* match
   (page topics the business has reviews about) means the floor is too
   high for that corpus or that language; try 0.50 and watch the rate.
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
with that evidence attached.

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
- `workers/pipeline/src/dlq.test.ts` and `dlq.integration.test.ts` assert
  the `ingest.dlq.*` lines carry the same bindings, that `recorded` matches
  the `ingest_runs` row written, and that `failed` is emitted (and the
  message still acked) when the database refuses the row.

Tests inject `recordingSink()` from `@proofql/core` (`createApp({ logSink
})` in the api; `ctx.log` in the pipeline) and assert on parsed records, so
they exercise the real logger, redaction included.
