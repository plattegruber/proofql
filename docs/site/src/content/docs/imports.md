---
title: Imports
description: Getting reviews in. The CSV upload and its supported exports, the push API's review shape and upsert rules, and the Google connector.
---

Three ways in, one shape out. However a review arrives, it is normalized into the same record, split and embedded by the same pipeline, and queryable within seconds.

## The review shape

This is what `POST /v1/reviews` accepts and what a CSV import maps its columns onto.

```json
{
  "external_id": "accounts/1/locations/2/reviews/abc",
  "source": "google",
  "rating": 5,
  "text": "Dr. Patel did my implant and I honestly forgot it wasn't my own tooth within a week.",
  "author_name": "Marcus T.",
  "author_avatar_url": null,
  "occurred_at": "2026-03-14T18:20:00Z",
  "url": "https://maps.google.com/?cid=123",
  "language": "en",
  "metadata": { "location": "north" }
}
```

| field | required | notes |
|---|---|---|
| `external_id` | yes | The review's id at its source, up to 512 characters. Together with `source` it is the upsert key: sending the same pair again updates, never duplicates. |
| `source` | yes | One of `google`, `yelp`, `facebook`, `trustpilot`, `custom`. `custom` is the escape hatch for anything else; the snippet shows no platform name for it. |
| `rating` | no | Integer 1 to 5, or `null` for sources without stars. Unrated reviews go through a sentiment classifier at ingest instead ([Relevance and the floor](/relevance)). |
| `text` | yes | The review, up to 20,000 characters. Trimmed; must be non-empty. Excerpts are verbatim slices of this. |
| `author_name` | yes | Up to 256 characters. |
| `author_avatar_url` | no | A URL or `null`. |
| `occurred_at` | yes | ISO 8601 with a `Z` or a numeric offset. A bare date is not enough to order reviews reliably. |
| `url` | no | A link back to the review at its source, or `null`. The snippet links the platform name to it. |
| `language` | no | A BCP 47 tag (`en`, `es-MX`). |
| `metadata` | no | A flat string-to-string map (up to 32 entries) you can filter on at query time: `filters.metadata.location`, or `data-meta-location` on the snippet. Use it for locations, practitioners, product lines. |

Unknown fields are a `422 validation_failed` naming the field, never ignored.

## The push API

From your server, with the project's **secret** key, one review or an array of 1 to 100 per request, at most 1 MiB:

```sh
curl https://api.proofql.com/v1/reviews \
  -H "Authorization: Bearer pq_sk_live_…" \
  -H "Content-Type: application/json" \
  -d @reviews.json
```

The response is `200` with a receipt in request order:

```json
{ "reviews": [{ "id": "2f1c9e5a-…", "external_id": "r-1001", "source": "custom", "status": "indexing" }] }
```

Upsert rules, keyed on `(project, environment, source, external_id)` where project and environment come from the key:

- New review: inserted with `status: "indexing"` and queued; `indexed` within seconds.
- Existing review, `text` changed (or `rating` removed): updated and re-indexed.
- Existing review, `text` unchanged: the other fields are updated; `status` is unchanged.
- The same `(source, external_id)` twice in one batch collapses to the last occurrence.

The plan's review cap is checked before anything is written, so a batch lands whole or not at all ([`422 review_limit_reached`](/errors#review_limit_reached)). Use the **test** key while you build the integration: test rows live beside live rows and can be wiped without touching them.

Afterwards, [`GET /v1/reviews`](/api/operations/listreviews) pages through the project, [`PATCH /v1/reviews/{id}`](/api/operations/updatereview) hides or unhides a review or replaces its `metadata`, and [`DELETE /v1/reviews/{id}`](/api/operations/deletereview) removes it along with its excerpts. Hiding is the usual move for a review you do not want on the site: it stays in your account, disappears from every query, and comes back with one call.

## CSV upload

In the dashboard, under a project's reviews: upload a CSV, see the first rows, map columns onto the fields above, choose the `source`, choose live or test, run. A progress bar follows the import as reviews are indexed, and a report lists any rows that failed validation and why. The import feeds the same upsert path as the API, so re-uploading a refreshed export updates rather than duplicates.

Column mapping auto-detects the common exports:

| Export | What is detected |
|---|---|
| Google Takeout (Business Profile reviews) | reviewer name, star rating, comment, create time, review name as `external_id` |
| Yelp | business review exports |
| Trustpilot | review id, stars, title and text, consumer name, created date |
| Birdeye | aggregated multi-source exports, with the source column mapped onto `source` |
| Podium | review exports |
| Anything else | map the columns yourself; a header row is enough |

A `rating` column is optional. Rows without one go through the sentiment classifier. An `occurred_at` column is required; dates in common spreadsheet formats are accepted and normalized to ISO 8601.

:::caution[Coming soon]
CSV upload with column mapping is [#38](https://github.com/plattegruber/proofql/issues/38). The vendor profiles above are its scope. Until it lands, convert the export to the JSON shape above and use the push API; the `external_id` and `source` columns are what make a re-import safe.
:::

## Google Business Profile

Coming in M3. Connect a Google account with one OAuth consent, pick the locations, and ProofQL polls their reviews on a schedule, mapping each onto the shape above with `source: "google"` and the review's resource name as `external_id`. Polling runs inside Google's free quota, so it costs nothing on any plan.

The connector is gated on Google approving ProofQL's Business Profile API access ([#44](https://github.com/plattegruber/proofql/issues/44)); the connect flow is [#45](https://github.com/plattegruber/proofql/issues/45) and polling is [#46](https://github.com/plattegruber/proofql/issues/46). A lighter companion, [#47](https://github.com/plattegruber/proofql/issues/47), pulls a place's five public reviews through the Places API at sign-up so a new project has something to query before the first import finishes.

Until then, a Google Takeout export through the CSV upload (or the push API) is the way to bring Google reviews in.
