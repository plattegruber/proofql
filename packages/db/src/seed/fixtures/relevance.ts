/**
 * The relevance fixture set (#138): the queries a dentist's website would
 * actually put in a snippet, labelled by hand against the Cedar Ridge demo
 * corpus in `./reviews.ts`, so the similarity floor can be tuned on real
 * `bge-m3` embeddings instead of the deterministic fake
 * (`scripts/tune-floor.ts`).
 *
 * Three kinds of query:
 *
 * - **positive**: the corpus holds publishable reviews that genuinely
 *   answer it. `expect` lists them (every review a visitor would accept as
 *   an answer, by reading the text, not by shared words). Many are
 *   paraphrases that share no vocabulary with the reviews they should hit
 *   ("scared of needles" → the anxiety and sedation reviews); those carry
 *   the `paraphrase` tag. `acceptable` lists borderline reviews that touch
 *   the topic in passing ("Knocked a star off for the parking"): returning
 *   one is not a false positive and missing one is not a miss.
 * - **negative**: in-domain — something a dental practice's page might ask
 *   — but nothing in the corpus answers it. Anything returned is a false
 *   positive. These are the queries that found the 0.55 floor too low
 *   (#137): unrelated short sentences in the same domain land at 0.55–0.60.
 * - **policy-filtered**: the only reviews on the topic are rated 1–3 or
 *   classified negative, so the policy gate hides every genuine answer.
 *   `expect` names those hidden reviews for the record; the correct answer
 *   is still `results: []`, because a glowing review about a different
 *   aspect of the same topic shown in place of the hidden ones is exactly
 *   the "irrelevant beats empty" failure the floor exists to prevent. A
 *   non-empty result at a floor counts as a failure, like a negative's.
 *
 * Labels are review keys from `./reviews.ts` (`g01`, `y03`, `c05`, …) in
 * the live environment only. `./relevance.test.ts` pins that every key
 * exists, that a positive's `expect` is publishable under the default
 * policy, and that a policy-filtered query's is not.
 *
 * The labels are a judgement, written by reading all 80 reviews; when the
 * corpus changes (a `SEED_VERSION` bump), re-read the affected queries.
 */

export type RelevanceKind = "positive" | "negative" | "policy-filtered";

export type RelevanceTag = "paraphrase" | "cross-language";

export interface RelevanceQuery {
  /** Stable id, `p01`/`n01`/`f01` by kind. */
  readonly id: string;
  readonly q: string;
  readonly kind: RelevanceKind;
  /**
   * positive: the publishable reviews that answer `q`. policy-filtered:
   * the hidden reviews that would. negative: empty.
   */
  readonly expect: readonly string[];
  /** Borderline reviews: neither a hit nor a false positive. */
  readonly acceptable?: readonly string[];
  readonly tags?: readonly RelevanceTag[];
  /** Why the labels are what they are, when it is not obvious. */
  readonly note?: string;
}

const POSITIVE: readonly Omit<RelevanceQuery, "kind">[] = [
  // ---- implants ------------------------------------------------------------
  {
    id: "p01",
    q: "dental implants",
    expect: ["g01", "g25", "g32", "g55", "g48", "c01"],
    acceptable: ["g59"],
    note: "g48 is about the implant's billing; still an implant patient's review. g59 is a bridge for lost teeth.",
  },
  {
    id: "p02",
    q: "what is Dr. Patel like for implant surgery",
    expect: ["g01", "g25", "g32", "g55", "c01"],
    acceptable: ["g48", "g21", "y06", "y08", "g09"],
    note: "The acceptable ones are Dr. Patel doing something other than an implant.",
  },
  {
    id: "p03",
    q: "replacing a missing tooth",
    expect: ["g01", "g25", "g32", "g55", "g59"],
    acceptable: ["c01", "g48", "y01"],
    tags: ["paraphrase"],
  },
  // ---- Invisalign ----------------------------------------------------------
  {
    id: "p04",
    q: "Invisalign",
    expect: ["g04", "g16", "g37", "g53", "y03", "c09"],
  },
  {
    id: "p05",
    q: "straightening my teeth without metal braces",
    expect: ["g04", "g16", "g37", "g53", "y03", "c09"],
    tags: ["paraphrase"],
  },
  {
    id: "p06",
    q: "clear aligners for a teenager",
    expect: ["g37"],
    acceptable: ["g04", "g16", "g53", "y03", "c09", "y12"],
    tags: ["paraphrase"],
    note: "Only g37 is about a teen (Invisalign Teen); the other Invisalign reviews are adults.",
  },
  // ---- anxiety and sedation ------------------------------------------------
  {
    id: "p07",
    q: "scared of needles and terrified of the dentist",
    expect: ["g09", "g40", "g43", "c05", "y12"],
    acceptable: ["y08", "g32", "g52"],
    tags: ["paraphrase"],
    note: "No review mentions needles; the anxiety reviews are the answer.",
  },
  {
    id: "p08",
    q: "sedation options for anxious patients",
    expect: ["g09", "g32", "y08", "c05", "g40"],
    acceptable: ["g43"],
  },
  {
    id: "p09",
    q: "being put to sleep for an extraction",
    expect: ["y08", "g09", "g32"],
    acceptable: ["c05", "g40"],
    tags: ["paraphrase"],
    note: "IV sedation (y08), nitrous during an extraction (g09), oral sedation (g32).",
  },
  // ---- kids ----------------------------------------------------------------
  {
    id: "p10",
    q: "pediatric dentist for my toddler",
    expect: ["g10", "g27", "g45", "c04", "g63", "y05"],
    acceptable: ["g17", "y14", "g37", "y12"],
  },
  {
    id: "p11",
    q: "my kid is nervous about the dentist",
    expect: ["g27", "g45", "g10", "c04", "g63", "y12"],
    acceptable: ["y05", "g17", "y14"],
    tags: ["paraphrase"],
  },
  // ---- hygienists and cleanings --------------------------------------------
  {
    id: "p12",
    q: "gentle hygienist",
    expect: ["g02", "g12", "g22", "g29", "g33", "g52", "y01", "g47", "g58"],
    acceptable: ["g03", "y05", "g42", "c08", "g43", "y14", "g09"],
  },
  {
    id: "p13",
    q: "a deep cleaning that didn't hurt",
    expect: ["g12", "g33", "g52", "g02"],
    acceptable: ["g22", "g29", "g47", "g58", "y01", "g03", "g43", "c08"],
    tags: ["paraphrase"],
  },
  // ---- parking and hours ---------------------------------------------------
  {
    id: "p14",
    q: "free parking",
    expect: ["g15", "g25", "g44", "y02", "c09", "y14"],
    acceptable: ["g56", "g03", "g26", "y07", "g60", "g04", "g43"],
    note: "The acceptable ones are downtown parking complaints inside 4–5 star reviews.",
  },
  {
    id: "p15",
    q: "is parking difficult at the downtown office",
    expect: ["g03", "g26", "y07", "g60", "g04", "g43"],
    acceptable: ["g15", "g44", "y02", "g25", "c09", "y14"],
  },
  {
    id: "p16",
    q: "Saturday appointments",
    expect: ["g05", "g25", "g44", "y14"],
    acceptable: ["g21", "g51"],
    note: "g21 is a Sunday emergency; g51 an evening one.",
  },
  // ---- emergencies ---------------------------------------------------------
  {
    id: "p17",
    q: "dental emergency after hours",
    expect: ["g05", "g21", "g51", "y06", "c10", "y14"],
  },
  {
    id: "p18",
    q: "chipped my tooth over the weekend",
    expect: ["g05", "g51", "y14"],
    acceptable: ["g21", "y06", "c10"],
    tags: ["paraphrase"],
  },
  // ---- insurance, billing, pricing -----------------------------------------
  {
    id: "p19",
    q: "do they take my insurance",
    expect: ["g07", "g19", "g35", "g48", "y11", "g32"],
    acceptable: ["y03", "y14", "g56", "c01"],
  },
  {
    id: "p20",
    q: "payment plans and transparent pricing",
    expect: ["g04", "g20", "g25", "c09", "g48", "g35", "g32", "c01", "y14"],
    acceptable: ["g19", "g08"],
  },
  {
    id: "p21",
    q: "no surprise bills",
    expect: ["g48", "g35", "g32", "g20", "y14", "g19"],
    acceptable: ["g04", "g25", "c09", "c01"],
    tags: ["paraphrase"],
  },
  // ---- front desk ----------------------------------------------------------
  {
    id: "p22",
    q: "friendly and helpful front desk staff",
    expect: ["g07", "g17", "y11", "c10", "g09", "g56", "g43"],
    acceptable: ["g03", "g04", "y14", "c08", "c02", "y02"],
  },
  // ---- cosmetic ------------------------------------------------------------
  {
    id: "p23",
    q: "teeth whitening",
    expect: ["g24", "y13"],
    acceptable: ["g08", "g49"],
  },
  {
    id: "p24",
    q: "veneers",
    expect: ["g49"],
    acceptable: ["g24", "y13"],
  },
  // ---- restorative ---------------------------------------------------------
  {
    id: "p25",
    q: "crown done in one visit",
    expect: ["g41"],
    acceptable: ["g05", "y06", "y10", "g19", "y14"],
  },
  {
    id: "p26",
    q: "root canal",
    expect: ["g14", "y10"],
    acceptable: ["g41"],
  },
  {
    id: "p27",
    q: "painless fillings",
    expect: ["g30", "g60", "g27", "c04"],
    acceptable: ["g08", "g29"],
  },
  {
    id: "p28",
    q: "night guard for grinding my teeth",
    expect: ["g38"],
    acceptable: ["y06"],
  },
  {
    id: "p29",
    q: "a bridge after losing teeth",
    expect: ["g59", "y01"],
    acceptable: ["g01", "g25", "g55"],
  },
  // ---- access and service --------------------------------------------------
  {
    id: "p30",
    q: "wheelchair accessible office for my elderly mother",
    expect: ["g56"],
  },
  {
    id: "p31",
    q: "a dentist who doesn't upsell",
    expect: ["g08", "g26", "g42", "g53", "g20"],
    acceptable: ["g61", "g43", "c01"],
    tags: ["paraphrase"],
  },
  {
    id: "p32",
    q: "online booking and appointment reminders",
    expect: ["c02"],
    acceptable: ["g58", "g07"],
  },
  {
    id: "p33",
    q: "first visit as a new patient",
    expect: ["g61", "g58", "g43", "g10"],
    acceptable: ["y14", "g29", "c08"],
  },
  {
    id: "p34",
    q: "3D scan instead of impressions",
    expect: ["g04", "g25", "c09"],
    acceptable: ["g41", "g32", "g61"],
  },
  {
    id: "p35",
    q: "wisdom teeth removal",
    expect: ["y08"],
    acceptable: ["g09", "g63"],
    note: "g39 (nitrous for a wisdom tooth extraction) is 3 stars and hidden.",
  },
  // ---- cross-language (scope.md §8: verify before claiming) -----------------
  {
    id: "p36",
    q: "¿Aceptan mi seguro dental?",
    expect: ["g07", "g19", "g35", "g48", "y11", "g32"],
    acceptable: ["y03", "y14", "g56", "c01"],
    tags: ["cross-language"],
    note: "Spanish for p19. Reported separately; not part of the recommendation.",
  },
  {
    id: "p37",
    q: "Zahnarzt für ängstliche Patienten",
    expect: ["g09", "g40", "g43", "c05", "y12"],
    acceptable: ["y08", "g32", "g52"],
    tags: ["cross-language"],
    note: "German for 'dentist for anxious patients'. Reported separately.",
  },
];

const NEGATIVE: readonly Omit<RelevanceQuery, "kind" | "expect">[] = [
  { id: "n01", q: "orthodontic headgear" },
  { id: "n02", q: "dental tourism abroad" },
  { id: "n03", q: "the lobby coffee kiosk swallowed my coins" },
  { id: "n04", q: "the office dog greets patients" },
  { id: "n05", q: "laser gum surgery" },
  { id: "n06", q: "tongue tie release for my newborn" },
  { id: "n07", q: "oral cancer screening" },
  { id: "n08", q: "Spanish-speaking staff" },
  { id: "n09", q: "vending machine in the waiting room" },
  { id: "n10", q: "which electric toothbrush do they recommend" },
  { id: "n11", q: "fluoride-free treatment for my kids" },
  { id: "n12", q: "jaw surgery for TMJ" },
  { id: "n13", q: "dental school student clinic discount" },
  { id: "n14", q: "charging station for electric cars in the lot" },
  { id: "n15", q: "they lost my dental records when I moved" },
  { id: "n16", q: "the lobby aquarium" },
  { id: "n17", q: "mouthwash samples" },
];

const POLICY_FILTERED: readonly Omit<RelevanceQuery, "kind">[] = [
  {
    id: "f01",
    q: "sent me to collections over a disputed crown bill",
    expect: ["g13"],
  },
  {
    id: "f02",
    q: "they lost my appointment and I drove home",
    expect: ["g18"],
  },
  {
    id: "f03",
    q: "the appointment ran so late my child had a meltdown",
    expect: ["g34", "c07"],
  },
  {
    id: "f04",
    q: "the next emergency slot was nine days away",
    expect: ["g28"],
    note: "The 4–5 star emergency reviews say the opposite; showing them under this heading is the failure.",
  },
  {
    id: "f05",
    q: "quoted one price and billed another",
    expect: ["c03", "c06", "y04"],
  },
];

/** Every labelled query, positives first. */
export const RELEVANCE_QUERIES: readonly RelevanceQuery[] = [
  ...POSITIVE.map((query) => ({ ...query, kind: "positive" as const })),
  ...NEGATIVE.map((query) => ({
    ...query,
    kind: "negative" as const,
    expect: [],
  })),
  ...POLICY_FILTERED.map((query) => ({
    ...query,
    kind: "policy-filtered" as const,
  })),
];
