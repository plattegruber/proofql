import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // Mirror the `~` path alias from tsconfig.json (also mirrored in
    // vitest.config.ts, which deliberately does not share this file).
    alias: {
      "~": new URL("./app", import.meta.url).pathname,
    },
  },
  plugins: [
    // Runs the worker in workerd (Miniflare) inside the Vite dev server, so
    // `pnpm dev` exercises the real Workers runtime, and emits the deployable
    // worker bundle + resolved wrangler.json on build.
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    // Tailwind v4, CSS-first: all configuration lives in app/app.css.
    tailwindcss(),
    reactRouter(),
  ],
  server: {
    // Fixed port from the local dev matrix (infra/environments.md) so every
    // worker can run side by side. Mirrors `dev.port` in wrangler.jsonc,
    // which applies only when bypassing Vite with raw `wrangler dev`.
    port: 8799,
    strictPort: true,
  },
});
