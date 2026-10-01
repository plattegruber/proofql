---
title: Errors
description: Every error code the API returns, what it means, and the one-line fix. Each error's doc_url points at an anchor on this page.
---

Every non-2xx response from the API is one envelope:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "filters.since: Invalid date",
    "doc_url": "https://docs.proofql.com/errors#validation_failed",
    "request_id": "1b7c3d9e-2f4a-4b6c-8d0e-1f2a3b4c5d6e",
    "details": [{ "path": "filters.since", "message": "Invalid date" }]
  }
}
```

`code` is a short, stable string to switch on. `message` is for a human and may change between releases. `doc_url` is the anchor on this page. `request_id` is the same value as the `x-request-id` response header; quote it when asking for help. `details` is present for `validation_failed` only and names the field. Unknown fields anywhere, in a body or a query string, are a `422 validation_failed`, never silently ignored. A route that does not exist is a `404 not_found` in the same envelope.

## unauthorized

**401.** No `Authorization` header (and no `?key=` where that is allowed), a header that is not `Bearer <key>`, a key that does not look like `pq_(sk|pk)_(live|test)_…`, a secret key in the URL, a `?key=` on `POST /v1/query`, or a key that is unknown or revoked.

**Fix:** send `Authorization: Bearer <key>` with a key from the project's keys page. From a browser `GET /v1/query`, a publishable key may be `?key=pq_pk_…` instead; a secret key never goes in a URL. Rate-limit headers are absent on this response because no key was resolved.

## forbidden

**403.** Either a publishable key on a route that needs a secret key (anything under `/v1/reviews`), or a publishable key on `/v1/query` from a page whose `Origin` is not in the project's allowed origins, including no `Origin` at all.

**Fix:** use the secret key from your server for ingest and management. For the snippet, add the page's origin to the project's allowed origins exactly as the browser sends it: scheme, host, and port, no path, no wildcard.

## not_found

**404.** No review with that id in the key's project and environment, a path parameter that is not a UUID, or a route that does not exist.

**Fix:** check the id and the key: a review in another project, or created with a test key and requested with a live one, is a `404` indistinguishable from one that never existed.

## payload_too_large

**413.** A `POST /v1/reviews` body over 1 MiB, or a `PATCH /v1/reviews/{id}` body over 64 KiB.

**Fix:** send fewer reviews per batch (the limit is 100 per request, and 100 maximal reviews fit comfortably under 1 MiB) or shorten the text.

## validation_failed

**422.** The body or query string did not match the shape: a missing required field, a wrong type, an out-of-range value (`limit` over 20, `rating` over 5), a date that is not ISO 8601, invalid JSON, a parameter sent twice, or a field the API does not know.

**Fix:** read `details[].path`: it is the dotted path to the offending field (`0.rating` for the first review in a batch, `filters.since` for a query). The request and response shapes are in the [API reference](/api).

## review_limit_reached

**422.** The batch would push the project past its plan's review cap (free: 5,000 per project). The cap is checked before anything is written, so nothing from the batch was stored.

**Fix:** delete reviews you no longer need (`DELETE /v1/reviews/{id}`) or move to a paid plan. The numbers are on [Limits](/limits).

## rate_limited

**429.** Too many requests on this key: 300 per minute for a secret key, 120 per minute for a publishable key. `Retry-After` says how long to wait; every authenticated response advertises the limit in `RateLimit-Policy` and `RateLimit-Limit`.

**Fix:** wait for `Retry-After` seconds and retry. For ingest, batch up to 100 reviews per request instead of one per request. For the snippet, identical elements already share the edge cache; if a single page fires many distinct queries, reduce them.

## query_quota_exceeded

**429.** The project has used its monthly quota of **uncached** queries (free: 50,000 per calendar month, UTC), and this request was a cache miss. Cached answers keep being served at quota, and they are free. `Retry-After` is the number of seconds until the next month.

**Fix:** wait for the month to roll over, or move to a paid plan. To tell this from `rate_limited`, switch on `code`: both are `429`.

## embedding_unavailable

**503.** `/v1/query` could not embed `q` because the embedding service was unavailable. Deliberately not a degraded keyword-only answer, which is the irrelevant result the relevance floor exists to prevent ([Relevance and the floor](/query#relevance)).

**Fix:** retry shortly, with backoff. The snippet renders nothing and tries again on the next page load. Queries without `q` are unaffected.

## internal

**500.** Something failed inside the API. The envelope carries the `request_id` and nothing about the cause.

**Fix:** retry once; if it persists, report the `request_id` (it is also in the `x-request-id` header). Nothing about your request shape causes this.
