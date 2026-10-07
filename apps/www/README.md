# @proofql/www

The marketing site at `proofql.dev`: one static page built with Astro and deployed as an assets-only Cloudflare Worker (`proofql-www-<env>`, `wrangler.jsonc`), the same setup as the docs (`docs/site`). There is no client framework. The only script is the demo's tab switcher (about 1 KB, inlined).

```sh
pnpm --filter @proofql/www dev        # Astro dev server, http://localhost:4322
pnpm --filter @proofql/www build      # dist/
pnpm --filter @proofql/www test       # build, site check, then vitest (axe, contrast, tabs)
pnpm --filter @proofql/www exec wrangler dev   # serve dist/ the way the Worker will (headers, /pricing redirect), http://localhost:8804
pnpm --filter @proofql/www exec wrangler deploy --dry-run --env preview
```

## Layout

| Path | What |
|---|---|
| `src/pages/index.astro` | The landing page. **The copy is the owner's, verbatim.** Do not edit wording without the owner; `scripts/check-site.mjs` holds the same lines and fails the build on drift. |
| `src/components/Logo.astro` | The logo, and the only place it is defined. Today it is a text wordmark. The animated logo from Claude Design goes here, and its motion must stop under `prefers-reduced-motion: reduce`. |
| `src/components/Demo.astro` | "See it in action": an accessible tab switcher over the three example pages from the table. Each tab shows a mock service page on a reserved `.example` host, with the reviews block the snippet renders, the snippet tag, and the `/v1/query` request it sends. |
| `src/lib/demo.ts` | The demo's example reviews. They were **written for the demo**, are labelled "Example reviews" on the page, and must never be presented as real customers. Authors are first name plus initial. |
| `src/lib/reviews.ts` | Renders each reviews block **at build time with the snippet's own code** (`renderInto`, `readElementQuery`, `buildQueryUrl` from `packages/snippet/src`) against a happy-dom document. The page therefore carries the snippet's exact markup, including `<mark class="pq-mark">` on the matching sentence. `Demo.astro` imports the snippet's `styles.css`. Nothing calls the API. |
| `src/scripts/tabs.ts` | The WAI-ARIA tabs pattern: arrow keys, Home/End, roving tabindex. All panels share one grid cell, so switching tabs never changes the page height. Without JavaScript every panel shows and the tab list is hidden. |
| `src/styles/global.css` | The product tokens (ink, one green, Space Grotesk and IBM Plex Mono, square corners) in light and dark, following `prefers-color-scheme`. |
| `src/config.ts` | URLs (sign-up, sign-in, docs, legal) and the support address (`SUPPORT_EMAIL` at build time, else `DEFAULT_SUPPORT_EMAIL` from `@proofql/core`). |
| `public/fonts/` | Self-hosted latin subsets of Space Grotesk (variable) and IBM Plex Mono 400/500, under the SIL OFL 1.1 (license files alongside). The text face is preloaded. |
| `public/_headers`, `public/_redirects` | Security and cache headers for Workers Static Assets. `/pricing` redirects to the docs' Limits page, because `PRICING_URL` in `@proofql/core` is `https://proofql.dev/pricing`. |
| `public/og.png` | The 1200×630 social card. |
| `scripts/check-site.mjs` | The site check, run after the build. It fails on: broken internal links or anchors, any third-party script, style or font, copy drift, CTAs pointing at the wrong targets, and demo panels without the "Example reviews" label or a highlighted match. |
| `test/` | axe-core over the built pages in jsdom. WCAG AA contrast is computed for every token pair in both themes, since jsdom has no layout. Also unit tests for the tab switcher. |

## Deploy

On every push to `main`, `.github/workflows/deploy.yml` builds and deploys `proofql-www-preview` and smoke-checks its front page on workers.dev. The prod block in `wrangler.jsonc` (custom domains `proofql.dev` and `www.proofql.dev`, `workers_dev: false`) is only deployed when the repository variable `WWW_PROD_ENABLED` is `true`. The apex still has placeholder DNS records and a redirect rule to the docs, and a custom domain cannot attach over them. The owner's cutover steps are in [docs/launch.md §2](../../docs/launch.md), step 7.

## Rules

- Copy: sentence case, no exclamation points, no emoji. Never add marketing claims. Any new copy comes from the owner.
- Budget: Lighthouse 95+ in all four categories, zero layout shift, no third-party requests.
