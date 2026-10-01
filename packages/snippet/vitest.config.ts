import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify("test"),
  },
  test: {
    environment: "jsdom",
    // Leave CSS to Vite so `./styles.css?raw` is the stylesheet, not "".
    css: true,
    include: ["src/**/*.test.ts"],
  },
});
