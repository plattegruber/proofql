import { defineConfig } from "vitest/config";

// Runs after `astro build` (the `test` script builds first): test/*.test.ts
// read dist/ into jsdom, plus unit tests for the demo's tab switcher.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
});
