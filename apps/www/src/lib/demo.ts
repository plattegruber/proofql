/**
 * The "See it in action" demo: three example service pages, each with the
 * reviews block the snippet would render on it.
 *
 * Everything here is illustrative. The reviews were written for this page,
 * are labelled "Example reviews" wherever they appear, and are never
 * presented as real customers. There are no live API calls (prod has no demo
 * project): each tab is a hand-built `QueryResponse` rendered at build time
 * by the snippet's own `renderInto` (./reviews.ts), so the markup is exactly
 * what the snippet produces.
 *
 * `match` is the sentence the API would return as the excerpt; its offsets
 * in `text` become the result's `highlight`, so the snippet marks it with
 * `<mark class="pq-mark">`.
 */

export interface DemoReview {
  author: string;
  rating: number;
  text: string;
  /** Must occur verbatim in `text`. */
  match: string;
}

export interface DemoPage {
  /** Stable id for the tab and panel elements. */
  id: string;
  /** The tab label: the "On this page…" column of the table. */
  label: string;
  /** The example business site the page lives on (a reserved `.example` host). */
  host: string;
  path: string;
  business: string;
  /** What the page's snippet asks for (`data-query`). */
  query: string;
  reviews: DemoReview[];
}

export const DEMO_HEADING = "Example reviews";

export const DEMO_PAGES: DemoPage[] = [
  {
    id: "roofing",
    label: "Roof replacement",
    host: "roofing.example",
    path: "/roof-replacement",
    business: "Example Roofing Co.",
    query: "roof replacement",
    reviews: [
      {
        author: "Dana R.",
        rating: 5,
        text: "Called them after the spring storm. They ended up replacing our shingles and the whole job took two days. The yard was cleaner than when they arrived.",
        match:
          "They ended up replacing our shingles and the whole job took two days.",
      },
      {
        author: "Luis M.",
        rating: 5,
        text: "We got three quotes and theirs was the easiest to follow. The crew put on the new roof in a single day and hauled away every old nail.",
        match:
          "The crew put on the new roof in a single day and hauled away every old nail.",
      },
      {
        author: "Priya K.",
        rating: 4,
        text: "The office took a while to call back. Our old roof leaked over the garage, and the replacement has held up through two winters.",
        match:
          "Our old roof leaked over the garage, and the replacement has held up through two winters.",
      },
    ],
  },
  {
    id: "dental",
    label: "Root canals",
    host: "dental.example",
    path: "/root-canals",
    business: "Example Family Dental",
    query: "root canal",
    reviews: [
      {
        author: "Sam T.",
        rating: 5,
        text: "I dreaded it for weeks, but the root canal itself was painless and over in under an hour. They called the next day to check on me.",
        match:
          "I dreaded it for weeks, but the root canal itself was painless and over in under an hour.",
      },
      {
        author: "Grace L.",
        rating: 5,
        text: "Cracked a molar on vacation. They fit me in that week for the root canal and explained every step before starting.",
        match:
          "They fit me in that week for the root canal and explained every step before starting.",
      },
      {
        author: "Omar B.",
        rating: 4,
        text: "Parking is tight. My tooth had throbbed for days, and after the treatment the pain was gone by morning.",
        match:
          "My tooth had throbbed for days, and after the treatment the pain was gone by morning.",
      },
    ],
  },
  {
    id: "kitchen",
    label: "Kitchen remodeling",
    host: "remodeling.example",
    path: "/kitchen-remodeling",
    business: "Example Home Remodeling",
    query: "kitchen remodel",
    reviews: [
      {
        author: "Hannah W.",
        rating: 5,
        text: "We finally tore out our 1970s kitchen. The new cabinets and counters came out exactly like the drawings.",
        match:
          "The new cabinets and counters came out exactly like the drawings.",
      },
      {
        author: "Marco D.",
        rating: 5,
        text: "They sent photos every evening. The renovation finished a week early, and friends still ask who did our kitchen.",
        match:
          "The renovation finished a week early, and friends still ask who did our kitchen.",
      },
      {
        author: "Jen P.",
        rating: 4,
        text: "Scheduling took a few tries. Once work started, the kitchen came together quickly and the tile work is spotless.",
        match:
          "Once work started, the kitchen came together quickly and the tile work is spotless.",
      },
    ],
  },
];
