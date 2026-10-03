/**
 * In-memory state behind the fake Google server: accounts, locations,
 * reviews, OAuth codes and tokens, and the knobs tests and local dev turn
 * to provoke the connector's failure paths.
 */

import { defaultFixtures, type FixtureSet } from "./fixtures.js";
import type {
  FakeAccount,
  FakeLocation,
  FakeReview,
  FakeTokenGrant,
} from "./types.js";

export interface FakeGoogleStoreOptions {
  fixtures?: FixtureSet;
  /** Access-token lifetime in seconds (real Google: 3600). */
  accessTokenTtlSeconds?: number;
  now?: () => number;
}

interface AuthCode {
  codeChallenge?: string | undefined;
  withRefreshToken: boolean;
}

interface AccessToken {
  expiresAtMs: number;
}

export interface ForcedFailure {
  status: number;
  /** How many more data-API requests fail this way. */
  remaining: number;
}

let counter = 0;
function token(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class FakeGoogleStore {
  readonly accounts: FakeAccount[];
  readonly locations: FakeLocation[];
  private readonly reviewsByLocation = new Map<string, FakeReview[]>();
  private readonly authCodes = new Map<string, AuthCode>();
  private readonly accessTokens = new Map<string, AccessToken>();
  private readonly refreshTokens = new Set<string>();
  readonly accessTokenTtlSeconds: number;
  private readonly now: () => number;

  /** Knob: every refresh answers `invalid_grant` while true. */
  invalidGrant = false;
  /** Knob: the next N data-API requests fail with this status. */
  forcedFailure: ForcedFailure | null = null;
  /** Every data-API request the server saw (method + path), for assertions. */
  readonly requests: { method: string; path: string }[] = [];

  constructor(options: FakeGoogleStoreOptions = {}) {
    const fixtures = options.fixtures ?? defaultFixtures();
    this.accounts = [...fixtures.accounts];
    this.locations = [...fixtures.locations];
    for (const review of fixtures.reviews) {
      const locationId = review.name.split("/")[3] as string;
      const list = this.reviewsByLocation.get(locationId) ?? [];
      list.push(review);
      this.reviewsByLocation.set(locationId, list);
    }
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 3600;
    this.now = options.now ?? Date.now;
  }

  // --- OAuth -----------------------------------------------------------------

  issueAuthCode(input: AuthCode): string {
    const code = token("code");
    this.authCodes.set(code, input);
    return code;
  }

  /** Single use; `derivedChallenge` must match the recorded one when PKCE was used. */
  exchangeAuthCode(
    code: string,
    derivedChallenge: string | undefined,
  ): FakeTokenGrant | undefined {
    const record = this.authCodes.get(code);
    if (!record) return undefined;
    this.authCodes.delete(code);
    if (
      record.codeChallenge !== undefined &&
      record.codeChallenge !== derivedChallenge
    ) {
      return undefined;
    }
    const grant = this.mintAccessToken();
    if (record.withRefreshToken) {
      const refreshToken = token("rt");
      this.refreshTokens.add(refreshToken);
      grant.refreshToken = refreshToken;
    }
    return grant;
  }

  refreshAccessToken(refreshToken: string): FakeTokenGrant | undefined {
    if (this.invalidGrant || !this.refreshTokens.has(refreshToken))
      return undefined;
    return this.mintAccessToken();
  }

  /** Mint a live refresh + access token pair without the browser flow (tests). */
  issueTokens(): Required<FakeTokenGrant> {
    const refreshToken = token("rt");
    this.refreshTokens.add(refreshToken);
    const grant = this.mintAccessToken();
    return { ...grant, refreshToken };
  }

  revokeRefreshToken(refreshToken: string): void {
    this.refreshTokens.delete(refreshToken);
  }

  /** Make every outstanding access token invalid at once. */
  expireAccessTokens(): void {
    this.accessTokens.clear();
  }

  isAccessTokenValid(accessToken: string): boolean {
    const record = this.accessTokens.get(accessToken);
    return record !== undefined && record.expiresAtMs > this.now();
  }

  private mintAccessToken(): FakeTokenGrant {
    const accessToken = token("at");
    this.accessTokens.set(accessToken, {
      expiresAtMs: this.now() + this.accessTokenTtlSeconds * 1000,
    });
    return { accessToken, expiresIn: this.accessTokenTtlSeconds };
  }

  // --- Data ------------------------------------------------------------------

  account(accountId: string): FakeAccount | undefined {
    return this.accounts.find((a) => a.id === accountId);
  }

  locationsFor(accountId: string): FakeLocation[] {
    return this.locations.filter((l) => l.accountId === accountId);
  }

  location(accountId: string, locationId: string): FakeLocation | undefined {
    return this.locations.find(
      (l) => l.accountId === accountId && l.id === locationId,
    );
  }

  /** Reviews for a location, newest `updateTime` first (ties: newest createTime, then name). */
  reviewsFor(locationId: string): FakeReview[] {
    const list = this.reviewsByLocation.get(locationId) ?? [];
    return [...list].sort((a, b) => {
      const byUpdate = Date.parse(b.updateTime) - Date.parse(a.updateTime);
      if (byUpdate !== 0) return byUpdate;
      const byCreate = Date.parse(b.createTime) - Date.parse(a.createTime);
      if (byCreate !== 0) return byCreate;
      return a.name < b.name ? -1 : 1;
    });
  }

  /** Add a review (tests: "one new review since the last tick"). */
  addReview(
    locationId: string,
    overrides: Partial<FakeReview> & { comment?: string },
  ): FakeReview {
    const location = this.locations.find((l) => l.id === locationId);
    if (!location) throw new Error(`fake: unknown location ${locationId}`);
    const nowIso = new Date(this.now()).toISOString();
    const reviewId = overrides.reviewId ?? token("rv").replace(/_/g, "");
    const review: FakeReview = {
      name: `accounts/${location.accountId}/locations/${location.id}/reviews/${reviewId}`,
      reviewId,
      reviewer: { displayName: "New Reviewer" },
      starRating: "FIVE",
      comment: "Brand new review, straight from the fake.",
      createTime: nowIso,
      updateTime: nowIso,
      ...overrides,
    };
    const list = this.reviewsByLocation.get(locationId) ?? [];
    list.push(review);
    this.reviewsByLocation.set(locationId, list);
    return review;
  }

  /** Edit a review's comment, moving its `updateTime` to now. */
  editReview(name: string, comment: string): FakeReview {
    for (const list of this.reviewsByLocation.values()) {
      const review = list.find((r) => r.name === name);
      if (review) {
        review.comment = comment;
        review.updateTime = new Date(this.now()).toISOString();
        return review;
      }
    }
    throw new Error(`fake: unknown review ${name}`);
  }

  reviewCount(): number {
    let n = 0;
    for (const list of this.reviewsByLocation.values()) n += list.length;
    return n;
  }

  // --- Failure injection -----------------------------------------------------

  /** The next `times` data-API requests answer `status` (429 carries Retry-After: 1). */
  failNext(status: number, times = 1): void {
    this.forcedFailure = { status, remaining: times };
  }

  /** Consume one forced failure, if any is queued. */
  consumeForcedFailure(): number | undefined {
    const failure = this.forcedFailure;
    if (!failure || failure.remaining <= 0) return undefined;
    failure.remaining -= 1;
    if (failure.remaining === 0) this.forcedFailure = null;
    return failure.status;
  }
}
