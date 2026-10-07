/**
 * Build-time rendering of the demo's reviews blocks with the snippet's own
 * code, so the page shows the snippet's real markup rather than a copy of
 * it: `renderInto` from packages/snippet/src/render.ts (the same function
 * cdn.proofql.dev/v1.js calls) runs against a happy-dom document here, and
 * the resulting HTML is written into the static page. Its stylesheet,
 * packages/snippet/src/styles.css, is imported by src/components/Demo.astro.
 *
 * Nothing here ships to the browser.
 */

import { buildQueryUrl, readElementQuery } from "@proofql/snippet/src/query.ts";
import { renderInto } from "@proofql/snippet/src/render.ts";
import type {
  QueryResponse,
  RenderOptions,
} from "@proofql/snippet/src/types.ts";
import { Window } from "happy-dom";

import { DEMO_HEADING, type DemoPage } from "./demo";

/** The placeholder key shown in the example tag (never a real key). */
export const EXAMPLE_KEY = "pq_pk_live_…";
export const SNIPPET_SRC = "https://cdn.proofql.dev/v1.js";

/** The `[data-proofql]` element's attributes for a page, in source order. */
export function hostAttributes(page: DemoPage): [string, string][] {
  return [
    ["data-proofql", ""],
    ["data-query", page.query],
    ["data-highlight", "true"],
    ["data-heading", DEMO_HEADING],
  ];
}

/** The hand-built response a page's query would get (see ./demo.ts). */
export function demoResponse(page: DemoPage): QueryResponse {
  return {
    match: "query",
    took_ms: 0,
    cached: false,
    badge: false,
    results: page.reviews.map((review, i) => {
      const start = review.text.indexOf(review.match);
      if (start < 0) {
        throw new Error(
          `demo: "${review.match}" is not in ${page.id} review ${i}`,
        );
      }
      return {
        score: null,
        excerpt: review.match,
        excerpt_id: `${page.id}-${i}`,
        matched: true,
        highlight: { start, end: start + review.match.length },
        review: {
          id: `${page.id}-${i}`,
          rating: review.rating,
          author_name: review.author,
          author_avatar_url: null,
          source: "google",
          occurred_at: null,
          url: null,
          metadata: {},
          text: review.text,
        },
      };
    }),
  };
}

export interface RenderedBlock {
  /** The host element with the snippet's rendering inside, as HTML. */
  html: string;
  /** The tag a site owner writes for this page. */
  tag: string;
  /** The request the snippet sends for it (key elided). */
  request: string;
}

/** Render one page's reviews block exactly as the snippet would. */
export function renderBlock(page: DemoPage): RenderedBlock {
  const window = new Window();
  try {
    const doc = window.document as unknown as Document;
    const host = doc.createElement("div");
    for (const [name, value] of hostAttributes(page)) {
      host.setAttribute(name, value);
    }
    const query = readElementQuery(host);
    const options: RenderOptions = {
      mode: query.mode ?? "excerpts",
      highlight: query.highlight,
      heading: DEMO_HEADING,
    };
    renderInto(host, demoResponse(page), options);

    const attrs = hostAttributes(page)
      .map(([name, value]) => (value === "" ? name : `${name}="${value}"`))
      .join(" ");
    const url = new URL(buildQueryUrl("https://api.proofql.dev", "KEY", query));
    return {
      html: host.outerHTML,
      tag: `<div ${attrs}></div>\n<script async src="${SNIPPET_SRC}" data-key="${EXAMPLE_KEY}"></script>`,
      request: `GET ${url.pathname}${url.search.replace("key=KEY", `key=${EXAMPLE_KEY}`)}`,
    };
  } finally {
    void window.happyDOM.close();
  }
}
