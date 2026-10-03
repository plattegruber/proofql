/**
 * Zod schemas for the Google Business Profile payloads the connector reads.
 *
 * Posture (well-regarded ADR 0002, #125 adjustment): **tolerate unknown
 * fields, reject unknown vocabulary.** Google added `reviewReplyState`,
 * `policyViolation` and `reviewMediaItems` to the v4 review in one year; a
 * strict object would have broken three times. Every object here is
 * `z.looseObject`, so new fields pass through. The `starRating` lookup is
 * total over `ONE`..`FIVE`: anything else — including Google's own
 * `STAR_RATING_UNSPECIFIED` — fails the review loudly rather than storing
 * a garbage rating.
 *
 * proto3 omits empty fields, so optionals are everywhere: a star-only
 * review has no `comment`, an anonymised reviewer may have no `reviewer`,
 * an empty page has no `reviews`.
 */

import { z } from "zod";

/** v4 `starRating` → number, total over the ratable values only. */
export const GBP_STAR_RATING_VALUES = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
} as const;

export type GbpStarRating = keyof typeof GBP_STAR_RATING_VALUES;

const starRatingSchema = z.enum(
  Object.keys(GBP_STAR_RATING_VALUES) as [GbpStarRating, ...GbpStarRating[]],
);

/** v4 review resource name: `accounts/{a}/locations/{l}/reviews/{r}`. */
export const GBP_REVIEW_NAME_PATTERN =
  /^accounts\/[^/]+\/locations\/[^/]+\/reviews\/[^/]+$/;

export const gbpReviewerSchema = z.looseObject({
  displayName: z.string().optional(),
  isAnonymous: z.boolean().optional(),
  profilePhotoUrl: z.string().optional(),
});

export const gbpReviewReplySchema = z.looseObject({
  comment: z.string().optional(),
  updateTime: z.iso.datetime({ offset: true }).optional(),
  /** Moderation verdict; a string, not an enum — new states must not reject the review. */
  reviewReplyState: z.string().optional(),
  policyViolation: z.string().optional(),
});

export const gbpReviewSchema = z.looseObject({
  name: z.string().regex(GBP_REVIEW_NAME_PATTERN),
  reviewId: z.string().optional(),
  reviewer: gbpReviewerSchema.optional(),
  starRating: starRatingSchema,
  /** Absent for star-only reviews. */
  comment: z.string().optional(),
  createTime: z.iso.datetime({ offset: true }),
  updateTime: z.iso.datetime({ offset: true }),
  reviewReply: gbpReviewReplySchema.optional(),
});

export type GbpReview = z.infer<typeof gbpReviewSchema>;

/** v4 `reviews.list` response body. */
export const gbpReviewsPageSchema = z.looseObject({
  reviews: z.array(z.unknown()).optional(),
  averageRating: z.number().optional(),
  totalReviewCount: z.number().optional(),
  nextPageToken: z.string().optional(),
});

export type GbpReviewsPage = z.infer<typeof gbpReviewsPageSchema>;

/** Account Management v1 `accounts.list`. */
export const gbpAccountSchema = z.looseObject({
  /** `accounts/{id}`. */
  name: z.string().min(1),
  accountName: z.string().optional(),
  type: z.string().optional(),
});
export type GbpAccount = z.infer<typeof gbpAccountSchema>;

export const gbpAccountsPageSchema = z.looseObject({
  accounts: z.array(gbpAccountSchema).optional(),
  nextPageToken: z.string().optional(),
});

export const gbpPostalAddressSchema = z.looseObject({
  addressLines: z.array(z.string()).optional(),
  locality: z.string().optional(),
  administrativeArea: z.string().optional(),
  postalCode: z.string().optional(),
  regionCode: z.string().optional(),
});

/**
 * Business Information v1 `Location`, under the discovery `readMask`
 * (`name,title,storefrontAddress,metadata`). `name` is `locations/{id}` —
 * NOT account-scoped; the v4 reviews path needs the account from the
 * listing call. Verified status: `metadata.hasVoiceOfMerchant` — the fake
 * models it; confirm against the real API (docs/google.md).
 */
export const gbpLocationSchema = z.looseObject({
  name: z.string().min(1),
  title: z.string().optional(),
  storefrontAddress: gbpPostalAddressSchema.optional(),
  metadata: z
    .looseObject({
      hasVoiceOfMerchant: z.boolean().optional(),
      placeId: z.string().optional(),
      mapsUri: z.string().optional(),
    })
    .optional(),
});
export type GbpLocation = z.infer<typeof gbpLocationSchema>;

export const gbpLocationsPageSchema = z.looseObject({
  locations: z.array(gbpLocationSchema).optional(),
  nextPageToken: z.string().optional(),
});

/** OAuth token endpoint body (success or error). */
export const oauthTokenResponseSchema = z.looseObject({
  access_token: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});
export type OauthTokenResponse = z.infer<typeof oauthTokenResponseSchema>;
