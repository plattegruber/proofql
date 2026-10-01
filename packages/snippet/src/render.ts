/**
 * Default rendering: a plain, semantic structure built with the DOM API.
 * Everything from the API goes through `textContent` or validated
 * attributes — never `innerHTML` — so a review can say `<script>` all it
 * likes. The structure is the contract #33's stylesheet targets:
 *
 * ```html
 * <div class="pq-list" role="list">
 *   <article class="pq-item" role="listitem">
 *     <span class="pq-stars" role="img" aria-label="4 out of 5 stars">
 *       <span aria-hidden="true">★★★★</span><span class="pq-stars-off" aria-hidden="true">☆</span>
 *     </span>
 *     <blockquote class="pq-excerpt">…</blockquote>
 *     <footer class="pq-meta">
 *       <span class="pq-author">…</span>
 *       <a class="pq-source" href="…">Google</a>   <!-- <span> without a URL; none for `custom` -->
 *       <time class="pq-date" datetime="…">Jan 15, 2026</time>
 *     </footer>
 *   </article>
 * </div>
 * <a class="pq-badge" href="https://proofql.com/?ref=badge" …>Reviews by ProofQL</a>
 * ```
 *
 * The badge is a sibling of the list, not a child: a `role="list"` may only
 * own list items.
 */

import type { QueryMode, QueryResponse, QueryResult } from "./types.js";

export const BADGE_HREF = "https://proofql.com/?ref=badge";
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
  mode: QueryMode,
): HTMLElement {
  const item = element(doc, "article", "pq-item");
  item.setAttribute("role", "listitem");

  const stars = starCount(result.review.rating);
  if (stars !== null) item.appendChild(renderStars(doc, stars));

  item.appendChild(
    element(doc, "blockquote", "pq-excerpt", displayText(result, mode)),
  );

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
  mode: QueryMode,
): void {
  const doc = el.ownerDocument;
  const list = element(doc, "div", "pq-list");
  list.setAttribute("role", "list");
  for (const result of response.results) {
    list.appendChild(renderItem(doc, result, mode));
  }
  const nodes: Node[] = [list];
  if (response.badge) nodes.push(renderBadge(doc));
  el.replaceChildren(...nodes);
}
