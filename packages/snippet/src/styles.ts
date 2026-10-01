/**
 * The default stylesheet (src/styles.css) rides inside the bundle and is
 * injected once, lazily — the first time something actually renders — so a
 * page where nothing matches keeps an untouched `<head>`. One tag is still
 * the whole integration.
 */

import css from "./styles.css?raw";

export const STYLE_ATTR = "data-proofql-styles";

export { css as STYLESHEET };

export function ensureStyles(doc: Document): void {
  if (doc.querySelector(`style[${STYLE_ATTR}]`)) return;
  const style = doc.createElement("style");
  style.setAttribute(STYLE_ATTR, "");
  style.textContent = css;
  (doc.head ?? doc.documentElement).appendChild(style);
}
