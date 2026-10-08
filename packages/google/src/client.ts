/**
 * Typed fetchers for the three Google Business Profile data APIs (#46).
 *
 * - `listAccounts`     Account Management v1 — pages of 20 (default AND max).
 * - `listLocations`    Business Information v1 — `readMask` is REQUIRED;
 *                      pages of 100.
 * - `listReviewsPage`  My Business v4 — `pageSize=50` (the max),
 *                      `orderBy=updateTime desc`, `nextPageToken`.
 *
 * Everything is injectable: endpoints from {@link resolveGoogleEndpoints}
 * and `fetch` from the caller (the fake server's `app.fetch` in tests), so
 * no test and no local run ever reaches Google. Pagination is sequential
 * and the client never paces itself — the poller's pacer decides when a
 * request may start; this module only makes it.
 *
 * Non-2xx → {@link GoogleRateLimited} (429), {@link GoogleUnavailable}
 * (5xx), {@link GoogleUnauthorized} (401), else {@link GoogleApiError};
 * all carry `Retry-After` when Google sent one. Bodies are validated with
 * loose schemas (./schema.ts): unknown fields pass, a malformed body is a
 * `GoogleApiError` with `googleStatus: "MALFORMED_RESPONSE"`.
 */

import type { z } from "zod";

import type { GoogleEndpoints } from "./endpoints.js";
import { apiErrorFor, GoogleApiError } from "./errors.js";
import {
  type GbpAccount,
  type GbpLocation,
  type GbpReviewsPage,
  gbpAccountsPageSchema,
  gbpLocationsPageSchema,
  gbpReviewsPageSchema,
} from "./schema.js";

/**
 * `locations.list` readMask: identity, display fields, verified flag +
 * place id, and the categories (the primary one sets `projects.category`,
 * #151).
 */
export const GOOGLE_LOCATIONS_READ_MASK =
  "name,title,storefrontAddress,metadata,categories";
export const ACCOUNTS_PAGE_SIZE = 20;
export const LOCATIONS_PAGE_SIZE = 100;
export const REVIEWS_PAGE_SIZE = 50;
export const REVIEWS_ORDER_BY = "updateTime desc";

export interface GoogleClientConfig {
  endpoints: GoogleEndpoints;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

export interface GoogleClient {
  listAccounts(accessToken: string): Promise<GbpAccount[]>;
  listLocations(
    accessToken: string,
    accountName: string,
  ): Promise<GbpLocation[]>;
  listReviewsPage(
    accessToken: string,
    v4LocationName: string,
    pageToken?: string,
  ): Promise<GbpReviewsPage>;
  /** Every request made, for tests and quota accounting. */
  readonly requests: number;
}

export function createGoogleClient(config: GoogleClientConfig): GoogleClient {
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  let requests = 0;

  async function getJson<T extends z.ZodType>(
    what: string,
    url: URL,
    accessToken: string,
    schema: T,
  ): Promise<z.infer<T>> {
    requests += 1;
    const response = await doFetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw apiErrorFor(what, response, body, now());
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new GoogleApiError(what, response.status, "MALFORMED_RESPONSE");
    }
    return parsed.data;
  }

  return {
    get requests() {
      return requests;
    },
    async listAccounts(accessToken) {
      const accounts: GbpAccount[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL("/v1/accounts", config.endpoints.accountsBase);
        url.searchParams.set("pageSize", String(ACCOUNTS_PAGE_SIZE));
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const page = await getJson(
          "accounts.list",
          url,
          accessToken,
          gbpAccountsPageSchema,
        );
        accounts.push(...(page.accounts ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return accounts;
    },
    async listLocations(accessToken, accountName) {
      const locations: GbpLocation[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL(
          `/v1/${accountName}/locations`,
          config.endpoints.locationsBase,
        );
        url.searchParams.set("readMask", GOOGLE_LOCATIONS_READ_MASK);
        url.searchParams.set("pageSize", String(LOCATIONS_PAGE_SIZE));
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const page = await getJson(
          `locations.list(${accountName})`,
          url,
          accessToken,
          gbpLocationsPageSchema,
        );
        locations.push(...(page.locations ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return locations;
    },
    async listReviewsPage(accessToken, v4LocationName, pageToken) {
      const url = new URL(
        `/v4/${v4LocationName}/reviews`,
        config.endpoints.reviewsBase,
      );
      url.searchParams.set("pageSize", String(REVIEWS_PAGE_SIZE));
      url.searchParams.set("orderBy", REVIEWS_ORDER_BY);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      return getJson(
        `reviews.list(${v4LocationName})`,
        url,
        accessToken,
        gbpReviewsPageSchema,
      );
    },
  };
}
