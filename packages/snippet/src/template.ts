/**
 * The `data-template` escape hatch (#33): full control of the markup.
 *
 * ```html
 * <template id="review">
 *   <figure>
 *     <span data-pq="stars"></span>
 *     <blockquote data-pq="excerpt"></blockquote>
 *     <figcaption><b data-pq="author"></b>, <a data-pq="url"><span data-pq="source"></span></a>, <time data-pq="date"></time></figcaption>
 *   </figure>
 * </template>
 * <div data-proofql data-query="…" data-template="#review"></div>
 * ```
 *
 * The template's content is cloned once per result and every element with a
 * `data-pq` marker is filled from that result:
 *
 * | marker    | gets                                                    |
 * |-----------|---------------------------------------------------------|
 * | `excerpt` | the excerpt (whole review in `mode=reviews`)            |
 * | `text-highlighted` | the whole review with the matched span in `<mark class="pq-mark">`; needs the text (`data-highlight="true"` or `mode=reviews`), else the excerpt |
 * | `author`  | `author_name`                                           |
 * | `source`  | the display name ("Google"); nothing for `custom`       |
 * | `date`    | a short local date; `datetime` too on a `<time>`        |
 * | `rating`  | the rating as text ("5")                                |
 * | `stars`   | `★★★★☆` plus `role="img"` and an "n out of 5 stars" label |
 * | `url`     | `href` on a link (http(s) only), else the URL as text   |
 *
 * A marker whose value the review lacks is removed from the clone. Values
 * are always text content or validated attributes — never parsed as HTML.
 * The badge is still appended after the clones when the API asks for it.
 * Every element at the top of a clone carries `data-pq-match` with the
 * response's verdict (`query` | `fallback` | `none` | `recent`, #86), and
 * the host element gets the same attribute plus `pq-fallback` on a
 * fallback, as the default render does; `data-heading` /
 * `data-fallback-heading` render a `<p class="pq-heading">` before the
 * clones.
 */

import {
  displayText,
  formatDate,
  MATCH_ATTR,
  markMatch,
  matchOf,
  renderBadge,
  renderHeading,
  safeHref,
  sourceName,
  starCount,
  textNodes,
} from "./render.js";
import type { QueryResponse, QueryResult, RenderOptions } from "./types.js";

export const TEMPLATE_ATTR = "data-template";

/** Resolve `data-template` to a `<template>`; null when it points nowhere. */
export function findTemplate(el: Element): HTMLTemplateElement | null {
  const selector = el.getAttribute(TEMPLATE_ATTR);
  if (selector === null || selector.trim() === "") return null;
  let found: Element | null;
  try {
    found = el.ownerDocument.querySelector(selector.trim());
  } catch {
    return null;
  }
  return found instanceof HTMLTemplateElement ? found : null;
}

function fillSlot(
  slot: Element,
  result: QueryResult,
  options: RenderOptions,
): void {
  const review = result.review;
  const marker = slot.getAttribute("data-pq");
  let text: string | null = null;
  switch (marker) {
    case "excerpt":
      text = displayText(result, options.mode);
      break;
    case "text-highlighted":
      slot.replaceChildren(
        ...textNodes(slot.ownerDocument, result, {
          ...options,
          highlight: true,
        }),
      );
      return;
    case "author":
      text = review.author_name;
      break;
    case "source":
      text = sourceName(String(review.source ?? ""));
      break;
    case "date": {
      const date = formatDate(review.occurred_at);
      if (date !== null) {
        text = date.text;
        if (slot instanceof HTMLTimeElement) slot.dateTime = date.iso;
      }
      break;
    }
    case "rating": {
      const stars = starCount(review.rating);
      if (stars !== null) text = String(review.rating);
      break;
    }
    case "stars": {
      const stars = starCount(review.rating);
      if (stars !== null) {
        text = "★".repeat(stars) + "☆".repeat(5 - stars);
        if (!slot.hasAttribute("role")) slot.setAttribute("role", "img");
        slot.setAttribute("aria-label", `${stars} out of 5 stars`);
      }
      break;
    }
    case "url": {
      const href = safeHref(review.url);
      if (href !== null) {
        if (slot instanceof HTMLAnchorElement) {
          slot.href = href;
          if (!slot.hasAttribute("rel")) slot.rel = "noopener";
          return; // the link keeps its own content
        }
        text = href;
      }
      break;
    }
    default:
      return; // unknown marker: leave as authored
  }
  if (text === null || text.trim() === "") slot.remove();
  else slot.textContent = text;
}

/** Clone `template` once per result into `el`, then the badge if asked. */
export function renderTemplate(
  el: Element,
  template: HTMLTemplateElement,
  response: QueryResponse,
  options: RenderOptions,
): void {
  const doc = el.ownerDocument;
  const match = matchOf(response);
  const nodes: Node[] = [];
  const heading = renderHeading(doc, match, options);
  if (heading) nodes.push(heading);
  for (const result of response.results) {
    const clone = doc.importNode(template.content, true);
    for (const slot of Array.from(clone.querySelectorAll("[data-pq]"))) {
      fillSlot(slot, result, options);
    }
    for (const root of Array.from(clone.children)) {
      root.setAttribute(MATCH_ATTR, match);
    }
    nodes.push(clone);
  }
  if (response.badge) nodes.push(renderBadge(doc));
  markMatch(el, match);
  el.replaceChildren(...nodes);
}
