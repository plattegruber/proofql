---
title: Getting started
description: From sign-up to reviews rendered on your own page in ten minutes, using the dashboard, one import, and the snippet.
---

By the end of this page a `<div>` on one of your pages shows the reviews that are relevant to that page. You need an account, a few reviews, and a page you can edit.

:::note[Where the dashboard is]
The hosted dashboard's domain is being set up alongside the API (`api.proofql.com`) and the snippet (`cdn.proofql.com`); the paths below are stable. Running the repo locally? `pnpm run setup && pnpm dev` serves the dashboard at `http://localhost:8799` and the API at `http://localhost:8797`, signed in as the seeded demo account (Cedar Ridge Dental, 80 reviews) with its live and test keys printed by `setup`.
:::

## 1. Sign up and create a workspace

Open the dashboard and go to `/sign-up`. Sign in with Google or an email address. You are then asked to create a **workspace** (`/app/workspace`): the workspace is your account, and it holds your projects, API keys, and reviews. Name it after your company; you can invite teammates later.

You land on `/app`, the overview: your plan and your projects.

## 2. Create a project

A project is one corpus of reviews with its own keys, its own allowed origins, and its own publication policy. Most businesses have exactly one; the free tier includes one.

Click **New project** on the overview (`/app/projects/new`), give it a name, and keep or edit the slug the form derives from it. The project opens on its reviews tab, `/app/projects/<slug>/reviews`, which is empty until the next step.

## 3. Import reviews

Two ways in today; the Google connector is third (see [Imports](/imports)).

**Upload an export.** Open the project's **Import** tab (`/app/projects/<slug>/import`) and choose a CSV or JSON file of up to 10 MiB: a Google Takeout `Reviews.json`, a Yelp, Trustpilot, Birdeye or Podium export, or your own spreadsheet with a header row. Pick live or test, leave the format on auto-detect, and continue. The next screen shows the first rows with the detected mapping of columns onto the review fields (text, rating, author, date, …) as selects you can correct, with validation running as you change them. Run the import: a progress bar follows the rows as they are stored and indexed, and the result lists any rows that were skipped with a downloadable error report. Re-uploading a refreshed export updates reviews rather than duplicating them.

**The push API.** From your server, with the project's **secret** key (`pq_sk_live_…`), send one review or a batch of up to 100:

```sh
curl https://api.proofql.com/v1/reviews \
  -H "Authorization: Bearer pq_sk_live_…" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "external_id": "r-1001",
      "source": "google",
      "rating": 5,
      "text": "Dr. Patel did my implant and I honestly forgot it was not my own tooth within a week.",
      "author_name": "Marcus T.",
      "occurred_at": "2026-03-14T18:20:00Z",
      "url": "https://maps.google.com/?cid=123"
    },
    {
      "external_id": "r-1002",
      "source": "google",
      "rating": 5,
      "text": "Painless cleaning, very gentle hygienist, and parking behind the building was easy.",
      "author_name": "Dana K.",
      "occurred_at": "2026-02-01T09:00:00Z"
    }
  ]'
```

The response is a receipt, in request order:

```json
{ "reviews": [
  { "id": "2f1c9e5a-…", "external_id": "r-1001", "source": "google", "status": "indexing" },
  { "id": "8a4d2b1c-…", "external_id": "r-1002", "source": "google", "status": "indexing" }
] }
```

`status` flips from `indexing` to `indexed` within seconds, once the pipeline has split and embedded the review. Sending the same `(source, external_id)` again updates the review rather than duplicating it, so re-running an import is safe. The full field list and the upsert rules are on [Imports](/imports); the request shape is in the [API reference](/api/operations/ingestreviews).

Either way, the **Reviews** tab now lists what came in, with filters, a detail view per review, and hide/unhide: a hidden review stays in your account and never appears in a query result.

## 4. Get a publishable key and allow your origin

The snippet runs in the browser, so it uses a **publishable** key (`pq_pk_live_…`), which can only query and only from a page whose origin you have listed.

Open the project's **Keys** tab (`/app/projects/<slug>/keys`). Mint a live publishable key: the plaintext is shown once, with a copy button, and never again (revoke and mint a new one if you lose it). On the same tab, add your site to **Allowed origins**, exactly as the browser sends it: scheme, host, and port, no path, no wildcard. `https://www.example.com` and `https://example.com` are two origins; add both if you serve both.

Use **test** keys (`pq_pk_test_…`, `pq_sk_test_…`) while you build: they hit the same project, but test data and live data never mix, and you can wipe test data without touching live.

## 5. Paste the snippet

On the page that should show reviews:

```html
<div data-proofql data-query="dental implants" data-limit="3"></div>
<script async src="https://cdn.proofql.com/v1.js" data-key="pq_pk_live_…"></script>
```

That is the whole integration ([the hosted demo](https://cdn.proofql.com/demo/) is exactly this, four times, on a fictional dental practice's site). `data-query` is the question the page asks of your reviews; put the page's topic in it. Without a `data-query`, the newest publishable reviews render. One script tag serves any number of `[data-proofql]` elements, each with its own query. The attribute table, styling variables, and the `data-template` escape hatch are on the [Snippet](/snippet) page.

If nothing shows up, that is the snippet doing its job: on an empty result, a refused key, or an unlisted origin it renders nothing and logs one `console.debug` line prefixed `[proofql]`. Open the console; the API's error message says what to fix, and the [Errors](/errors) page has a line for every code.

## 6. Check the results

Before you deploy the page, run the same query in the project's **Playground** (`/app/projects/<slug>/playground`): type the query, pick the mode and filters, and see exactly what `/v1/query` returns — and, greyed out under a line marking your relevance floor, the candidates it dropped. Every run is in the URL, so you can share one. **Copy as curl** gives you the request, and the ready-made snippet tag for that query is one click away.

The equivalent check from a terminal, with your page's origin:

```sh
curl "https://api.proofql.com/v1/query?key=pq_pk_live_…&q=dental+implants&limit=3" \
  -H "Origin: https://www.example.com"
```

Every result carries a `score` in `[0, 1]`: the cosine similarity between your query and the returned excerpt, already above the project's relevance floor (default `0.55`). If a page comes back empty but you know there are matching reviews, read [Relevance and the floor](/query#relevance) before lowering anything; the floor and the minimum rating live on the project's **Settings** tab (`/app/projects/<slug>/settings`), and a lower floor trades precision for recall.

:::caution[Coming soon]
Guided onboarding ([#53](https://github.com/plattegruber/proofql/issues/53)) collapses steps 2 to 5 into one screen after sign-up: pick an import, watch the progress bar, copy a snippet pre-filled with your key and, once 20 or more reviews are indexed, a suggested first query (below that the tag has no `data-query` and shows your newest reviews).
:::

## What you get on the free tier

One project, 5,000 reviews, 50,000 uncached queries a month, and a small "Reviews by ProofQL" badge under the list. Paid removes the badge and raises the limits. The numbers are on [Limits](/limits).
