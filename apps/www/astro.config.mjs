// Astro configuration for the ProofQL marketing site (proofql.dev).
//
// Static output, built to dist/ and served by an assets-only Worker
// (wrangler.jsonc), the same shape as docs/site. One page, no client
// framework: small inlined scripts only (the demo's tab switcher, the
// header's phone menu, the logo's motion; src/scripts/). Stylesheets are inlined so the first paint needs
// no extra request; the fonts are self-hosted from public/fonts and
// preloaded in src/layouts/Base.astro.

import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://proofql.dev",
  trailingSlash: "never",
  build: { format: "file", inlineStylesheets: "always" },
  // No dev toolbar in screenshots or audits.
  devToolbar: { enabled: false },
});
