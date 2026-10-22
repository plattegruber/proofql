---
title: Snippet
description: One script tag and one div render relevant reviews on any site. Attributes, keys and origins, styling variables, your own markup, single-page apps, and what happens when something fails.
---

The snippet is a pure client of [`GET /v1/query`](/api/operations/queryreviewsget): vanilla JavaScript, no dependencies, one minified file under 5 KB gzipped, served from `https://cdn.proofql.dev/v1.js`. To see it on a page before touching your own, open the [hosted demo](https://cdn.proofql.dev/demo/): a small-business site with four sections asking four different questions of the same reviews, using the default stylesheet throughout.

```html
<div data-proofql data-query="dental implants" data-limit="3"></div>
<script async src="https://cdn.proofql.dev/v1.js" data-key="pq_pk_live_…"></script>
```

The script reads its configuration from its own tag, finds every `[data-proofql]` element, asks the API, and renders what comes back. Whatever the element already contains (a fallback, a placeholder) is replaced only when there is something to show.

## The script tag

| attribute  | required | default                   | meaning |
|------------|----------|---------------------------|---------|
| `data-key` | yes      | —                         | A **publishable** key (`pq_pk_live_…` or `pq_pk_test_…`). Never a secret key: it ships in page source. |
| `data-api` | no       | `https://api.proofql.dev` | API origin. For local development against the repo: `http://localhost:8797`. |

## Keys and allowed origins

A publishable key is public by design, so the page's origin is what scopes it. Every request the snippet makes carries the browser's `Origin`, and the API answers only when that origin is in the project's allowed origins, compared as a whole origin: scheme, host, and port, no wildcards. An unlisted origin is a `403 forbidden` and nothing renders.

The key rides in the URL (`?key=pq_pk_…`) rather than a header on purpose: a `GET` with no custom headers is a CORS *simple request*, so the browser sends it without a preflight, and the response is cacheable at the edge. This is the one place a key may appear in a URL: secret keys are never accepted there, and `POST /v1/query` refuses `?key=` outright.

## Element attributes

| attribute          | default    | query parameter  | notes |
|--------------------|------------|------------------|-------|
| `data-proofql`     | —          | —                | Marks the element. Required. |
| `data-query`       | none       | `q`              | Search text. Without it: the newest publishable reviews. |
| `data-limit`       | `3`        | `limit`          | 1 to 20; out-of-range values are clamped. |
| `data-mode`        | `excerpts` | `mode`           | `excerpts` (the matching slice) or `reviews` (the whole review). |
| `data-highlight`   | `false`    | `include=text`   | `"true"` renders the whole review with the matching sentence in `<mark class="pq-mark">`; see [Highlighting](#highlighting-the-match). |
| `data-fallback`    | none       | `fallback`       | `recent`: when nothing matches, the newest reviews render instead, labelled; see [Honest fallback](#honest-fallback). |
| `data-heading`     | none       | —                | Text for a `<p class="pq-heading">` above the list. |
| `data-fallback-heading` | none  | —                | Used instead of `data-heading` on a fallback response. |
| `data-min-rating`  | none       | `min_rating`     | Integer 1 to 5. Tightens the project's policy, never loosens it. |
| `data-source`      | none       | `source`         | Comma-separated: `google,yelp`. |
| `data-since`       | none       | `since`          | ISO date (`2025-01-01`) or timestamp. |
| `data-meta-<key>`  | none       | `metadata.<key>` | One per attribute: `data-meta-location="north"`. |
| `data-template`    | none       | —                | A selector for your own `<template>`; see below. |

Nothing else is sent. The API rejects unknown parameters, and the snippet adds no cache-busters or telemetry, so identical elements across your site share the edge cache.

## What renders

```html
<ul class="pq-list" role="list">
  <li class="pq-item">
    <span class="pq-stars" role="img" aria-label="4 out of 5 stars">
      <span class="pq-stars-on" aria-hidden="true">★★★★</span><span class="pq-stars-off" aria-hidden="true">☆</span>
    </span>
    <blockquote class="pq-excerpt">…</blockquote>
    <footer class="pq-meta">
      <span class="pq-author">Maria G.</span>
      <a class="pq-source" href="…" rel="noopener" target="_blank">Google review</a>
      <time class="pq-date" datetime="2026-01-15T10:30:00.000Z">Jan 15, 2026</time>
    </footer>
  </li>
</ul>
<a class="pq-badge" href="https://proofql.dev/?ref=badge" rel="noopener" target="_blank">Reviews by ProofQL</a>
```

- Everything from the API is inserted as text, never parsed as HTML.
- Parts a review lacks are omitted: no stars without a rating; no author, date, or `.pq-meta` without data. `.pq-source` reads "Google review" (or "Yelp review", …): a link only when the review has an `http(s)` URL, a `<span>` otherwise (a Google Takeout import has no link), and absent for `source: custom`. There is no reviewer photo in the default rendering. The stars lead the item and the attribution sits in the footer, so stars never appear beside Google's name, as Google's guidance for businesses asks.
- A native list with an explicit `role="list"` (Safari drops list semantics under `list-style: none`).
- The badge appears when the API says `badge: true` (free tier). It sits after the list, not inside it.
- `data-proofql-rendered` marks an element that has been (or is being) rendered; a rendering never runs twice for the same element.

## Honest fallback

```html
<div data-proofql data-query="roofing" data-fallback="recent"
     data-heading="What customers say about roofing"
     data-fallback-heading="What customers say about working with us"></div>
```

By default a query nothing matches renders nothing. With `data-fallback="recent"` the API answers with the newest publishable reviews instead and says so (`match: "fallback"`, [Honest fallback](/query#honest-fallback)); the snippet passes that on rather than hiding it. The host element gets `data-pq-match="fallback"` and the class `pq-fallback` so your CSS can restyle it (on every render it carries `data-pq-match` with the verdict: `query`, `fallback`, `none`, or `recent`), and the heading swaps from `data-heading` to `data-fallback-heading`. Both headings are optional: nothing renders for one that is absent, and the one given is used in both cases. A response is all matches or all fallback, never a mix.

## Highlighting the match

```html
<div data-proofql data-query="dental implants" data-highlight="true"></div>
```

Instead of the excerpt alone, the element shows the whole review, untouched, with the sentence that answered the query wrapped in `<mark class="pq-mark">`. The API supplies the span ([Highlighting](/query#highlighting) explains the offsets); the snippet splits the text into three DOM nodes around the mark, never parsing HTML, and checks the span against the excerpt first. A result with nothing to mark (no `data-query`, or a match on the review as a whole) renders the plain text. The tint is `--pq-mark`, by default the accent at 18% over the host's background, so the text inside keeps the host's contrast; forced-colors mode uses the system marker colours. In your own markup, `data-pq="text-highlighted"` gives the same three nodes.

## Styling

The bundle carries its own stylesheet, injected once as `<style data-proofql-styles>` the first time something renders, so a page where nothing matches keeps an untouched `<head>`. The default look is deliberately quiet: hairline-bordered items, square corners, stars in one accent, a small monospace metadata line. It inherits the host's font and text colour (so it reads on white and on dark pages), loads no web fonts, and animates nothing beyond a hairline colour change (off under `prefers-reduced-motion`).

Every selector is scoped under a `pq-` class. To restyle, set custom properties on the element or any ancestor; one rule is enough:

```css
[data-proofql] {
  --pq-accent: #c8102e;    /* stars, focus ring, badge marker   (default #00915a) */
  --pq-mark: #fff3bf;      /* data-highlight tint    (default the accent at 18%)   */
  --pq-radius: 8px;        /* item corners                      (default 0)       */
  --pq-gap: 16px;          /* space between items               (default 12px)    */
  --pq-font: inherit;      /* text                              (default inherit) */
  --pq-font-mono: ui-monospace, monospace; /* metadata line, badge                */
  --pq-color: inherit;     /* text colour                       (default inherit) */
  --pq-muted: #575f5b;     /* metadata, empty stars  (default currentColor at 72%) */
  --pq-border: #e3e6e4;    /* item rules             (default a 35% grey hairline) */
}
```

The defaults are `var(--pq-*, fallback)` in the stylesheet rather than values set on `.pq-list`, which is what lets a value set on any ancestor win. Or ignore the variables and write rules against the classes above; they are stable.

Accessibility of the default render: a native list, stars as a `role="img"` with an "n out of 5 stars" label and glyphs that differ by shape (`★`/`☆`) rather than colour alone, `<time datetime>`, a visible focus ring on every link, and text at or above 4.5:1 contrast on both a white and a dark host.

## Your own markup: `data-template`

For full control, point `data-template` at a `<template>`. Its content is cloned once per result, and every element with a `data-pq` marker is filled from that result:

```html
<template id="review">
  <figure class="review">
    <span data-pq="stars"></span>
    <blockquote data-pq="excerpt"></blockquote>
    <figcaption>
      <b data-pq="author"></b> on
      <a data-pq="url" href="https://proofql.dev/" target="_blank"><span data-pq="source">source</span></a>,
      <time data-pq="date"></time>
    </figcaption>
  </figure>
</template>

<div data-proofql data-query="dental implants" data-template="#review"></div>
```

| marker    | the element gets |
|-----------|------------------|
| `excerpt` | the excerpt (the whole review in `data-mode="reviews"`) |
| `text-highlighted` | the whole review with the matching sentence in `<mark class="pq-mark">`; needs the text (`data-highlight="true"` or `data-mode="reviews"`), else the excerpt |

Every top-level element of a clone also gets `data-pq-match` with the response's verdict, the host element gets the same attribute plus `pq-fallback` on a fallback, and the heading attributes work as in the default render.
| `author`  | the author's name |
| `source`  | the platform's display name (`Google`, `Yelp`, …); nothing for `custom` |
| `date`    | a short local date, plus `datetime` when the element is a `<time>` |
| `rating`  | the rating as text (`5`) |
| `stars`   | `★★★★☆`, plus `role="img"` and an "n out of 5 stars" label |
| `url`     | `href` on a link (`rel="noopener"` added; http(s) only); the URL as text elsewhere |

A marker the review cannot fill is removed from the clone (nest `source` inside `url` and both go together when there is no link). Values are always text content or validated attributes, never parsed HTML. The default stylesheet is not applied to your markup; the badge is still appended after the clones unless the project is paid. If the selector matches nothing or is not a `<template>`, the default render is used.

## Single-page apps

The snippet scans once the DOM is ready (`DOMContentLoaded`, or immediately when loaded after it). For content mounted later:

```js
window.ProofQL.render();          // re-scan the whole document
window.ProofQL.render(container); // or just one subtree
window.ProofQL.version;           // the bundle's version string
```

`render()` returns a promise that resolves when every element in scope has been fetched and rendered (or quietly skipped). It never rejects.

## When something fails

Empty `results`, a non-2xx response, a network error, malformed JSON: all render **nothing** and leave the element untouched, including whatever fallback it already held. Each is one `console.debug` line prefixed `[proofql]`, never `warn` or `error`. Nothing in the snippet throws into the host page.

This is deliberate. An empty block is better than an irrelevant review ([Relevance and the floor](/query#relevance)), and a broken key is better found in the console than announced to visitors. When a page you expected to show reviews is blank, open the console: the line carries the API's `code` and `message`, and [Errors](/errors) has the fix for each code.

## The hosted file

`https://cdn.proofql.dev/v1.js` is the stable alias the script tag uses; a new release rolls to it within five minutes. Beside it, `/v1.<hash>.js` is the same build content-addressed and cached for a year: pin it where you also control the page that would need updating, and quote it in a bug report. `GET https://cdn.proofql.dev/version.json` says which build is live (`{ version, hash, builtAt }`). Both files carry `Access-Control-Allow-Origin: *`, so fetch-based loaders and devtools work, and no request to the cdn ever sets a cookie.
