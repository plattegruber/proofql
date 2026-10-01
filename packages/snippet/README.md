# @proofql/snippet

The embeddable snippet: one script tag and one `div` render relevant reviews on any website. A pure client of `GET /v1/query` (scope.md §3 "Snippet", epic #5) — vanilla TypeScript, zero runtime dependencies, one minified IIFE under 5 KB gzipped.

## Usage

```html
<div data-proofql data-query="dental implants" data-limit="3"></div>
<script async src="https://cdn.proofql.com/v1.js" data-key="pq_pk_live_…"></script>
```

That is the whole integration. The script reads its configuration from its own tag, finds every `[data-proofql]` element, asks the API, and renders what comes back. Anything the element already contains (a fallback, a placeholder) is replaced only when there is something to show.

### Script tag

| attribute  | required | default                   | meaning                                                          |
|------------|----------|---------------------------|------------------------------------------------------------------|
| `data-key` | yes      | —                         | A **publishable** key (`pq_pk_live_…` / `pq_pk_test_…`). Never a secret key: it ships in page source. |
| `data-api` | no       | `https://api.proofql.com` | API origin. For local development: `http://localhost:8797`.      |

The page's origin must be in the project's allowed origins, or the API answers 403 and nothing renders.

### Element attributes

| attribute          | default    | query parameter  | notes                                                    |
|--------------------|------------|------------------|----------------------------------------------------------|
| `data-proofql`     | —          | —                | Marks the element. Required.                             |
| `data-query`       | none       | `q`              | Search text. Without it: the newest publishable reviews. |
| `data-limit`       | `3`        | `limit`          | 1–20; out-of-range values are clamped.                   |
| `data-mode`        | `excerpts` | `mode`           | `excerpts` (the matching slice) or `reviews` (whole review). |
| `data-min-rating`  | none       | `min_rating`     | Integer 1–5. Tightens the project's policy, never loosens it. |
| `data-source`      | none       | `source`         | Comma-separated: `google,yelp`.                           |
| `data-since`       | none       | `since`          | ISO date (`2025-01-01`) or timestamp.                    |
| `data-meta-<key>`  | none       | `metadata.<key>` | One per attribute: `data-meta-location="north"`.         |

Nothing else is sent. The API rejects unknown parameters, and the snippet adds no cache-busters or telemetry, so identical elements share the edge cache.

### Rendered structure

```html
<ul class="pq-list" role="list">
  <li class="pq-item">
    <span class="pq-stars" role="img" aria-label="4 out of 5 stars">
      <span class="pq-stars-on" aria-hidden="true">★★★★</span><span class="pq-stars-off" aria-hidden="true">☆</span>
    </span>
    <blockquote class="pq-excerpt">…</blockquote>
    <footer class="pq-meta">
      <span class="pq-author">Maria G.</span>
      <a class="pq-source" href="…" rel="noopener" target="_blank">Google</a>
      <time class="pq-date" datetime="2026-01-15T10:30:00.000Z">Jan 15, 2026</time>
    </footer>
  </li>
</ul>
<a class="pq-badge" href="https://proofql.com/?ref=badge" rel="noopener" target="_blank">Reviews by ProofQL</a>
```

- Everything from the API is inserted as text, never parsed as HTML.
- Parts a review lacks are omitted: no stars without a rating, no author, date, or `.pq-meta` without data. `.pq-source` is a link only when the review has an `http(s)` URL, a `<span>` otherwise, and absent for `source: custom`.
- A native list with an explicit `role="list"` (Safari drops list semantics under `list-style: none`). The badge appears when the API says `badge: true` (free tier). It sits after the list, not inside it: a list may only own list items.
- `data-proofql-rendered` marks an element that has been (or is being) rendered; a rendering never runs twice for the same element.

### Failure policy

Empty `results`, a non-2xx response, a network error, malformed JSON — all render **nothing** and leave the element untouched. Each is one `console.debug` line prefixed `[proofql]`; never `warn` or `error`. Nothing in the snippet throws into the host page.

### Single-page apps

The snippet scans once the DOM is ready (`DOMContentLoaded`, or immediately when loaded after it). For content mounted later:

```js
window.ProofQL.render();          // re-scan the whole document
window.ProofQL.render(container); // or just one subtree
window.ProofQL.version;           // the bundle's version string
```

`render()` returns a promise that resolves when every element in scope has been fetched and rendered (or quietly skipped). It never rejects.

## Development

```sh
pnpm --filter @proofql/snippet build   # esbuild → dist/v1.js + dist/v1.js.map
pnpm --filter @proofql/snippet size    # rebuild and enforce the 5 KB gzipped budget
pnpm --filter @proofql/snippet test    # vitest (jsdom) + the size budget
```

`test` runs the size check, so CI's unit-test job fails when the bundle exceeds the budget (`scripts/size.mjs`). Tests mock `fetch` and need no services.
