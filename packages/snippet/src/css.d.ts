// `import css from "./styles.css?raw"` is the stylesheet as a string: Vite
// (vitest) handles `?raw` natively and scripts/build.mjs teaches esbuild.
declare module "*.css?raw" {
  const css: string;
  export default css;
}
