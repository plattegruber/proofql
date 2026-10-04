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
| `data-highlight`   | `false`    | `include=text`   | `"true"` renders the whole review with the matching sentence in `<mark class="pq-mark">` (below). In `excerpts` mode it asks the API for `review.text`. |
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

### Highlighting the match: `data-highlight`

```html
<div data-proofql data-query="dental implants" data-highlight="true"></div>
```

The API returns every review untouched plus a `highlight` span — the excerpt's `{ start, end }` offsets in `review.text` (UTF-16 code units, the unit `String.prototype.slice` uses, so emoji and CJK ahead of the span cannot shift it). With `data-highlight="true"` the `.pq-excerpt` holds the whole review as three nodes: the text before, `<mark class="pq-mark">` with the matching sentence, the text after — built with the DOM API, never `innerHTML`, and the span is checked against the excerpt before it is marked. When there is nothing to mark (no `data-query`, or the match is the review as a whole, `highlight: null`) the whole text renders plain. The mark is a translucent tint of the accent (`--pq-mark`, default `color-mix(in srgb, var(--pq-accent) 18%, transparent)` with an `rgba` fallback); the text inside keeps the host's ink, and forced-colors mode uses the system `Mark`/`MarkText` colours.

### Styling

The bundle carries its own stylesheet, injected once as `<style data-proofql-styles>` the first time something renders — so a page where nothing matches keeps an untouched `<head>`, and one tag is still the whole integration. The default look is deliberately quiet: hairline-bordered items, square corners, stars in one accent, a small monospace metadata line. It inherits the host's font and text colour (so it reads on white *and* dark pages), loads no web fonts, and animates nothing beyond a hairline colour change (off under `prefers-reduced-motion`).

Every selector is scoped under a `pq-` class. To restyle, set custom properties on the element or any ancestor — one rule is enough:

```css
[data-proofql] {
  --pq-accent: #c8102e;    /* stars, focus ring, badge marker   (default #00915a) */
  --pq-mark: #fff3bf;      /* data-highlight tint    (default the accent at 18%)   */
  --pq-radius: 8px;        /* item corners                      (default 0)       */
  --pq-gap: 16px;          /* space between items               (default 12px)    */
  --pq-font: inherit;      /* text                              (default inherit) */
  --pq-font-mono: ui-monospace, monospace; /* metadata line, badge             */
  --pq-color: inherit;     /* text colour                       (default inherit) */
  --pq-muted: #575f5b;     /* metadata, empty stars  (default currentColor at 72%) */
  --pq-border: #e3e6e4;    /* item rules             (default a 35% grey hairline) */
}
```

The defaults are `var(--pq-*, fallback)` in the stylesheet rather than values set on `.pq-list`, which is what lets a value set on any ancestor win. Or ignore the variables and write rules against the classes above; they are stable.

Accessibility of the default render: a native list, stars as a `role="img"` with an "n out of 5 stars" label and glyphs that differ by shape (`★`/`☆`) rather than colour alone, `<time datetime>`, a visible focus ring on every link, and body and metadata text at ≥ 4.5:1 on both a white and a dark host with the defaults (`src/styles.test.ts` checks the numbers; `src/axe.test.ts` runs axe-core over the rendered fixture).

### Your own markup: `data-template`

For full control, point `data-template` at a `<template>`. Its content is cloned once per result, and every element with a `data-pq` marker is filled from that result:

```html
<template id="review">
  <figure class="review">
    <span data-pq="stars"></span>
    <blockquote data-pq="excerpt"></blockquote>
    <figcaption>
      <b data-pq="author"></b> on
      <a data-pq="url" href="https://proofql.com/" target="_blank"><span data-pq="source">source</span></a>,
      <time data-pq="date"></time>
    </figcaption>
  </figure>
</template>

<div data-proofql data-query="dental implants" data-template="#review"></div>
```

| marker    | the element gets                                                      |
|-----------|-----------------------------------------------------------------------|
| `excerpt` | the excerpt (the whole review in `data-mode="reviews"`)               |
| `text-highlighted` | the whole review with the matching sentence in `<mark class="pq-mark">`; needs the text (`data-highlight="true"` or `data-mode="reviews"`), else the excerpt |
| `author`  | the author's name                                                     |
| `source`  | the platform's display name (`Google`, `Yelp`…); nothing for `custom` |
| `date`    | a short local date, plus `datetime` when the element is a `<time>`    |
| `rating`  | the rating as text (`5`)                                              |
| `stars`   | `★★★★☆`, plus `role="img"` and an "n out of 5 stars" label           |
| `url`     | `href` on a link (`rel="noopener"` added; http(s) only); the URL as text elsewhere |

A marker the review cannot fill is removed from the clone (nest `source` inside `url` and both go together when there is no link). Values are always text content or validated attributes — never parsed as HTML. The default stylesheet is not applied to your markup; the badge is still appended after the clones unless the project is paid. If the selector matches nothing or is not a `<template>`, the default render is used.

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
pnpm --filter @proofql/snippet test    # vitest (jsdom, axe-core) + the size budget
pnpm --filter @proofql/snippet demo    # build and serve demo/ on http://localhost:3000
```

`demo/index.html` is a static **styling test page** for this package (light and dark host, default render, filters, a template, a floor-dropped fallback), not the demo people are shown. It talks to the local API: run `pnpm run setup` (prints the seed's keys) and `pnpm --filter @proofql/api dev`, then paste the *live publishable* key into the demo's script tag in place of `pq_pk_test_REPLACE_ME`. Never commit a key.

The **hosted demo** — a fictional small-business site using the snippet the way a customer would — lives in [`workers/cdn`](../../workers/cdn/README.md) (`public/demo/`), next to the `/v1.js` it loads, and takes the key from its URL: `http://localhost:8800/demo/?key=pq_pk_live_…&api=http://localhost:8797` locally. The hosted URL is in the root README's "Demo" section once provisioned.

## Publishing

`workers/cdn` is how the bundle reaches `cdn.proofql.com`: its build runs `scripts/build.mjs` here, then serves `dist/v1.js` as `/v1.js` (5 minute cache) and as the content-addressed `/v1.<sha256-8>.js` (immutable, a year). Merge to `main` and the deploy workflow ships it; nothing is published from this package directly.

`test` runs the size check, so CI's unit-test job fails when the bundle exceeds the budget (`scripts/size.mjs`). Tests mock `fetch` and need no services.
