/**
 * Pure project rules shared by the browser and the server (#37, #41): slug
 * derivation, origin normalization, and the zod schemas the actions parse
 * forms with. No I/O, so every rule is unit-testable (projects.test.ts).
 *
 * Form data arrives as strings; these schemas own the coercion.
 */
import { DEFAULT_SIMILARITY_FLOOR } from "@proofql/core";
import { z } from "zod";

// --- Slugs -----------------------------------------------------------------

export const SLUG_MAX_LENGTH = 48;

/** Lowercase words joined by single hyphens; no leading/trailing hyphen. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Slugs that would collide with a dashboard route under `/app/projects/`.
 * `new` is the create form (app/routes.ts); keep this in step with it.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(["new"]);

/** `"Cedar Ridge Dental"` → `"cedar-ridge-dental"`. Empty when nothing survives. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
}

export const projectNameSchema = z
  .string()
  .trim()
  .min(1, "Give the project a name.")
  .max(120, "Keep the name under 120 characters.");

export const projectSlugSchema = z
  .string()
  .trim()
  .min(1, "Give the project a slug.")
  .max(SLUG_MAX_LENGTH, `Keep the slug under ${SLUG_MAX_LENGTH} characters.`)
  .regex(SLUG_PATTERN, "Lowercase letters, numbers and hyphens only.")
  .refine((slug) => !RESERVED_SLUGS.has(slug), {
    message: "That slug is reserved.",
  });

export const createProjectSchema = z.object({
  name: projectNameSchema,
  slug: projectSlugSchema,
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

// --- Policy (#41) ------------------------------------------------------------

export const MIN_RATING_DEFAULT = 4;
export const MIN_RATING_OPTIONS = [1, 2, 3, 4, 5] as const;

export const SIMILARITY_FLOOR_DEFAULT = DEFAULT_SIMILARITY_FLOOR;
export const SIMILARITY_FLOOR_MIN = 0.3;
export const SIMILARITY_FLOOR_MAX = 0.9;
export const SIMILARITY_FLOOR_STEP = 0.01;

export const projectSettingsSchema = z.object({
  name: projectNameSchema,
  slug: projectSlugSchema,
  min_rating: z.coerce
    .number({ message: "Pick a minimum rating." })
    .int("Pick a whole-star rating.")
    .min(1, "Pick a rating between 1 and 5.")
    .max(5, "Pick a rating between 1 and 5."),
  similarity_floor: z.coerce
    .number({ message: "Enter a number." })
    .min(
      SIMILARITY_FLOOR_MIN,
      `Enter a value between ${SIMILARITY_FLOOR_MIN} and ${SIMILARITY_FLOOR_MAX}.`,
    )
    .max(
      SIMILARITY_FLOOR_MAX,
      `Enter a value between ${SIMILARITY_FLOOR_MIN} and ${SIMILARITY_FLOOR_MAX}.`,
    )
    // Two decimals is the input's step; stored as double precision.
    .transform((value) => Math.round(value * 100) / 100),
});

export type ProjectSettingsInput = z.infer<typeof projectSettingsSchema>;

// --- Allowed origins ---------------------------------------------------------

export type OriginResult =
  | { ok: true; origin: string }
  | { ok: false; message: string };

/**
 * Normalize user input to exactly `scheme://host[:port]`, the form the api
 * compares the request's `Origin` header against (scope.md §3). Accepts
 * http and https only, tolerates surrounding whitespace and one trailing
 * slash, and rejects anything with a path, query, hash or credentials —
 * `new URL(input).origin` must round-trip to the input, so a typo cannot
 * silently become a different origin.
 */
export function normalizeOrigin(input: string): OriginResult {
  // Scheme and host are case-insensitive, so compare in lowercase; a
  // trailing slash is the most common paste artefact and means nothing.
  const trimmed = input.trim().replace(/\/$/, "").toLowerCase();
  if (trimmed.length === 0) {
    return { ok: false, message: "Enter an origin, like https://example.com." };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      message: "Enter a full origin with its scheme, like https://example.com.",
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      message: "Origins must start with http:// or https://.",
    };
  }
  // Browsers omit the default port from `Origin`, so `https://a.example:443`
  // is stored as `https://a.example` — the form the api will compare.
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const withDefaultPort = `${url.origin}:${defaultPort}`;
  if (
    url.origin !== trimmed &&
    !(url.port === "" && withDefaultPort === trimmed)
  ) {
    return {
      ok: false,
      message:
        "Use just the scheme, host and port — no path, query or credentials.",
    };
  }
  return { ok: true, origin: url.origin };
}

/** The add-origin form field, normalized through `normalizeOrigin`. */
export const originSchema = z.object({
  origin: z.string().transform((value, ctx) => {
    const result = normalizeOrigin(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.message });
      return z.NEVER;
    }
    return result.origin;
  }),
});
