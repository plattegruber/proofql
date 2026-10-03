# @proofql/docs

The developer docs at `docs.proofql.com` (#43): Astro [Starlight](https://starlight.astro.build) with the product tokens, deployed as an assets-only Cloudflare Worker (`proofql-docs-<env>`, `wrangler.jsonc`).

```sh
pnpm --filter @proofql/docs dev        # Astro dev server with hot reload, http://localhost:4321
pnpm --filter @proofql/docs build      # dist/
pnpm --filter @proofql/docs check      # build, then verify every internal link and anchor, and /limits against @proofql/core (also `test`)
pnpm --filter @proofql/docs exec wrangler dev   # serve dist/ the way the Worker will, http://localhost:8801
pnpm --filter @proofql/docs exec wrangler deploy --dry-run --env preview
```

## Layout

| Path | What |
|---|---|
| `src/content/docs/*.md(x)` | The pages: getting started, snippet, imports, query (relevance and the floor), errors, limits, the landing page, and the legal pages (`privacy.mdx`, `terms.mdx` — placeholder text under a "needs counsel" banner, `LegalNotice.astro`, until counsel's text lands; docs/launch.md "Legal"). Sidebar order is in `astro.config.mjs`. |
| `src/config.ts` | Build-time values: `SUPPORT_EMAIL` (from the `SUPPORT_EMAIL` environment variable of the build, else `DEFAULT_SUPPORT_EMAIL` from `@proofql/core`), the legal and roadmap URLs. |
| `src/components/Footer.astro` | Overrides Starlight's footer (`components.Footer` in `astro.config.mjs`): renders the default, then one line with the support address, privacy, terms, and "Status and roadmap" → the public GitHub issues. |
| `src/components/*.astro` | `PlanTable`, `RateLimitTable`, `BadgeRule`: the Limits page's plan numbers, rendered at build time from `@proofql/core` (`PLANS`, `planTableRows()`, `RATE_LIMIT_PERIOD_SECONDS`) so the docs cannot drift from the enforced limits (#103). |
| `astro.config.mjs` | Starlight config: no search, Google Fonts in `head`, the sidebar, and the `starlight-openapi` plugin that renders [`docs/api/openapi.yaml`](../api/openapi.yaml) at `/api/*`. |
| `src/styles/theme.css` | The design tokens through Starlight's variables: ink, one green, Space Grotesk and IBM Plex Mono, square corners, light and dark. |
| `scripts/check-limits.mjs` | The limits check. Re-reads the built `/limits` against the current `@proofql/core`: the plan table must equal `planTableRows()`, every number in `PLANS` must be in its plan's column, the rate-limit table and badge rule must match, and `PRICING_URL` must be linked. A core change without a docs rebuild fails here. |
| `scripts/check-links.mjs` | The link check. Fails on a broken internal link, a missing anchor, on any `ErrorCode` from the spec without an `id` on `/errors` (the api emits `doc_url: https://docs.proofql.com/errors#<code>` for every error), and on a missing `/query#relevance` (the dashboard's settings tab links to it). |
| `wrangler.jsonc` | Assets-only Worker over `dist/`. Pages are files (`errors.html`, from `build.format: "file"`) served at `/errors` with no trailing slash, so a `doc_url` resolves with no redirect in front of its fragment. |

## Rules

- The API reference is generated. To change it, change the spec (and the code and the contract tests in the same PR, [docs/api/README.md](../api/README.md)); never hand-edit a reference page.
- Every error code needs a `## <code>` heading on `errors.md` with the status, the cause, and a one-line fix; `check` enforces the anchor.
- Dashboard screens that do not exist on `main` yet are marked `:::caution[Coming soon]` with the issue number; remove the marker in the PR that ships the screen.
- Never hand-write a plan number. The Limits page renders them from `@proofql/core`; a number in prose elsewhere (getting started) should say "the numbers are on Limits" and link there.
- Sentence case, no exclamation points, no emoji (same as the dashboard).
