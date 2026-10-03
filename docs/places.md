# Google Places bootstrap

- **Status:** Shipped with #47 (M3). Enabled per environment by the
  `GOOGLE_PLACES_API_KEY` secret ([`secrets.md`](secrets.md)).
- **Code:** `apps/dashboard/app/lib/places.ts` (shapes, mapper, keys),
  `places.server.ts` (client, cache, import),
  `components/import/places-finder.tsx` (the card),
  `routes/app.projects.$slug.places.ts` (the action),
  `test/fake-places.ts` (the fake Google). The client should move to
  `packages/google` once the connector work (#46) creates that package.

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

**Open point for the owner before launch:** the same policies limit how
long Places *content* (anything other than a place id) may be stored —
30 days as of this writing. The bootstrap stores the five reviews as the
project's own review rows indefinitely, as a Takeout export would, and the
24 h KV cache is well inside the limit. Whether a business importing its
own public reviews falls under that storage limit is a reading of the
terms we have not confirmed; either confirm it, or have the connector
(#45, whose Business Profile data has no such limit) replace the
bootstrap's rows and expire bootstrap-only rows after 30 days.

## Local development

There is no Places key locally and no need for one:

```sh
node apps/dashboard/test/fake-places-server.ts          # fake Google on :8803
```

and in `apps/dashboard/.dev.vars`:

```
GOOGLE_PLACES_API_KEY=fake
PLACES_API_BASE=http://localhost:8803
```

The fake (`apps/dashboard/test/fake-places.ts`) serves three fixture places
around Boulder — "Cedar Ridge Dental" (five reviews, one untranslated
Spanish), "Harbor Light Bakery" (two, one rating-only), "Quiet Corner
Books" (none) — and behaves like Google where it matters: the key header
is required, the field mask decides whether `reviews` is in the body, no
match answers `{}`, an unknown id is 404. Searching "dental", "bakery",
"books" or "boulder" finds them. The same handler runs in-process in the
unit and integration tests; **no test calls Google**.

Without `GOOGLE_PLACES_API_KEY`, the card renders "Not configured in this
environment" and the action answers 503; nothing else changes.

## Observability

`places.searched`, `places.imported`, `places.failed` on the dashboard —
see [`observability.md`](observability.md#dashboard). A `places.failed`
with `status: 403` is the key (missing, restricted to the wrong API, or
billing disabled on the Cloud project); `429` is Google's per-minute quota.
