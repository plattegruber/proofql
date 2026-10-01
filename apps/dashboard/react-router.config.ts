import type { Config } from "@react-router/dev/config";

export default {
  // Server-render on the Workers runtime; the fetch handler is workers/app.ts.
  ssr: true,
  future: {
    // The server build runs inside @cloudflare/vite-plugin's workerd
    // environment (`viteEnvironment: { name: "ssr" }` in vite.config.ts).
    v8_viteEnvironmentApi: true,
    // Route middleware: Clerk's `clerkMiddleware()` authenticates every
    // request once at the root and hands the result to `getAuth()` in
    // loaders (app/lib/clerk.server.ts). With this flag `context` in
    // loaders is a RouterContextProvider; the Workers env/ctx travel on
    // `cloudflareContext` (workers/app.ts).
    v8_middleware: true,
  },
} satisfies Config;
