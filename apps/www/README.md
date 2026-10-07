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
| `src/components/Logo.astro` | The logo: the mark plus the "ProofQL" wordmark. Every use on the site goes through it. The nav's mark blinks now and then and does not track the cursor. |
| `src/components/Creature.astro` | The mark from Claude Design ("Alive Logo"): two code braces and two amber bar eyes, drawn in plain HTML/CSS plus inline SVG and sized by `font-size`. `motion="alive"` is the hero creature, `"blink"` is the nav mark, `"none"` is static. It is decorative everywhere (`aria-hidden`). Paper colours apply in light mode and Obsidian in dark (`--creature-*` tokens in `global.css`). |
| `src/lib/mark.ts` | The mark's geometry: the source's layout in em, and the `{` and `}` glyphs of **JetBrains Mono ExtraBold 2.211** outlined to SVG paths. No font is loaded. JetBrains Mono is © 2020 The JetBrains Mono Project Authors, SIL OFL 1.1; the license is at `public/fonts/OFL-jetbrains-mono.txt`. `markSvg()` builds the static mark for the favicon and OG image. |
| `src/scripts/creature.ts`, `creature-math.ts` | The hero creature's motion, a vanilla port of the source with the same springs, wander, blink, squash-and-stretch bounce every ~6 s, happy state near the cursor, and click/tap startle. requestAnimationFrame runs only while the creature is on screen and the tab is visible. Listeners are passive. Lifting a finger ends tracking, so the happy state never sticks on touch. Under `prefers-reduced-motion` the mark stays static. `creature-math.ts` holds the pure curves, which are unit-tested. |
| `src/scripts/blink.ts` | The nav mark's blink: a timer and a CSS animation, with no animation frame. |
| `src/components/Demo.astro` | "See it in action": an accessible tab switcher over the three example pages from the table. Each tab shows a mock service page on a reserved `.example` host, with the reviews block the snippet renders, the snippet tag, and the `/v1/query` request it sends. |
| `src/lib/demo.ts` | The demo's example reviews. They were **written for the demo**, are labelled "Example reviews" on the page, and must never be presented as real customers. Authors are first name plus initial. |
| `src/lib/reviews.ts` | Renders each reviews block **at build time with the snippet's own code** (`renderInto`, `readElementQuery`, `buildQueryUrl` from `packages/snippet/src`) against a happy-dom document. The page therefore carries the snippet's exact markup, including `<mark class="pq-mark">` on the matching sentence. `Demo.astro` imports the snippet's `styles.css`. Nothing calls the API. |
| `src/scripts/tabs.ts` | The WAI-ARIA tabs pattern: arrow keys, Home/End, roving tabindex. All panels share one grid cell, so switching tabs never changes the page height. Without JavaScript every panel shows and the tab list is hidden. |
| `src/styles/global.css` | The product tokens (ink, one green, Space Grotesk and IBM Plex Mono, square corners) in light and dark, following `prefers-color-scheme`. |
| `src/config.ts` | URLs (sign-up, sign-in, docs, legal) and the support address (`SUPPORT_EMAIL` at build time, else `DEFAULT_SUPPORT_EMAIL` from `@proofql/core`). |
| `public/fonts/` | Self-hosted latin subsets of Space Grotesk (variable) and IBM Plex Mono 400/500, under the SIL OFL 1.1 (license files alongside). The text face is preloaded. |
| `public/_headers`, `public/_redirects` | Security and cache headers for Workers Static Assets. `/pricing` redirects to the docs' Limits page, because `PRICING_URL` in `@proofql/core` is `https://proofql.dev/pricing`. |
| `public/og.png`, `public/favicon.svg` | The 1200×630 social card and the favicon. Both show the static mark. The favicon is generated from `src/lib/mark.ts` (`markSvg`), and `test/creature.test.ts` checks that its outlines match. |
| `scripts/check-site.mjs` | The site check, run after the build. It fails on: broken internal links or anchors, any third-party script, style or font, copy drift, CTAs pointing at the wrong targets, and demo panels without the "Example reviews" label or a highlighted match. |
| `test/` | axe-core over the built pages in jsdom. WCAG AA contrast is computed for every token pair in both themes, since jsdom has no layout. Also unit tests for the tab switcher and for the creature's bounce curve, springs and blink. |

## Deploy

On every push to `main`, `.github/workflows/deploy.yml` builds and deploys `proofql-www-preview` and smoke-checks its front page on workers.dev. The prod block in `wrangler.jsonc` (custom domains `proofql.dev` and `www.proofql.dev`, `workers_dev: false`) is only deployed when the repository variable `WWW_PROD_ENABLED` is `true`. The apex still has placeholder DNS records and a redirect rule to the docs, and a custom domain cannot attach over them. The owner's cutover steps are in [docs/launch.md §2](../../docs/launch.md), step 7.

## Rules

- Copy: sentence case, no exclamation points, no emoji. Never add marketing claims. Any new copy comes from the owner.
- Budget: Lighthouse 95+ in all four categories, zero layout shift, no third-party requests.
