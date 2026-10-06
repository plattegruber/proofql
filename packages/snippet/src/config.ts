/**
 * Script-tag configuration: `data-key` (the publishable key) and `data-api`
 * (the API origin, for local development and self-hosted previews).
 *
 * ```html
 * <script async src="https://cdn.proofql.dev/v1.js" data-key="pq_pk_live_…"></script>
 * ```
 */

export const DEFAULT_API = "https://api.proofql.dev";

export interface SnippetConfig {
  key: string;
  api: string;
}

/**
 * The `<script>` that loaded the snippet. `document.currentScript` is set
 * while a classic script (async or not) runs its top level; it is null for
 * module scripts and when the snippet is executed in some other way, so fall
 * back to the last `<script data-key>` in the document.
 */
export function findScript(doc: Document): HTMLScriptElement | null {
  const current = doc.currentScript;
  if (current instanceof HTMLScriptElement) return current;
  const all = doc.querySelectorAll<HTMLScriptElement>("script[data-key]");
  return all[all.length - 1] ?? null;
}

/** Null when there is no key: nothing can be fetched, so nothing renders. */
export function readScriptConfig(
  script: HTMLScriptElement | null,
): SnippetConfig | null {
  if (!script) return null;
  const key = (script.getAttribute("data-key") ?? "").trim();
  if (key === "") return null;
  const api = (script.getAttribute("data-api") ?? "").trim() || DEFAULT_API;
  return { key, api: api.replace(/\/+$/, "") };
}
