/**
 * Business categories and the query words each makes generic (#151).
 *
 * The floor's partial word match (#147, `lexicalMatchSql` in `@proofql/db`)
 * ignores *generic* words when it counts how many of a query's words a
 * review contains: words a searcher uses about the kind of business, which
 * say nothing about which review answers. "roof repair company" on a
 * roofer's page has one word of evidence, "repair"; "roof" and "company"
 * would match nearly every review the roofer has. Reviews rarely repeat
 * the category words often enough for document frequency to find them
 * (#149, #150 measured worse), so they come from the category.
 *
 * - **The universal list** applies to every project: words about reviews
 *   and businesses in general.
 * - **The table** maps a category to its own words and to the Google
 *   types that mean it (Places `primaryType`, Business Profile
 *   `categories.primaryCategory`), so an import can set the category.
 *   `projects.category` holds a key of this table, or null; null and any
 *   key this build does not know get the universal list only.
 *
 * Words are written plainly; Postgres stems them with the corpus's English
 * config at query time, so "roofing" and "roof" are one lexeme and plurals
 * need no entry of their own unless they stem differently ("roofer").
 *
 * Adding a category: one entry below, with words a searcher says about the
 * category (not services it offers: "repair" for a roofer, "implants" for
 * a dentist are evidence), and the Google types that mean it. The test
 * file pins the structural rules. Changing `dental` changes the demo
 * project's measured numbers (`docs/performance.md` §5); re-run
 * `pnpm db:tune-floor -- --annotate … --category dental` first.
 */

/** Generic for every project, whatever its category. */
export const UNIVERSAL_GENERIC_WORDS: readonly string[] = [
  "review",
  "reviews",
  "company",
  "service",
  "business",
  "office",
  "team",
];

export interface CategoryEntry {
  /** What the Settings picker shows. */
  readonly label: string;
  /** Generic words added to {@link UNIVERSAL_GENERIC_WORDS} for this category. */
  readonly words: readonly string[];
  /**
   * Google types that mean this category: Places API (New) `primaryType`
   * values and Business Profile category ids (without `gcid:`), which
   * share most names.
   */
  readonly googleTypes: readonly string[];
}

/**
 * The category table. Keys are what `projects.category` stores; keep them
 * stable (renaming one orphans the stored value, which then falls back to
 * the universal list).
 */
export const CATEGORY_TABLE = {
  dental: {
    label: "Dental",
    // Exactly the #147 list minus the universal words: the demo project's
    // effective list must not change (docs/performance.md §5).
    words: ["dental", "dentist", "teeth"],
    googleTypes: ["dentist", "dental_clinic", "cosmetic_dentist"],
  },
  roofing: {
    label: "Roofing",
    words: ["roof", "roofing", "roofer", "roofers", "contractor"],
    googleTypes: ["roofing_contractor"],
  },
  plumbing: {
    label: "Plumbing",
    words: ["plumber", "plumbers", "plumbing"],
    googleTypes: ["plumber"],
  },
  hvac: {
    label: "Heating and air conditioning",
    words: ["hvac", "heating", "cooling", "air", "conditioning", "contractor"],
    googleTypes: [
      "hvac_contractor",
      "air_conditioning_contractor",
      "heating_contractor",
    ],
  },
  electrical: {
    label: "Electrician",
    words: ["electrician", "electricians", "electrical", "electric"],
    googleTypes: ["electrician", "electrical_contractor"],
  },
  remodeling: {
    label: "Remodeling and contracting",
    words: [
      "remodel",
      "remodeling",
      "remodeler",
      "renovation",
      "contractor",
      "construction",
      "builder",
      "home",
    ],
    googleTypes: [
      "general_contractor",
      "remodeler",
      "kitchen_remodeler",
      "bathroom_remodeler",
      "construction_company",
      "home_builder",
    ],
  },
  legal: {
    label: "Legal",
    words: [
      "lawyer",
      "lawyers",
      "attorney",
      "attorneys",
      "law",
      "firm",
      "legal",
    ],
    googleTypes: ["lawyer", "law_firm", "attorney"],
  },
  medical: {
    label: "Medical",
    words: ["doctor", "doctors", "physician", "medical", "clinic"],
    googleTypes: [
      "doctor",
      "medical_clinic",
      "medical_center",
      "hospital",
      "family_practice_physician",
    ],
  },
  veterinary: {
    label: "Veterinary",
    words: [
      "vet",
      "vets",
      "veterinarian",
      "veterinary",
      "animal",
      "pet",
      "clinic",
    ],
    googleTypes: ["veterinary_care", "veterinarian", "animal_hospital"],
  },
  salon: {
    label: "Salon and barber",
    words: ["salon", "hair", "stylist", "barber", "beauty"],
    googleTypes: [
      "hair_salon",
      "hair_care",
      "beauty_salon",
      "barber_shop",
      "nail_salon",
    ],
  },
  fitness: {
    label: "Gym and fitness",
    words: ["gym", "fitness", "club", "workout"],
    googleTypes: ["gym", "fitness_center"],
  },
  restaurant: {
    label: "Restaurant",
    // Every `*_restaurant` type maps here too (`categoryFromGoogleType`).
    words: ["restaurant", "food", "dining", "eat"],
    googleTypes: ["restaurant", "meal_takeaway", "meal_delivery"],
  },
  cafe: {
    label: "Café and coffee shop",
    words: ["cafe", "café", "coffee", "shop"],
    googleTypes: ["cafe", "coffee_shop"],
  },
  auto_repair: {
    label: "Auto repair",
    words: ["mechanic", "mechanics", "auto", "car", "cars", "shop", "garage"],
    googleTypes: ["car_repair", "auto_repair_shop", "mechanic"],
  },
  real_estate: {
    label: "Real estate",
    words: [
      "realtor",
      "realtors",
      "agent",
      "real",
      "estate",
      "realty",
      "broker",
    ],
    googleTypes: ["real_estate_agency", "real_estate_agent"],
  },
} as const satisfies Record<string, CategoryEntry>;

export type BusinessCategory = keyof typeof CATEGORY_TABLE;

/** Every category key, in table order (the Settings picker's order). */
export const BUSINESS_CATEGORIES = Object.keys(
  CATEGORY_TABLE,
) as BusinessCategory[];

export function isBusinessCategory(value: unknown): value is BusinessCategory {
  return typeof value === "string" && Object.hasOwn(CATEGORY_TABLE, value);
}

const BY_GOOGLE_TYPE: ReadonlyMap<string, BusinessCategory> = new Map(
  BUSINESS_CATEGORIES.flatMap((category) =>
    CATEGORY_TABLE[category].googleTypes.map(
      (type) => [type, category] as const,
    ),
  ),
);

/**
 * The category a Google type means, or null when the table has none.
 * Accepts a Places `primaryType` (`roofing_contractor`) and a Business
 * Profile category name (`categories/gcid:roofing_contractor`, or bare
 * `gcid:…`); any `*_restaurant` type is a restaurant.
 */
export function categoryFromGoogleType(
  type: string | null | undefined,
): BusinessCategory | null {
  if (!type) return null;
  const bare = type
    .trim()
    .toLowerCase()
    .replace(/^categories\//, "")
    .replace(/^gcid:/, "");
  const known = BY_GOOGLE_TYPE.get(bare);
  if (known !== undefined) return known;
  if (bare.endsWith("_restaurant")) return "restaurant";
  return null;
}

/**
 * The generic words for a project's category: the universal list plus the
 * category's own, deduplicated, space-separated (the form
 * `lexicalMatchSql` stems). Null or an unknown category gets the universal
 * list only.
 */
export function genericQueryWords(category: string | null | undefined): string {
  const own: readonly string[] = isBusinessCategory(category)
    ? CATEGORY_TABLE[category].words
    : [];
  return [...new Set([...UNIVERSAL_GENERIC_WORDS, ...own])].join(" ");
}
