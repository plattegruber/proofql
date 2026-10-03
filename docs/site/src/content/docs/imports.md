---
title: Imports
description: Getting reviews in. The CSV upload and its supported exports, the push API's review shape and upsert rules, your public Google reviews through Places, and the Google connector.
---

Four ways in, one shape out. However a review arrives, it is normalized into the same record, split and embedded by the same pipeline, and queryable within seconds.

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
| `rating` | no | Integer 1 to 5, or `null` for sources without stars. Unrated reviews go through a sentiment classifier at ingest instead ([Relevance and the floor](/query#relevance)). |
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

## Upload an export

In the dashboard, the project's **Import** tab (`/app/projects/<slug>/import`) takes a CSV or JSON file of up to 10 MiB in four steps:

1. **Choose the file**, the environment (live or test), and the format. Leave the format on auto-detect unless you know the export; the choice only seeds the next step.
2. **Map columns.** The first rows are shown with the detected mapping of columns onto the fields above as selects you can correct, and any extra columns you want to keep as `metadata`. Validation runs on the sample as you change the mapping, so a wrong date column is caught before anything is written. A text column and a date column are required; everything else is optional.
3. **Run.** Rows are normalized, validated, and upserted in batches of 100 through the same path as the push API, then queued for indexing. A progress bar follows the counts; the import resumes from them if the page is closed.
4. **Result.** How many reviews were inserted, updated, and skipped, with a downloadable `errors.csv` naming each skipped row and why.

Formats detected from their headers:

| Profile | Recognized by | Default `source` |
|---|---|---|
| Google Takeout (`Reviews.json`) | `reviewer.displayName`, `starRating`, `comment`, `createTime` | `google` |
| Google Business Profile export | the Business Profile CSV columns | `google` |
| Yelp for Business | `Reviewer`, `Rating`, `Review`, `Review Date`, `Review URL` | `yelp` |
| Trustpilot | the Trustpilot review export columns | `trustpilot` |
| Birdeye | its multi-source export; the `Source` column maps onto `source` | per row |
| Podium | `Site`, `Customer Name`, `Stars`, `Comment`, `Date Posted` | `custom` |
| Generic CSV | any header row; columns are matched by name (`review`, `comment`, `stars`, `rating`, `author`, `date`, …) and then by what their values look like | `custom` |

Headers are matched case-insensitively with punctuation and whitespace collapsed, so `Review_Date`, `review date` and `Review Date` are the same column. JSON uploads are flattened to the same table: an array of objects, or an object with one array-valued key (`{ "reviews": [...] }`, which is what Takeout writes); nested objects become dotted headers.

What the normalizer accepts:

- **Ratings**: `1`–`5`, `4/5`, `★★★★☆`, `4 stars`. An empty cell means unrated; those reviews go through the sentiment classifier.
- **Dates**: ISO 8601, `m/d/yyyy`, `Jan 5, 2026`, or a Unix timestamp. A row with no readable date is skipped, named in the report.
- **`external_id`**: the vendor's review id when the export has one; otherwise a stable hash of source, author, date, and the start of the text, so re-importing the same export updates rather than duplicates.
- **The cap**: the plan's review limit is checked against the file before the run; the result page says how many rows would not fit, and updates to existing reviews never count against it.

## Find your business on Google

The fastest way to a first result. On onboarding step 2 and on the project's **Import** tab, **Find your business on Google** searches Google Places for the business by name; pick it from the matches and **Import reviews** pulls the reviews Google shares publicly for that place — at most **five**, the ones Google ranks most relevant — as `source: "google"` reviews with the place's id and name in `metadata` (`place_id`, `place_name`), so you can filter on them. The import takes a few seconds and lands on the same progress view as a file import; running it again later updates the same five rather than duplicating them.

Imported reviews keep their author name, photo, and link, and the snippet shows them with a "Google" badge linked back to the review — Google's terms require the attribution, and it is also what makes a review credible on your site. A review that is only a star rating has no text to search and is skipped; the result page counts it.

Five is Google's limit for this API, not ours. For all of a location's reviews, kept in sync, connect your Google Business Profile below once the connector lands; until then, a Takeout export through the upload above brings in everything you have today.

## Google Business Profile

Coming in M3. Connect a Google account with one OAuth consent, pick the locations, and ProofQL polls their reviews on a schedule, mapping each onto the shape above with `source: "google"` and the review's resource name as `external_id`. Polling runs inside Google's free quota, so it costs nothing on any plan.

The connector is gated on Google approving ProofQL's Business Profile API access ([#44](https://github.com/plattegruber/proofql/issues/44)); the connect flow is [#45](https://github.com/plattegruber/proofql/issues/45) and polling is [#46](https://github.com/plattegruber/proofql/issues/46). The lighter companion above, [#47](https://github.com/plattegruber/proofql/issues/47), already pulls a place's five public reviews through the Places API so a new project has something to query before the first import finishes.

Until then, a Google Takeout export through the CSV upload (or the push API) is the way to bring Google reviews in.
