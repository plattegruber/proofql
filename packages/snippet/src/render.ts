/**
 * Default rendering: a plain, semantic structure built with the DOM API.
 * Everything from the API goes through `textContent` or validated
 * attributes — never `innerHTML` — so a review can say `<script>` all it
 * likes. The structure is the contract #33's stylesheet targets:
 *
 * ```html
 * <p class="pq-heading">…</p>                        <!-- data-heading / data-fallback-heading only -->
 * <ul class="pq-list" role="list">
 *   <li class="pq-item">
 *     <span class="pq-stars" role="img" aria-label="4 out of 5 stars">
 *       <span aria-hidden="true">★★★★</span><span class="pq-stars-off" aria-hidden="true">☆</span>
 *     </span>
 *     <blockquote class="pq-excerpt">…</blockquote>   <!-- data-highlight: text, <mark class="pq-mark">, text -->
 *     <footer class="pq-meta">
 *       <span class="pq-author">…</span>
 *       <a class="pq-source" href="…">Google</a>   <!-- <span> without a URL; none for `custom` -->
 *       <time class="pq-date" datetime="…">Jan 15, 2026</time>
 *     </footer>
 *   </li>
 * </ul>
 * <a class="pq-badge" href="https://proofql.dev/?ref=badge" …>Reviews by ProofQL</a>
 * ```
 *
 * A native list (`<ul>`/`<li>`): `role="listitem"` is not an allowed role on
 * `<article>` (axe `aria-allowed-role`). The explicit `role="list"` is kept
 * on purpose — Safari drops a `<ul>`'s list semantics under
 * `list-style: none`, which the default stylesheet sets. The badge is a
 * sibling of the list, not a child: a list may only own list items.
 *
 * Honest fallback (#86): the host element itself gets
 * `data-pq-match="<match>"` on every render and the class `pq-fallback`
 * when the API answered with its newest reviews because nothing matched,
 * so host CSS can restyle; the heading swaps from `data-heading` to
 * `data-fallback-heading` on that response ("What patients say about
 * insurance" → "What patients say about working with us"). Nothing is
 * rendered for a heading that was not given.
 */

import type {
  QueryMatch,
  QueryMode,
  QueryResponse,
  QueryResult,
  RenderOptions,
} from "./types.js";

export const MATCH_ATTR = "data-pq-match";
export const FALLBACK_CLASS = "pq-fallback";

/** The response's verdict; an older build without `match` is a query answer. */
export function matchOf(response: QueryResponse): QueryMatch {
  return response.match ?? "query";
}

/** Mark the host with the verdict so host CSS can restyle a fallback. */
export function markMatch(el: Element, match: QueryMatch): void {
  el.setAttribute(MATCH_ATTR, match);
  el.classList.toggle(FALLBACK_CLASS, match === "fallback");
}

/** The heading for this response, or null when the host gave none. */
export function renderHeading(
  doc: Document,
  match: QueryMatch,
  options: RenderOptions,
): HTMLElement | null {
  const text =
    (match === "fallback" ? options.fallbackHeading : undefined) ??
    options.heading;
  return text ? element(doc, "p", "pq-heading", text) : null;
}

export const BADGE_HREF = "https://proofql.dev/?ref=badge";
export const BADGE_TEXT = "Reviews by ProofQL";

const SOURCE_NAMES: Record<string, string> = {
  google: "Google",
  yelp: "Yelp",
  facebook: "Facebook",
  trustpilot: "Trustpilot",
};

/** Display name for a `source`; null for `custom` (the customer's own reviews). */
export function sourceName(source: string): string | null {
  const key = source.trim().toLowerCase();
  if (key === "" || key === "custom") return null;
  return SOURCE_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** Only http(s) URLs may become `href`s; anything else renders as plain text. */
export function safeHref(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Integer star count in 0–5, or null when there is no rating. */
export function starCount(rating: number | null | undefined): number | null {
  if (typeof rating !== "number" || Number.isNaN(rating)) return null;
  return Math.min(5, Math.max(0, Math.round(rating)));
}

export interface DateParts {
  iso: string;
  text: string;
}

/** `occurred_at` → a machine `datetime` and a short local date. */
export function formatDate(value: string | null | undefined): DateParts | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    iso: date.toISOString(),
    text: date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
  };
}

/** The text the host sees: the whole review in `reviews` mode, else the excerpt. */
export function displayText(result: QueryResult, mode: QueryMode): string {
  const text = result.review.text;
  return mode === "reviews" && typeof text === "string" && text.trim() !== ""
    ? text
    : result.excerpt;
}

/**
 * The nodes for a result's text. With `highlight` on and the whole text
 * present, the review is split into three text nodes around a
 * `<mark class="pq-mark">` holding the excerpt — the API's `highlight`
 * offsets are UTF-16 code units, the unit `slice` uses, and the span is
 * checked against the excerpt before it is marked, so a stale or
 * mismatched span renders the plain text rather than a wrong mark. With
 * nothing to mark (no `q`, a whole-review match) it is the text in one
 * node; without the text, the excerpt. Never `innerHTML`.
 */
export function textNodes(
  doc: Document,
  result: QueryResult,
  options: RenderOptions,
): Node[] {
  const text = result.review.text;
  const span = result.highlight;
  if (options.highlight && typeof text === "string" && text !== "") {
    if (
      span &&
      span.start >= 0 &&
      span.start < span.end &&
      span.end <= text.length &&
      text.slice(span.start, span.end) === result.excerpt
    ) {
      return [
        doc.createTextNode(text.slice(0, span.start)),
        element(doc, "mark", "pq-mark", result.excerpt),
        doc.createTextNode(text.slice(span.end)),
      ];
    }
    return [doc.createTextNode(text)];
  }
  return [doc.createTextNode(displayText(result, options.mode))];
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function renderStars(doc: Document, count: number): HTMLElement {
  const stars = element(doc, "span", "pq-stars");
  stars.setAttribute("role", "img");
  stars.setAttribute("aria-label", `${count} out of 5 stars`);
  const on = element(doc, "span", "pq-stars-on", "★".repeat(count));
  on.setAttribute("aria-hidden", "true");
  stars.appendChild(on);
  if (count < 5) {
    const off = element(doc, "span", "pq-stars-off", "☆".repeat(5 - count));
    off.setAttribute("aria-hidden", "true");
    stars.appendChild(off);
  }
  return stars;
}

export function renderItem(
  doc: Document,
  result: QueryResult,
  options: RenderOptions,
): HTMLElement {
  const item = element(doc, "li", "pq-item");

  const stars = starCount(result.review.rating);
  if (stars !== null) item.appendChild(renderStars(doc, stars));

  const quote = element(doc, "blockquote", "pq-excerpt");
  quote.append(...textNodes(doc, result, options));
  item.appendChild(quote);

  const meta = element(doc, "footer", "pq-meta");
  const author = result.review.author_name;
  if (typeof author === "string" && author.trim() !== "") {
    meta.appendChild(element(doc, "span", "pq-author", author));
  }
  const source = sourceName(String(result.review.source ?? ""));
  if (source !== null) {
    const href = safeHref(result.review.url);
    if (href !== null) {
      const link = element(doc, "a", "pq-source", source);
      link.href = href;
      link.rel = "noopener";
      link.target = "_blank";
      meta.appendChild(link);
    } else {
      meta.appendChild(element(doc, "span", "pq-source", source));
    }
  }
  const date = formatDate(result.review.occurred_at);
  if (date !== null) {
    const time = element(doc, "time", "pq-date", date.text);
    time.dateTime = date.iso;
    meta.appendChild(time);
  }
  if (meta.childNodes.length > 0) item.appendChild(meta);

  return item;
}

export function renderBadge(doc: Document): HTMLAnchorElement {
  const badge = element(doc, "a", "pq-badge", BADGE_TEXT);
  badge.href = BADGE_HREF;
  badge.rel = "noopener";
  badge.target = "_blank";
  return badge;
}

/**
 * Replace the element's children with the rendered results (and the badge
 * when the API asks for it). Existing children — a host's fallback content —
 * survive until there is something to show.
 */
export function renderInto(
  el: Element,
  response: QueryResponse,
  options: RenderOptions,
): void {
  const doc = el.ownerDocument;
  const match = matchOf(response);
  const list = element(doc, "ul", "pq-list");
  list.setAttribute("role", "list");
  for (const result of response.results) {
    list.appendChild(renderItem(doc, result, options));
  }
  const nodes: Node[] = [list];
  const heading = renderHeading(doc, match, options);
  if (heading) nodes.unshift(heading);
  if (response.badge) nodes.push(renderBadge(doc));
  markMatch(el, match);
  el.replaceChildren(...nodes);
}
