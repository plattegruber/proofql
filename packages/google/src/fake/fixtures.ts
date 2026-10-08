/**
 * Deterministic fixtures for the fake Google server.
 *
 * One Business Profile account with three locations — two verified, one
 * not — and ~120 reviews whose `createTime`s spread over two years and
 * whose `updateTime`s are mostly equal to `createTime` with a minority
 * edited later, so `orderBy=updateTime desc` and the per-location cursor
 * have something real to walk. The first few reviews of every location
 * pin the quirk matrix the adapter must survive: star-only, anonymous,
 * edited, replied (approved / pending / rejected with a policy violation),
 * and an unknown field Google might add tomorrow.
 *
 * Same seed ⇒ byte-identical data (mulberry32, fixed epoch, counters), so
 * a failing test reproduces exactly.
 */

import type {
  FakeAccount,
  FakeLocation,
  FakeReview,
  StarRating,
} from "./types.js";

/** Fixture timestamps hang off this instant, never the wall clock. */
export const FIXTURE_EPOCH = "2026-09-15T12:00:00.000Z";
const EPOCH_MS = Date.parse(FIXTURE_EPOCH);
const DAY_MS = 86_400_000;

export const FIXTURE_ACCOUNT: FakeAccount = {
  id: "100",
  accountName: "Cedar Ridge Dental Group",
};

export const FIXTURE_LOCATIONS: FakeLocation[] = [
  {
    id: "201",
    accountId: "100",
    title: "Cedar Ridge Dental — North",
    addressLines: ["1420 Cedar Ridge Pkwy"],
    locality: "Boulder",
    administrativeArea: "CO",
    postalCode: "80301",
    verified: true,
    placeId: "ChIJnorth0000000000000001",
    primaryCategory: "gcid:dentist",
  },
  {
    id: "202",
    accountId: "100",
    title: "Cedar Ridge Dental — South",
    addressLines: ["88 Table Mesa Dr", "Suite 210"],
    locality: "Boulder",
    administrativeArea: "CO",
    postalCode: "80305",
    verified: true,
    placeId: "ChIJsouth0000000000000002",
    primaryCategory: "gcid:dentist",
  },
  {
    id: "203",
    accountId: "100",
    title: "Cedar Ridge Dental — Lakeside (opening soon)",
    addressLines: ["5 Lakeside Ave"],
    locality: "Longmont",
    administrativeArea: "CO",
    postalCode: "80501",
    verified: false,
    placeId: "ChIJlake00000000000000003",
    primaryCategory: "gcid:dentist",
  },
];

/** Reviews per fixture location; 70 + 45 + 5 = 120. */
export const FIXTURE_REVIEW_COUNTS: Record<string, number> = {
  "201": 70,
  "202": 45,
  "203": 5,
};

/** mulberry32: a tiny seeded PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = [
  "Marcus",
  "Priya",
  "Elena",
  "Tom",
  "Aisha",
  "Jordan",
  "Wei",
  "Sofia",
  "Daniel",
  "Hannah",
  "Luis",
  "Grace",
  "Omar",
  "Nina",
  "Caleb",
  "Ruth",
];
const LAST_INITIALS = [
  "T.",
  "K.",
  "R.",
  "M.",
  "S.",
  "L.",
  "B.",
  "W.",
  "P.",
  "H.",
];

const POSITIVE = [
  "Dr. Patel did my implant and I honestly forgot it wasn't my own tooth within a week.",
  "The hygienist was gentle and explained every step before she did it.",
  "Front desk explained every charge before I paid. No surprises on the bill.",
  "Got me in the same day for a cracked molar and the crown fits perfectly.",
  "My kids actually look forward to their cleanings here, which says everything.",
  "Invisalign took eleven months and the result is exactly what they showed me on the scan.",
  "Parking behind the building was easy and the office runs on time.",
  "They caught a cavity my last dentist missed and fixed it painlessly.",
  "Whitening was done in one visit and the shade guide they used was spot on.",
  "Emergency root canal on a Saturday. Calm staff, numb in minutes, zero pain after.",
];
const MIDDLE = [
  "Good cleaning, but I waited twenty-five minutes past my appointment time.",
  "The work was fine. Billing took three calls to sort out an insurance code.",
  "Friendly staff, average experience, parking is tight at lunchtime.",
];
const NEGATIVE = [
  "The implant consult felt like a sales pitch and the quote was double what I was told on the phone.",
  "Waited forty minutes, then the hygienist rushed through the cleaning.",
  "They cancelled twice in one month. Found another dentist.",
];
const PHOTO_HOSTS = ["lh3.googleusercontent.com"];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

function ratingFor(random: () => number): StarRating {
  const r = random();
  if (r < 0.62) return "FIVE";
  if (r < 0.82) return "FOUR";
  if (r < 0.9) return "THREE";
  if (r < 0.96) return "TWO";
  return "ONE";
}

function commentFor(random: () => number, rating: StarRating): string {
  const pool =
    rating === "FIVE" || rating === "FOUR"
      ? POSITIVE
      : rating === "THREE"
        ? MIDDLE
        : NEGATIVE;
  const first = pick(random, pool);
  // Two sentences roughly a third of the time so the chunker gets windows.
  return random() < 0.35 ? `${first} ${pick(random, pool)}` : first;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Opaque, Google-looking review ids. */
function reviewIdFor(random: () => number): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < 28; i++)
    out += alphabet[Math.floor(random() * alphabet.length)];
  return out;
}

/**
 * Generate `count` reviews for one location. Quirk matrix on the first six
 * (when `count` allows): [0] star-only, [1] anonymous, [2] edited,
 * [3] replied APPROVED, [4] replied PENDING, [5] replied REJECTED with a
 * `policyViolation` and an extra unknown field.
 */
export function generateReviews(
  location: Pick<FakeLocation, "id" | "accountId">,
  count: number,
  seed: number,
): FakeReview[] {
  const random = mulberry32(seed);
  const reviews: FakeReview[] = [];
  for (let i = 0; i < count; i++) {
    const daysAgo = Math.floor(random() * 730); // two years
    const createMs =
      EPOCH_MS - daysAgo * DAY_MS - Math.floor(random() * DAY_MS);
    const rating = ratingFor(random);
    const id = reviewIdFor(random);
    const review: FakeReview = {
      name: `accounts/${location.accountId}/locations/${location.id}/reviews/${id}`,
      reviewId: id,
      reviewer: {
        displayName: `${pick(random, FIRST_NAMES)} ${pick(random, LAST_INITIALS)}`,
        profilePhotoUrl: `https://${pick(random, PHOTO_HOSTS)}/a/${id.slice(0, 12)}=s120-c`,
      },
      starRating: rating,
      comment: commentFor(random, rating),
      createTime: iso(createMs),
      updateTime: iso(createMs),
    };
    // Some edits: updateTime moves forward by days.
    if (random() < 0.12) {
      review.updateTime = iso(
        createMs + Math.floor(1 + random() * 60) * DAY_MS,
      );
    }
    switch (i) {
      case 0:
        delete review.comment; // star-only
        break;
      case 1:
        review.reviewer = { isAnonymous: true, displayName: "A Google user" };
        break;
      case 2:
        review.updateTime = iso(createMs + 14 * DAY_MS);
        review.comment = `${review.comment} (Edited: the follow-up visit went just as well.)`;
        break;
      case 3:
        review.reviewReply = {
          comment: "Thank you — we're glad the visit went smoothly.",
          updateTime: iso(createMs + 2 * DAY_MS),
          reviewReplyState: "APPROVED",
        };
        break;
      case 4:
        review.reviewReply = {
          comment: "Thanks for the feedback; we've shared it with the team.",
          updateTime: iso(createMs + DAY_MS),
          reviewReplyState: "PENDING",
        };
        break;
      case 5:
        review.reviewReply = {
          comment: "Call us for a discount on your next visit!",
          updateTime: iso(createMs + DAY_MS),
          reviewReplyState: "REJECTED",
          policyViolation: "SOLICITATION",
        };
        // A field Google added after this code was written.
        (review as unknown as Record<string, unknown>).reviewMediaItems = [];
        break;
      default:
        break;
    }
    reviews.push(review);
  }
  // Clamp any review that would land after the epoch (an edit on a recent review).
  for (const r of reviews) {
    if (Date.parse(r.updateTime) > EPOCH_MS) r.updateTime = FIXTURE_EPOCH;
  }
  return reviews;
}

export interface FixtureSet {
  accounts: FakeAccount[];
  locations: FakeLocation[];
  reviews: FakeReview[];
}

/** The default dataset: one account, three locations, 120 reviews. */
export function defaultFixtures(seed = 1): FixtureSet {
  const reviews: FakeReview[] = [];
  FIXTURE_LOCATIONS.forEach((location, index) => {
    reviews.push(
      ...generateReviews(
        location,
        FIXTURE_REVIEW_COUNTS[location.id] ?? 0,
        seed * 1000 + index,
      ),
    );
  });
  return {
    accounts: [FIXTURE_ACCOUNT],
    locations: [...FIXTURE_LOCATIONS],
    reviews,
  };
}
