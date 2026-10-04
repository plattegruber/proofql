# @proofql/cdn

The worker behind `cdn.proofql.com` (#34) and the hosted demo (#35). It serves two things from Workers static assets, with no database, queue, or KV:

| Path | What | `Cache-Control` |
|---|---|---|
| `/v1.js` | the latest snippet build — what the script tag loads | `public, max-age=300, stale-while-revalidate=86400` |
| `/v1.<hash>.js` | the same bytes, content-addressed (`sha256`, 8 hex) | `public, max-age=31536000, immutable` |
| `/v1.js.map`, `/v1.<hash>.js.map` | source maps | as their bundle |
| `/version.json` | `{ version, hash, builtAt }` of the deployed build | as `/v1.js` |
| `/health` | `{ ok: true, version, hash }`; 503 when `public/` was never built | `no-store` |
| `/demo/` | the hosted demo site (below) | as `/v1.js` |
| `/` | → `/demo/` | — |

Every response is `X-Content-Type-Options: nosniff`; the snippet files (and their maps) carry `Access-Control-Allow-Origin: *` so fetch-based loaders and devtools work. No cookies, ever. Errors are `no-store` so an edge never caches a 404 for the TTL. The header logic is `src/handler.ts`, unit-tested under Node with a fake assets binding — no workerd.

## Releases

A release is a merge to `main`: the deploy workflow builds this workspace (which runs the snippet's esbuild step) and `wrangler deploy`s it right after the api. Two URLs come out of every release:

- **`/v1.js`** is the stable, mutable alias **the snippet tag uses**. It rolls to the new build within five minutes everywhere (`max-age=300`); an edge keeps serving the previous build for up to a day while it revalidates, so a slow origin never blanks a customer's page.
- **`/v1.<hash>.js`** is the immutable, content-addressed copy — **the stable reference for docs, pinned integrations, and bug reports** ("which build was that?"). `GET /version.json` or `/health` tells you the current one.

Stale hashed copies are not kept: `public/` holds exactly one build and `wrangler deploy` uploads what is there, so an old hash stops resolving after the next release (browsers that cached it keep it for the year). Pin by hash only where you also control the page that would need updating.

## Layout

```
scripts/build.mjs      pnpm build: snippet esbuild → public/v1.js, v1.<hash>.js, maps, version.json
src/handler.ts         routing + headers (pure, tested in src/handler.test.ts)
src/worker.ts          wrangler entrypoint (fetch → handler with env.ASSETS)
src/build.test.ts      runs the build into a temp dir and checks the file set
public/demo/           the demo site — the only thing in public/ that is committed
public/                everything else is generated and gitignored
screenshots/           the demo page, desktop and mobile, for the PR
wrangler.jsonc         proofql-cdn-<env>; assets binding ASSETS, run_worker_first; port 8800
```

```sh
pnpm --filter @proofql/cdn build   # → public/ (runs packages/snippet's build first)
pnpm --filter @proofql/cdn dev     # build, then wrangler dev on http://localhost:8800
pnpm --filter @proofql/cdn test    # vitest: headers/caching + the build
pnpm --filter @proofql/cdn exec wrangler deploy --dry-run --env preview
```

`run_worker_first` sends every request through `src/worker.ts`, which fetches the file from the `ASSETS` binding and rewrites the headers; `html_handling: auto-trailing-slash` gives `/demo` → `/demo/` → `demo/index.html`, `not_found_handling: none` keeps unknown paths a plain 404.

## The demo site (`/demo/`)

A fictional small-business website — **Cedar Ridge Dental**, the practice in the seeded demo project — using the snippet exactly as a customer would: a nav, a hero, three sections each asking a different question (`implant surgery with Dr. Patel`, `first visit for my four-year-old with Dr. Okafor`, `free parking and Saturday hours at the north office`), one `data-mode="reviews"` section on a dark band, and a footer. The implants section uses `data-highlight="true"` (#85), so each card is the whole review with the matching sentence marked. The snippet's **default** stylesheet is used throughout; the dark band shows it inheriting the host's colour with no configuration. The page is deliberately not in the dashboard's design language: it is the customer's site, in system fonts.

**No key is committed.** The page reads the publishable key from its own URL and builds the script tag from it:

```
/demo/?key=pq_pk_live_…                               hosted (API default https://api.proofql.com)
/demo/?key=pq_pk_live_…&api=http://localhost:8797     local api
```

Without `?key=` the page still renders as a site, with a one-line notice at the top and the static fallback text in each review slot (the snippet renders nothing on an error or an empty result and leaves the element untouched).

### Local recipe

```sh
pnpm run setup                                 # Postgres, migrations, seed → prints the keys
pnpm dev --filter @proofql/api --filter @proofql/cdn   # api on 8797, cdn on 8800
# copy the *live publishable* key (pq_pk_live_…) from the seed output, then
open "http://localhost:8800/demo/?key=pq_pk_live_…&api=http://localhost:8797"
```

`http://localhost:8800` is in the seed's allowed origins (seed v4). `pnpm seed` mints new keys every run; update the URL, not the page.

The local seed embeds with a bag-of-words fake (`fakeEmbed` in `@proofql/ai`), so a query only clears the 0.55 relevance floor when it shares a good share of a review's words. The three queries above are phrased to do that against one seeded review each while still reading as something a dentist's page would ask; against real `bge-m3` embeddings any natural phrasing (`dental implants`, `kids`, `parking`) works and returns more. The reviews-mode section has no query and always renders the newest three.

### Hosted

The hosted URL belongs in the root README's "Demo" section once the Cloudflare account is provisioned: `infra/provisioning.md`, "Demo project on preview" (seed the preview database, add the cdn origin to the demo project's allowed origins, paste the link with the key). `cdn.proofql.com` itself is a `TODO` route in `wrangler.jsonc` (`env.prod`) until the domain exists — "Custom domains" in the same document.

`packages/snippet/demo/` is a different page: the snippet's own **styling test** (light and dark host, filters, a template). This one is the demo people are shown.
