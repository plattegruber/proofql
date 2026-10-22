// Client-safe pieces of the Google Takeout import: the route path, the
// how-to steps the import page and onboarding show, and the honest numbers
// behind the progress copy.
import { importPath } from "./import-paths";

export function takeoutPath(slug: string): string {
  return `${importPath(slug)}/takeout`;
}

/**
 * How to export, as it reads on takeout.google.com (checked 2026-10-08:
 * the "Deselect all" button, the product "Google Business Profile — All
 * data related to your business.", "Next step", then "Create export"; the
 * archive link arrives by email and expires after about 7 days, per
 * Google's "How to download your Google data" help page).
 */
export const TAKEOUT_STEPS = [
  {
    label: "Open takeout.google.com",
    detail: "Signed in as an owner or manager of the Business Profile.",
  },
  {
    label: "Select Deselect all",
    detail: "Then tick only Google Business Profile.",
  },
  {
    label: "Select Next step, then Create export",
    detail:
      "Keep the file type .zip. Google emails a download link, usually the same day; it expires after about a week.",
  },
  {
    label: "Choose the .zip here",
    detail:
      "Every part, if Google split it. Only the reviews are read, in your browser; photos are never uploaded.",
  },
] as const;

export const TAKEOUT_URL = "https://takeout.google.com/";

/**
 * Reviews the Workers Free plan can index per day: 10,000 Queues
 * operations at three per review (docs/launch.md §16). Past it, reviews
 * are stored at once and indexed after 00:00 UTC by the sweep.
 */
export const DAILY_INDEXING_CAPACITY = 3_300;

/** "about 3 days" for an import past the daily indexing capacity, else null. */
export function indexingDaysEstimate(reviews: number): number | null {
  if (reviews <= DAILY_INDEXING_CAPACITY) return null;
  return Math.ceil(reviews / DAILY_INDEXING_CAPACITY);
}
