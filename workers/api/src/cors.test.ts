import { describe, expect, it } from "vitest";

import type { AuthContext } from "./bindings.js";
import { corsOriginFor, isAllowedOrigin, normalizeOrigin } from "./cors.js";
import { ApiError } from "./errors.js";

const ALLOWED = ["https://shop.example", "http://localhost:3000"];

function auth(
  kind: AuthContext["kind"],
  allowedOrigins = ALLOWED,
): AuthContext {
  return {
    apiKeyId: "k",
    projectId: "p",
    environment: "live",
    kind,
    plan: "free",
    project: {
      allowedOrigins,
      minRating: 4,
      similarityFloor: 0.55,
    },
  };
}

describe("normalizeOrigin", () => {
  it("canonicalizes case, default ports, and trailing paths", () => {
    expect(normalizeOrigin("HTTPS://Shop.Example:443/")).toBe(
      "https://shop.example",
    );
    expect(normalizeOrigin("http://localhost:3000/some/path")).toBe(
      "http://localhost:3000",
    );
    expect(normalizeOrigin("http://localhost:80")).toBe("http://localhost");
  });

  it("rejects non-URLs and non-http schemes", () => {
    expect(normalizeOrigin("shop.example")).toBeNull();
    expect(normalizeOrigin("ftp://shop.example")).toBeNull();
    expect(normalizeOrigin("null")).toBeNull();
  });
});

describe("isAllowedOrigin", () => {
  it("matches the whole origin exactly: scheme, host, and port", () => {
    expect(isAllowedOrigin("https://shop.example", ALLOWED)).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000", ALLOWED)).toBe(true);
    expect(isAllowedOrigin("http://shop.example", ALLOWED)).toBe(false); // scheme
    expect(isAllowedOrigin("https://shop.example:8443", ALLOWED)).toBe(false); // port
    expect(isAllowedOrigin("http://localhost:3001", ALLOWED)).toBe(false); // port
    expect(isAllowedOrigin("https://www.shop.example", ALLOWED)).toBe(false); // host
    expect(isAllowedOrigin("https://evil.example", ALLOWED)).toBe(false);
  });

  it("does not do subdomain or substring matching", () => {
    expect(isAllowedOrigin("https://shop.example.evil.test", ALLOWED)).toBe(
      false,
    );
    expect(isAllowedOrigin("https://sub.shop.example", ALLOWED)).toBe(false);
  });

  it("is case-insensitive on host and tolerant of a trailing slash in the allowlist", () => {
    expect(
      isAllowedOrigin("https://SHOP.example", ["https://shop.example/"]),
    ).toBe(true);
  });

  it("never matches a missing, opaque, or malformed origin", () => {
    expect(isAllowedOrigin(undefined, ALLOWED)).toBe(false);
    expect(isAllowedOrigin("null", ALLOWED)).toBe(false);
    expect(isAllowedOrigin("not a url", ALLOWED)).toBe(false);
    expect(isAllowedOrigin("https://shop.example", [])).toBe(false);
  });
});

describe("corsOriginFor", () => {
  it("echoes a listed origin for a publishable key", () => {
    expect(corsOriginFor("https://shop.example", auth("publishable"))).toBe(
      "https://shop.example",
    );
  });

  it("403s a publishable key with no Origin, naming the fix", () => {
    expect(() => corsOriginFor(undefined, auth("publishable"))).toThrowError(
      expect.objectContaining({ status: 403, code: "forbidden" }),
    );
    try {
      corsOriginFor(undefined, auth("publishable"));
    } catch (e) {
      expect((e as ApiError).message).toMatch(/Origin header/);
      expect((e as ApiError).message).toMatch(/secret key/);
    }
  });

  it("403s a publishable key from an unlisted origin, naming the origin and the setting", () => {
    try {
      corsOriginFor("https://evil.example", auth("publishable"));
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
      expect((e as ApiError).message).toMatch(/https:\/\/evil\.example/);
      expect((e as ApiError).message).toMatch(/Allowed origins/);
    }
  });

  it("lets secret keys through with or without an origin, echoing one if present", () => {
    expect(corsOriginFor(undefined, auth("secret"))).toBeNull();
    expect(corsOriginFor("https://anything.example", auth("secret", []))).toBe(
      "https://anything.example",
    );
  });
});
