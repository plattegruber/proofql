/**
 * The dashboard's own side of the Places bootstrap (#47): the search-box
 * validation and the resource route path. Everything shared with the
 * pipeline's 25-day refresh (#116) — response shapes, the mapper onto
 * `reviewInputSchema`, the key conventions, the client — lives in
 * `@proofql/google` (`packages/google/src/places.ts`); import it from
 * there. No I/O here, so the module is safe in the browser bundle.
 */
import { z } from "zod";

/** Search terms shorter than this are refused rather than sent to Google. */
export const PLACES_QUERY_MIN_LENGTH = 3;
export const PLACES_QUERY_MAX_LENGTH = 200;

export const placesSearchQuerySchema = z
  .string()
  .trim()
  .min(
    PLACES_QUERY_MIN_LENGTH,
    "Type at least three characters of the business name.",
  )
  .max(
    PLACES_QUERY_MAX_LENGTH,
    "Keep the search under two hundred characters.",
  );

/** The resource route both the onboarding card and the Import tab post to. */
export function placesActionPath(slug: string): string {
  return `/app/projects/${slug}/places`;
}
