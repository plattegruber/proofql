/**
 * The snippet's life cycle (#32): read the script tag, find every
 * `[data-proofql]`, fetch, render, fail silent. Rendering goes through the
 * default structure (./render.ts) or the host's own `<template>`
 * (./template.ts), with the default stylesheet injected once (./styles.ts).
 *
 * Failure policy — the one quality property that matters (scope.md §1,
 * "empty beats irrelevant"): empty `results`, a non-2xx response, a network
 * error, or malformed JSON all render nothing and leave the host element
 * exactly as it was. Each such outcome is one `console.debug` line, never
 * `warn`/`error`, so a free-tier site with no matches has a clean console.
 * Nothing in here throws into the host page.
 */

import { findScript, readScriptConfig, type SnippetConfig } from "./config.js";
import { buildQueryUrl, readElementQuery } from "./query.js";
import { renderInto } from "./render.js";
import { ensureStyles } from "./styles.js";
import { findTemplate, renderTemplate } from "./template.js";
import type { QueryResponse, QueryResult } from "./types.js";

export const SELECTOR = "[data-proofql]";
/** Set while an element is being fetched and after it has rendered. */
export const RENDERED_ATTR = "data-proofql-rendered";

export interface ProofQLGlobal {
  /** Scan `root` (default: the document) for `[data-proofql]` and render. */
  render(root?: Element | Document): Promise<void>;
  version: string;
}

export function debug(reason: string, detail?: unknown): void {
  // Debug level on purpose: a quiet failure must not look like a page bug.
  if (detail === undefined) console.debug(`[proofql] ${reason}`);
  else console.debug(`[proofql] ${reason}`, detail);
}

/** Loose structural check: the only things rendering needs to be there. */
export function isQueryResponse(value: unknown): value is QueryResponse {
  if (typeof value !== "object" || value === null) return false;
  const results = (value as { results?: unknown }).results;
  return Array.isArray(results) && results.every(isQueryResult);
}

function isQueryResult(value: unknown): value is QueryResult {
  if (typeof value !== "object" || value === null) return false;
  const r = value as { excerpt?: unknown; review?: unknown };
  return (
    typeof r.excerpt === "string" &&
    typeof r.review === "object" &&
    r.review !== null
  );
}

async function fetchResponse(url: string): Promise<QueryResponse | null> {
  let res: Response;
  try {
    // No init: a plain GET with no custom headers is a CORS simple request,
    // so there is no preflight and the `?key=` form authenticates.
    res = await fetch(url);
  } catch (error) {
    debug("network error", error);
    return null;
  }
  if (!res.ok) {
    debug(`HTTP ${res.status}`);
    return null;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (error) {
    debug("malformed JSON", error);
    return null;
  }
  if (!isQueryResponse(body)) {
    debug("unexpected response shape");
    return null;
  }
  return body;
}

/** Fetch and render one element. Resolves (never rejects) when done. */
export async function renderElement(
  el: Element,
  config: SnippetConfig,
): Promise<void> {
  if (el.hasAttribute(RENDERED_ATTR)) return;
  el.setAttribute(RENDERED_ATTR, "");
  try {
    const query = readElementQuery(el);
    const response = await fetchResponse(
      buildQueryUrl(config.api, config.key, query),
    );
    if (response === null || response.results.length === 0) {
      if (response !== null) debug("no results");
      el.removeAttribute(RENDERED_ATTR);
      return;
    }
    const options = {
      mode: query.mode ?? "excerpts",
      highlight: query.highlight,
    };
    ensureStyles(el.ownerDocument);
    const template = findTemplate(el);
    if (template !== null) renderTemplate(el, template, response, options);
    else renderInto(el, response, options);
  } catch (error) {
    debug("render failed", error);
    el.removeAttribute(RENDERED_ATTR);
  }
}

/** Every `[data-proofql]` under (or at) `root`. */
export function findTargets(root: Element | Document): Element[] {
  const found = Array.from(root.querySelectorAll(SELECTOR));
  if (root instanceof Element && root.matches(SELECTOR)) found.unshift(root);
  return found;
}

/**
 * Wire the snippet into a window: resolve the config from the script tag,
 * expose `window.ProofQL`, and scan once the DOM is ready. Returns the
 * global for tests; the entry point (index.ts) ignores it.
 */
export function boot(win: Window & typeof globalThis): ProofQLGlobal {
  const doc = win.document;
  const config = readScriptConfig(findScript(doc));
  if (config === null) debug("missing data-key on the script tag");

  const render = async (root?: Element | Document): Promise<void> => {
    try {
      if (config === null) return;
      await Promise.all(
        findTargets(root ?? doc).map((el) => renderElement(el, config)),
      );
    } catch (error) {
      debug("render failed", error);
    }
  };

  const api: ProofQLGlobal = { render, version: __VERSION__ };
  (win as unknown as { ProofQL: ProofQLGlobal }).ProofQL = api;

  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", () => void render(), {
      once: true,
    });
  } else {
    void render();
  }
  return api;
}
