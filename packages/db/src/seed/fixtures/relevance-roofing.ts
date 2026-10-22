/**
 * A second relevance fixture set (#151): a roofer's reviews and the
 * queries a roofer's website would put in a snippet, labelled by hand the
 * same way as the dental set in `./relevance.ts`. It is **not seeded**;
 * `scripts/floor-local.ts` loads it into a scratch project on a local
 * database to measure the floor for a non-dental category, offline.
 *
 * Why roofing: the generic query words used to be a dental constant, so a
 * roofer's "roof", "roofing" and "roofer" counted as evidence even though
 * nearly every one of its reviews says them. The negatives below are
 * shaped to catch exactly that: a category word plus a specific word no
 * review answers ("copper roof", "roof coating"). The positives include
 * the short keyword queries the partial word match exists for ("roof
 * repair company", "metal roofing").
 *
 * Kinds and label rules are the dental set's (`RelevanceQuery`): a
 * positive's `expect` is every publishable review a visitor would accept
 * as an answer, by reading it; a negative must return nothing. Ids are
 * `rp01` / `rn01`. Ratings 2 and 3 (r25, r26) are below the default
 * `min_rating` 4 and never publish.
 */

import type { RelevanceQuery } from "./relevance.js";

export interface RoofingReviewFixture {
  /** Stable key, `r01`…; labels reference it. */
  readonly key: string;
  readonly rating: 1 | 2 | 3 | 4 | 5;
  readonly text: string;
}

/** The business the reviews are about; fiction. */
export const ROOFING_BUSINESS_NAME = "Summit Peak Roofing";

export const ROOFING_REVIEWS: readonly RoofingReviewFixture[] = [
  {
    key: "r01",
    rating: 5,
    text: "Summit Peak replaced our entire roof in two days after the hail storm. The crew was polite and cleaned up every nail.",
  },
  {
    key: "r02",
    rating: 5,
    text: "They found the leak around our chimney flashing that two other roofers missed. No more water stains on the ceiling.",
  },
  {
    key: "r03",
    rating: 5,
    text: "Great roofing company. Fair price, clear estimate, and the new shingles look fantastic.",
  },
  {
    key: "r04",
    rating: 4,
    text: "Our insurance claim for hail damage was a nightmare until Jake met the adjuster on the roof and documented everything. Claim approved.",
  },
  {
    key: "r05",
    rating: 5,
    text: "Installed seamless gutters and downspouts along with the new roof. Water finally drains away from the foundation.",
  },
  {
    key: "r06",
    rating: 5,
    text: "Metal roof install on our cabin. Standing seam, looks beautiful, and it handled the first big snow perfectly.",
  },
  {
    key: "r07",
    rating: 5,
    text: "They repaired a few missing shingles after the windstorm the same week I called. Small job, but they treated it like a big one.",
  },
  {
    key: "r08",
    rating: 4,
    text: "Good work on the roof replacement, but scheduling slipped by a week because of rain. They kept us updated by text the whole time.",
  },
  {
    key: "r09",
    rating: 5,
    text: "The crew ran magnetic sweepers over the yard afterward and we didn't find a single nail. Our dog thanks them.",
  },
  {
    key: "r10",
    rating: 5,
    text: "The free inspection was thorough, with photos of every problem area. They told us the roof had five more years and didn't try to upsell.",
  },
  {
    key: "r11",
    rating: 5,
    text: "The flat roof on our commercial building was ponding water. They regraded it and put down a new TPO membrane. Dry ever since.",
  },
  {
    key: "r12",
    rating: 5,
    text: "Ventilation was the real problem: our attic was baking. They added ridge vents and the upstairs is ten degrees cooler.",
  },
  {
    key: "r13",
    rating: 4,
    text: "The price was a bit higher than another bid, but the warranty is 25 years on workmanship, which sold us.",
  },
  {
    key: "r14",
    rating: 5,
    text: "They put an emergency tarp on at 11 pm during a storm when a tree branch punched through. Can't thank them enough.",
  },
  {
    key: "r15",
    rating: 5,
    text: "Our skylight leaked every spring. They replaced the flashing and resealed it, problem solved.",
  },
  {
    key: "r16",
    rating: 5,
    text: "Communication was excellent. The project manager answered every call and sent a daily summary with photos.",
  },
  {
    key: "r17",
    rating: 5,
    text: "We got three quotes and theirs was the most detailed: materials, tear-off, disposal and permits, all itemized.",
  },
  {
    key: "r18",
    rating: 5,
    text: "They pulled the permit and handled the city inspection, so we never had to deal with it.",
  },
  {
    key: "r19",
    rating: 4,
    text: "Nice job on the cedar shake repair. Matching old weathered shakes isn't easy and you can barely tell.",
  },
  {
    key: "r20",
    rating: 5,
    text: "Ice dams used to wreck our gutters every winter. They installed heat cables and an ice and water shield. Not one dam this year.",
  },
  {
    key: "r21",
    rating: 5,
    text: "Our HOA required a specific shingle color, and they sorted out the approval paperwork with the board for us.",
  },
  {
    key: "r22",
    rating: 5,
    text: "Financing through their partner made a new roof possible for us this year instead of patching it again.",
  },
  {
    key: "r23",
    rating: 5,
    text: "The crew showed up at 7 sharp, worked quietly around our sleeping newborn, and was gone by 4 each day.",
  },
  {
    key: "r24",
    rating: 5,
    text: "They replaced rotten fascia and soffit boards along with the gutters. Woodpeckers had done a number on them.",
  },
  {
    key: "r25",
    rating: 2,
    text: "The roof itself is fine, but they left shingle scraps in the flower beds and it took two calls to get someone back.",
  },
  {
    key: "r26",
    rating: 3,
    text: "It took over a month to get on the schedule. The work was good once they started.",
  },
  {
    key: "r27",
    rating: 5,
    text: "Two of the crew spoke Spanish, which made it much easier for my parents to understand the estimate.",
  },
  {
    key: "r28",
    rating: 5,
    text: "Chimney cap and new flashing installed, and they repointed the brick above the roofline too.",
  },
  {
    key: "r29",
    rating: 5,
    text: "Honest roofers. They told us we only needed a repair, not a full replacement, and saved us thousands.",
  },
  {
    key: "r30",
    rating: 4,
    text: "Solid work on the garage roof. A little noisy, obviously, but done in one day.",
  },
  {
    key: "r31",
    rating: 5,
    text: "Asphalt shingle replacement on a steep two-story roof. They used harnesses and roof jacks and looked very safe.",
  },
  {
    key: "r32",
    rating: 5,
    text: "Hail dented our gutters and bruised the shingles; they handled the whole thing, including the claim.",
  },
];

const POSITIVE: readonly Omit<RelevanceQuery, "kind">[] = [
  {
    id: "rp01",
    q: "roof repair company",
    expect: ["r02", "r07", "r15", "r19", "r29"],
    acceptable: ["r14", "r28", "r11"],
    note: "Repairs, not replacements; the tarp and the chimney work are repair-adjacent.",
  },
  {
    id: "rp02",
    q: "roof leak",
    expect: ["r02", "r15"],
    acceptable: ["r11", "r14"],
  },
  {
    id: "rp03",
    q: "hail damage insurance claim",
    expect: ["r04", "r32"],
    acceptable: ["r01"],
  },
  { id: "rp04", q: "metal roofing", expect: ["r06"] },
  {
    id: "rp05",
    q: "gutter installation",
    expect: ["r05", "r20", "r24"],
    acceptable: ["r32"],
  },
  {
    id: "rp06",
    q: "roofer that cleans up the nails",
    expect: ["r01", "r09"],
  },
  {
    id: "rp07",
    q: "flat roof for a commercial building",
    expect: ["r11"],
  },
  { id: "rp08", q: "attic ventilation", expect: ["r12"] },
  {
    id: "rp09",
    q: "roof replacement warranty",
    expect: ["r13"],
    acceptable: ["r08", "r29", "r31"],
  },
  {
    id: "rp10",
    q: "emergency storm tarp",
    expect: ["r14"],
    acceptable: ["r07"],
  },
  {
    id: "rp11",
    q: "good communication during the project",
    expect: ["r16", "r08"],
  },
  {
    id: "rp12",
    q: "detailed itemized estimate",
    expect: ["r17"],
    acceptable: ["r03", "r27"],
  },
  { id: "rp13", q: "ice dams", expect: ["r20"] },
  { id: "rp14", q: "roofing financing", expect: ["r22"] },
  { id: "rp15", q: "chimney flashing", expect: ["r02", "r28"] },
  { id: "rp16", q: "cedar shake roof repair", expect: ["r19"] },
  {
    id: "rp17",
    q: "honest roofer who didn't upsell",
    expect: ["r10", "r29"],
  },
  { id: "rp18", q: "HOA approval for shingle color", expect: ["r21"] },
  { id: "rp19", q: "crew that speaks Spanish", expect: ["r27"] },
  { id: "rp20", q: "soffit and fascia replacement", expect: ["r24"] },
  { id: "rp21", q: "skylight leak", expect: ["r15"] },
  { id: "rp22", q: "permit and city inspection", expect: ["r18"] },
  { id: "rp23", q: "safe crew on a steep roof", expect: ["r31"] },
  {
    id: "rp24",
    q: "roof inspection",
    expect: ["r10"],
    acceptable: ["r04", "r18"],
  },
  {
    id: "rp25",
    q: "water coming through the ceiling",
    expect: ["r02"],
    acceptable: ["r14", "r15"],
    tags: ["paraphrase"],
  },
  {
    id: "rp26",
    q: "workers were respectful of our family",
    expect: ["r23"],
    acceptable: ["r09", "r27"],
    tags: ["paraphrase"],
  },
];

/**
 * In-domain for a roofer, answered by no review. Most pair a category word
 * with a specific one, so a review counts as a word match only through the
 * category word.
 */
const NEGATIVE: readonly Omit<RelevanceQuery, "kind" | "expect">[] = [
  { id: "rn01", q: "solar roof" },
  { id: "rn02", q: "slate roofing" },
  { id: "rn03", q: "green roof garden" },
  { id: "rn04", q: "roof painting" },
  { id: "rn05", q: "rubber roof" },
  { id: "rn06", q: "roof moss cleaning" },
  { id: "rn07", q: "roofing contractor in Boulder" },
  { id: "rn08", q: "mobile home roof" },
  { id: "rn09", q: "roof coating" },
  { id: "rn10", q: "Sunday roofing appointments" },
  { id: "rn11", q: "roof replacement cost per square foot" },
  { id: "rn12", q: "copper roof" },
  { id: "rn13", q: "tile roof" },
  { id: "rn14", q: "roofing company owner" },
];

export const ROOFING_QUERIES: readonly RelevanceQuery[] = [
  ...POSITIVE.map((q) => ({ ...q, kind: "positive" as const })),
  ...NEGATIVE.map((q) => ({ ...q, kind: "negative" as const, expect: [] })),
];
