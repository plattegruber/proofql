/**
 * Wire shapes the fake Google server speaks — the subset of the real
 * payloads the connector reads, kept honest to Google's field names so the
 * loose schemas in ../schema.ts and the fixtures here pin each other.
 */

export type StarRating = "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE";

export interface FakeAccount {
  /** Bare id; wire `name` is `accounts/{id}`. */
  id: string;
  accountName: string;
}

export interface FakeLocation {
  /** Bare id; wire `name` is `locations/{id}`. */
  id: string;
  accountId: string;
  title: string;
  addressLines: string[];
  locality: string;
  administrativeArea: string;
  postalCode: string;
  /** `metadata.hasVoiceOfMerchant` — the verified signal the fake models. */
  verified: boolean;
  placeId: string;
  /** Business Profile category id (`gcid:dentist`), under `categories` (#151). */
  primaryCategory?: string;
}

export interface FakeReviewReply {
  comment: string;
  updateTime: string;
  reviewReplyState?: "APPROVED" | "PENDING" | "REJECTED";
  policyViolation?: string;
}

export interface FakeReview {
  /** `accounts/{a}/locations/{l}/reviews/{r}`. */
  name: string;
  reviewId: string;
  reviewer: {
    displayName?: string;
    profilePhotoUrl?: string;
    isAnonymous?: boolean;
  };
  starRating: StarRating;
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: FakeReviewReply;
}

export interface FakeTokenGrant {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
}
