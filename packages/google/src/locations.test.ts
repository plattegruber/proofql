import { describe, expect, it } from "vitest";

import { resolveGoogleEndpoints } from "./endpoints.js";
import {
  bareId,
  parseConnectionMetadata,
  parseLocationCursor,
  pollableLocations,
  serializeLocationCursor,
  v4LocationName,
} from "./locations.js";

describe("locations metadata", () => {
  it("parses the mapping and keeps unknown keys", () => {
    const metadata = parseConnectionMetadata({
      locations: [
        {
          id: "201",
          account: "100",
          title: "North",
          verified: true,
          enabled: true,
        },
        {
          id: "202",
          account: "100",
          title: "South",
          verified: true,
          enabled: false,
        },
        {
          id: "203",
          account: "100",
          title: "Lake",
          verified: false,
          enabled: true,
        },
      ],
      initial_sync_pending: true,
      something_else: 1,
    });
    expect(metadata.initial_sync_pending).toBe(true);
    expect((metadata as Record<string, unknown>).something_else).toBe(1);
    expect(pollableLocations(metadata).map((l) => l.id)).toEqual(["201"]);
  });

  it("treats garbage metadata and cursors as empty", () => {
    expect(parseConnectionMetadata(null).locations).toEqual([]);
    expect(parseConnectionMetadata({ locations: "no" }).locations).toEqual([]);
    expect(parseLocationCursor(null)).toEqual({});
    expect(parseLocationCursor("{")).toEqual({});
    expect(parseLocationCursor("[1]")).toEqual({});
    expect(
      parseLocationCursor('{"201":"2026-01-01T00:00:00Z","202":5}'),
    ).toEqual({
      "201": "2026-01-01T00:00:00Z",
    });
  });

  it("round-trips cursors and builds v4 names", () => {
    const cursor = { "201": "2026-01-01T00:00:00.000Z" };
    expect(parseLocationCursor(serializeLocationCursor(cursor))).toEqual(
      cursor,
    );
    expect(v4LocationName({ account: "100", id: "201" })).toBe(
      "accounts/100/locations/201",
    );
    expect(bareId("locations/201")).toBe("201");
    expect(bareId("201")).toBe("201");
  });
});

describe("resolveGoogleEndpoints", () => {
  it("defaults to real Google per endpoint and lets one API base override all three", () => {
    const real = resolveGoogleEndpoints({});
    expect(real.accountsBase).toBe(
      "https://mybusinessaccountmanagement.googleapis.com",
    );
    expect(real.reviewsBase).toBe("https://mybusiness.googleapis.com");
    expect(real.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    const local = resolveGoogleEndpoints({
      GOOGLE_API_BASE: "http://localhost:8802/",
      GOOGLE_OAUTH_BASE: "http://localhost:8802",
      GOOGLE_TOKEN_URL: "http://localhost:8802/token",
    });
    expect(local).toEqual({
      authorizeUrl: "http://localhost:8802/o/oauth2/v2/auth",
      tokenUrl: "http://localhost:8802/token",
      accountsBase: "http://localhost:8802",
      locationsBase: "http://localhost:8802",
      reviewsBase: "http://localhost:8802",
    });
    // Empty strings mean unset.
    expect(resolveGoogleEndpoints({ GOOGLE_API_BASE: "  " }).reviewsBase).toBe(
      real.reviewsBase,
    );
  });
});
