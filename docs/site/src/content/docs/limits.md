---
title: Limits
description: The free tier's numbers, the request limits every plan shares, and what happens at each one.
---

## Plans

The free tier is meant to be enough for a small business for good. Paid removes the badge and raises the numbers; billing is not open yet (M3).

| | Free | Paid |
|---|---|---|
| Projects | 1 | Many |
| Reviews per project | 5,000 | 100,000 |
| Queries | 50,000 uncached per month; cached hits are free | Metered |
| Sources | CSV, push API, Google | Same, plus priority polling |
| Snippet badge | "Reviews by ProofQL" under the list | Removable |
| Keys | Live and test | Same |

At the review cap a `POST /v1/reviews` is a [`422 review_limit_reached`](/errors#review_limit_reached) and nothing from that batch is written. At the query quota a cache miss on `/v1/query` is a [`429 query_quota_exceeded`](/errors#query_quota_exceeded) with `Retry-After` set to the seconds until the next UTC month, while cached answers keep being served. The month is a calendar month in UTC.

Queries are counted per project; a cache hit (`cached: true`, `x-cache: HIT`) is not counted. Identical requests from the snippet across your pages hit the same cache entry, so a site that asks the same handful of questions uses a small fraction of the quota however much traffic it gets.

## Rate limits

Counted per key, every authenticated request:

| Key kind | Limit | Over the limit |
|---|---|---|
| Secret (`pq_sk_…`) | 300 requests per 60 s | [`429 rate_limited`](/errors#rate_limited) with `Retry-After` |
| Publishable (`pq_pk_…`) | 120 requests per 60 s | same |

Every authenticated response carries `RateLimit-Policy` and `RateLimit-Limit` (IETF draft ratelimit headers).

## Request limits

These are not product limits; they exist so a single malformed or hostile request cannot push megabytes into the database. Real reviews are nowhere near them.

| | Limit | Over the limit |
|---|---|---|
| Reviews per `POST /v1/reviews` | 100 | [`422 validation_failed`](/errors#validation_failed) |
| `POST /v1/reviews` body | 1 MiB | [`413 payload_too_large`](/errors#payload_too_large) |
| `PATCH /v1/reviews/{id}` body | 64 KiB | `413 payload_too_large` |
| Review `text` | 20,000 characters | `422 validation_failed` |
| `external_id` | 512 characters | `422` |
| `author_name` | 256 characters | `422` |
| `metadata` | 32 entries; keys 64 characters, values 512 | `422` |
| `/v1/query` `q` | 500 characters | `422` |
| `/v1/query` `limit` | 1 to 20 (default 5) | `422`; the snippet clamps `data-limit` |
| `GET /v1/reviews` `limit` | 1 to 100 (default 20) | `422` |
| Allowed origins | exact scheme, host, and port; no wildcards | an unlisted origin is [`403 forbidden`](/errors#forbidden) |

## Response-time expectations

A query is one embedding call plus one SQL statement over the project's vectors (an exact scan, which for a tenant under ~50,000 vectors is single-digit milliseconds). `took_ms` in every response is the server's own measurement; cached answers return in the time of a KV read.
