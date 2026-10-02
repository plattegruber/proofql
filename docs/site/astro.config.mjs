// Astro + Starlight configuration for the ProofQL docs site (#43).
//
// Static output, built to dist/ and served by an assets-only Worker
// (wrangler.jsonc). The API reference is generated from docs/api/openapi.yaml
// by starlight-openapi at /api/*, so the spec stays the single source of
// truth (docs/api/README.md). Search is off on purpose: seven pages and a
// sidebar do not need an index. Theming lives in src/styles/theme.css.

import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightOpenAPI, { openAPISidebarGroups } from "starlight-openapi";

const GOOGLE_FONTS =
  "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&family=Space+Grotesk:wght@400;500;600;700&display=swap";

export default defineConfig({
  site: "https://docs.proofql.com",
  // `/errors#validation_failed` is what every error envelope's `doc_url`
  // says, so pages are files (errors.html) with no trailing slash and no
  // redirect in front of the anchor.
  trailingSlash: "never",
  build: { format: "file" },
  // The dashboard's settings tab links to /query#relevance (its
  // RELEVANCE_DOCS_URL); the page's old slug stays reachable.
  redirects: { "/relevance": "/query" },
  integrations: [
    starlight({
      title: "ProofQL docs",
      description:
        "Review search as an API: push your reviews in, ask a question, render the ones that answer it.",
      pagefind: false,
      customCss: ["./src/styles/theme.css"],
      // Code blocks: square, hairline-bordered, mono from the token set.
      expressiveCode: {
        styleOverrides: {
          borderRadius: "0",
          borderWidth: "1px",
          codeFontFamily: "var(--sl-font-mono)",
          uiFontFamily: "var(--sl-font-mono)",
        },
      },
      head: [
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" },
        },
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.gstatic.com",
            crossorigin: true,
          },
        },
        { tag: "link", attrs: { rel: "stylesheet", href: GOOGLE_FONTS } },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/plattegruber/proofql",
        },
      ],
      sidebar: [
        { label: "Getting started", slug: "getting-started" },
        { label: "Snippet", slug: "snippet" },
        { label: "Imports", slug: "imports" },
        { label: "Relevance and the floor", slug: "query" },
        { label: "Errors", slug: "errors" },
        { label: "Limits", slug: "limits" },
        ...openAPISidebarGroups,
      ],
      plugins: [
        starlightOpenAPI([
          {
            base: "api",
            schema: "../api/openapi.yaml",
            sidebar: {
              label: "API reference",
              collapsed: false,
              operations: { badges: true },
            },
          },
        ]),
      ],
    }),
  ],
});
