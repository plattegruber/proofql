import { defineConfig } from "vitest/config";

// Unit only (CONTRIBUTING "Tests"): the header/caching logic runs under Node
// against a fake assets binding, and the build test runs scripts/build.mjs
// into a temp directory. No workerd, no DB, no network.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The build test bundles the snippet with esbuild; comfortably under a
    // second, but not the default 5 s on a cold CI runner with a cold cache.
    testTimeout: 30_000,
  },
});
