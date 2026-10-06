# Google Places bootstrap

- **Status:** Shipped with #47 (M3); the 25-day refresh with #116. Enabled
  per environment by the `GOOGLE_PLACES_API_KEY` secret, on the dashboard
  (the card) and the pipeline (the refresh) ([`secrets.md`](secrets.md)).
- **Code:** `packages/google/src/places.ts` (shapes, mapper, keys, KV cache
  helpers, the client — shared by both workers) and
  `packages/google/src/fake/places.ts` (the fake Google);
  `apps/dashboard/app/lib/places.ts` (search validation, route path),
  `places.server.ts` (configuration, the import),
  `components/import/places-finder.tsx` (the card),
  `routes/app.projects.$slug.places.ts` (the action);
  `workers/pipeline/src/places-refresh.ts` (the refresh cron).

## What it is

Google's Places API (New) returns a place's **five most relevant public
reviews** to anyone with an ordinary API key — no Business Profile access,
no approval ([#44](https://github.com/plattegruber/proofql/issues/44) gates
the full connector). The dashboard uses it so a new project has something
to query in the first minute: onboarding step 2 (and the project's Import
tab) carries a **"Find your business on Google"** card — type the business
name, pick it from up to five matches, "Import reviews" — and the reviews
land as `source: "google"` rows through the same `upsertReviews` path as
`POST /v1/reviews` and the CSV import, with an `ingest_runs` row of kind
`places`, then flow through the pipeline like any other.

The limit is in the copy on the card: Google shares five; the connector
([#45](https://github.com/plattegruber/proofql/issues/45)) brings all of
them later. The two agree on identity — `external_id` is the review's
resource name (`places/<place>/reviews/<review>`), `source` is `google` —
so the connector updates the bootstrap's rows instead of duplicating them.

## The flow

```
card: q ──► POST /app/projects/:slug/places  intent=search
             └─ KV places:q:<sha256(normalized q)>  (24 h)  ──miss──► places:searchText
                                                                      X-Goog-FieldMask: places.id,places.displayName,
                                                                        places.formattedAddress,places.rating,places.userRatingCount
card: pick ─► POST ... intent=import place_id=<id> [environment] [onboarding=1]
             └─ KV places:p:<id>  (24 h)  ──miss──► GET /v1/places/<id>
                                                    X-Goog-FieldMask: id,displayName,formattedAddress,rating,userRatingCount,reviews
             └─ mapPlaceReviews → reviewInputSchema → upsertReviews(onLimit: "truncate")
             └─ ingest_runs { kind: places, artifact_key: "places:<id>", received, created, updated, skipped, failed }
             └─ INGEST_QUEUE ← one message per inserted / re-indexed review
             └─ 302 → onboarding step 3 ?run=<id>   or   /app/projects/:slug/import/<run id>
```

Mapping (`mapPlaceReview`):

| Places review | Review |
| --- | --- |
| `name` | `external_id` |
| — | `source: "google"` |
| `rating` | `rating` (null when absent) |
| `text.text`, else `originalText.text` | `text`; a rating-only review is **skipped** and counted on the run |
| `text.languageCode` / `originalText.languageCode` | `language` |
| `authorAttribution.displayName` | `author_name` ("A Google user" when absent) |
| `authorAttribution.photoUri` | `author_avatar_url` |
| `googleMapsUri`, else `authorAttribution.uri` | `url` |
| `publishTime` | `occurred_at` |
| the place | `metadata.place_id`, `metadata.place_name` |

No schema change: the place a project was seeded from is readable from its
`places` runs (`artifact_key = places:<id>`) and from `metadata.place_id` on
the reviews, filterable at query time (`filters.metadata.place_id`).

## Refresh

Google's Places policies cap how long Places *content* may be stored at 30
days ([Terms and attribution](#terms-and-attribution)); the owner's reading
(2026-10-03) is that this is a **cache limit, so the rows are refetched,
never deleted**. The pipeline does the refetching
(`workers/pipeline/src/places-refresh.ts`, on the pipeline cron's
03:30 UTC tick — daily, when nobody is onboarding; a skipped tick is caught up
the next day, since candidates are age-based):

```
every (project, environment, place) whose latest `places` run
  finished more than 25 days ago                 (a failed one: more than a day ago)
  and whose project has no `active` google connection
  and that still has at least one bootstrap row for the place
oldest first, 200 per tick
  └─ GET /v1/places/<id>  (past the KV cache; the fresh copy is written back)
  └─ mapPlaceReviews → upsertReviews(onLimit: "truncate")     same rows, by (source, external_id)
  └─ DELETE bootstrap rows for the place whose external_id Google did not return
  └─ ingest_runs { kind: places, artifact_key: "places:<id>", received, created, updated, skipped, failed,
                   error: "N reviews Google no longer returns were removed." when N > 0 }
  └─ INGEST_QUEUE ← one message per created or re-indexed review
  └─ gen:<project> += 1 when anything changed
```

What changes on the customer's site: a review Google still returns keeps
its row (and its id, so a link to it still works) with any edits Google
made to the text, rating or author re-applied; a review that dropped out
of Google's five is removed, so it stops appearing in query results as
soon as the cache generation moves (within a minute); a review that
entered the five appears once it is indexed, like any other new review.
Between refreshes the site shows the rows as of the last fetch — at most
25 days old, inside the 30-day limit. A project that connects its
Business Profile leaves this loop at once (the connector's first sync
replaces the bootstrap rows, [`google.md`](google.md#superseding-the-places-bootstrap-116));
one with a `needs_reauth` connection stays in it, since the bootstrap is
all it has until the user reconnects. A project that deleted every
bootstrap review for the place has opted out and is left alone — a
re-import from the Import tab starts the cycle again. A refresh never
*starts* a bootstrap: nothing is written for a place Google now returns
no reviews for except the removal of the rows it used to.

Failure shape: a Google error fails that project's run only (`error` is
the same human description the card shows: "Google no longer lists this
place." for a 404, the key message for a 403), and the place is retried
the next day rather than in 25; a 429 stops the whole tick (the key's
per-minute quota is shared) and whatever was not reached runs tomorrow.
Without `GOOGLE_PLACES_API_KEY` in the pipeline the cron logs
`places.refresh.skipped` and does nothing.

**Quota math.** One Place Details request per bootstrapped project per 25
days (five reviews a time, which is all Google shares): ~1.2 requests per
project per month, so **800 bootstrapped-and-not-connected projects fit in
the 1,000 free Place Details requests a month** on top of onboarding's
own fetches; at 5,000 such projects it is ~6,000 requests ≈ $125/month at
the Enterprise + Atmosphere list price, by which point the connector
should be carrying the load. The refresh bypasses the 24 h KV cache on
purpose and writes the fresh copy back, so a dashboard re-import the same
day costs nothing extra.

Locally: `wrangler dev --test-scheduled` in `workers/pipeline`, then
`curl "http://localhost:8798/cdn-cgi/local/scheduled?time=<epoch ms of a 03:30 UTC>"` against the fake
Places API ([Local development](#local-development)); events in
[`observability.md`](observability.md#pipeline).

## Cost and quota

Places bills **per request, by the SKU the field mask lands in** (Google's
[pricing](https://developers.google.com/maps/billing-and-pricing/pricing#places)
and [usage and billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing)
pages; numbers below are the March 2025 list and should be re-checked
before launch):

| Call | Fields | SKU | Free per month | Then, per 1,000 |
| --- | --- | --- | --- | --- |
| `places:searchText` | `id, displayName, formattedAddress, rating, userRatingCount` | Text Search **Enterprise** (`rating` and `userRatingCount` lift it from Pro) | 1,000 | ~$35 |
| `GET /v1/places/{id}` | `… , reviews` | Place Details **Enterprise + Atmosphere** (`reviews`) | 1,000 | ~$25 |

Per onboarding: typically **one or two searches and one place fetch**, so
about 1.5 search calls and 1 fetch. Both are cached in the `CACHE` KV
namespace for **24 hours** — searches under `places:q:<sha256 of the
lower-cased, whitespace-collapsed query>`, places under `places:p:<id>` —
so a user retyping the same name, a "try again" after a timeout, or two
staff of one business cost one call, and a re-import of a place within a
day costs nothing. Caching also means a review Google changed within the
day is not re-fetched; a re-import tomorrow picks it up.

Quota math at the free allowances: **~650 bootstraps a month cost $0**
(1,000 free searches ÷ 1.5). At 1,000 bootstraps a month: ~1,500 searches
(500 billable ≈ $17.50) and 1,000 fetches (free) ≈ **$18/month**; at
5,000: ~7,500 searches and 5,000 fetches ≈ $230 + $100 ≈ **$330/month**,
which is the point at which the connector should be carrying this load.
One lever if search cost matters first: dropping `rating` and
`userRatingCount` from the search mask moves it to the **Pro** SKU (5,000
free, ~$32 after) at the cost of showing the matches without their stars.

The key should be **restricted to the Places API (New)** in the Cloud
console (and, since it is used server-side from Workers, not referrer-
restricted). Cloud console → APIs & Services → Credentials → the key →
Set an application restriction of None and an API restriction of "Places
API (New)". Set a **budget alert** on the project (Billing → Budgets) at a
few dollars; there is no other guard rail on a leaked key.

## Terms and attribution

Google's [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies)
require that reviews are shown **with their author attribution** (name,
photo, and a link) and that Google is credited as the source. The
normalized review carries all three (`author_name`, `author_avatar_url`,
`url`) and `source: "google"`; the snippet renders the author and a
"Google" source badge linked to `url`, which is what a customer's site
shows. The card says so ("Imported reviews keep their author and the
Google badge, as Google's terms require"), and the docs site's Imports page
repeats it.

The same policies limit how long Places *content* (anything other than a
place id) may be stored — 30 days as of this writing. The owner's
direction (#116, 2026-10-03) is that this is a cache limit: bootstrap rows
are **refetched every 25 days** ([Refresh](#refresh)) rather than expired,
and the Business Profile connector (#45, whose data carries no such limit)
replaces them on its first sync ([`google.md`](google.md#superseding-the-places-bootstrap-116)).
The 24 h KV cache is well inside the limit on its own.

## Local development

There is no Places key locally and no need for one:

```sh
pnpm build                                              # once: dist/ of @proofql/google
node apps/dashboard/test/fake-places-server.ts          # fake Google on :8803
```

and in `apps/dashboard/.dev.vars` and `workers/pipeline/.dev.vars` (the
pipeline's `.dev.vars.example` already carries both lines):

```
GOOGLE_PLACES_API_KEY=fake
PLACES_API_BASE=http://localhost:8803
```

The fake (`packages/google/src/fake/places.ts`, exported from
`@proofql/google/fake`) serves three fixture places around Boulder — "Cedar
Ridge Dental" (five reviews, one untranslated Spanish), "Harbor Light
Bakery" (two, one rating-only), "Quiet Corner Books" (none) — and behaves
like Google where it matters: the key header is required, the field mask
decides whether `reviews` is in the body, no match answers `{}`, an unknown
id is 404. Searching "dental", "bakery", "books" or "boulder" finds them.
The same handler runs in-process in the unit and integration tests of
`packages/google`, the dashboard and the pipeline; **no test calls Google**.

Without `GOOGLE_PLACES_API_KEY`, the card renders "Not configured in this
environment" and the action answers 503, and the pipeline's refresh cron
logs `places.refresh.skipped`; nothing else changes.

## Observability

`places.searched`, `places.imported`, `places.failed` on the dashboard —
see [`observability.md`](observability.md#dashboard) — and
`places.refresh.*` on the pipeline ([`observability.md`](observability.md#pipeline)).
A `places.failed` or `places.refresh.failed` with `status: 403` is the key
(missing, restricted to the wrong API, or billing disabled on the Cloud
project); `429` is Google's per-minute quota.
