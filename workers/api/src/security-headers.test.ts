/**
 * The headers every api response carries, on success, on error envelopes,
 * on 404s and on the preflight; the `GET /v1/query` exception; and HSTS
 * only where the environment is served over HTTPS.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import type { ApiBindings } from "./bindings.js";
import {
  HSTS_VALUE,
  isCacheableQuery,
  NO_STORE,
  SECURITY_HEADERS,
} from "./security-headers.js";

const app = createApp({
  dbProvider: () => {
    throw new Error("no database in these tests");
  },
});

function env(environment: string): ApiBindings {
  return { ENVIRONMENT: environment } as ApiBindings;
}

describe("on every response", () => {
  it.each([
    ["GET /health 200", "/health", {}],
    ["GET /nope 404", "/nope", {}],
    ["GET /v1/reviews 401", "/v1/reviews", {}],
    [
      "POST /v1/reviews 415",
      "/v1/reviews",
      { method: "POST", headers: { "content-type": "text/plain" }, body: "x" },
    ],
    ["OPTIONS /v1/query 204", "/v1/query", { method: "OPTIONS" }],
  ])("%s carries nosniff, no-referrer and no-store", async (_label, path, init) => {
    const res = await app.request(path, init as RequestInit);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value);
    }
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });

  it("does not assert HSTS for local or unknown environments", async () => {
    const none = await app.request("/health");
    expect(none.headers.get("Strict-Transport-Security")).toBeNull();
    const local = await app.request("/health", {}, env("local"));
    expect(local.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("asserts HSTS in preview and prod", async () => {
    for (const name of ["preview", "prod"]) {
      const res = await app.request("/health", {}, env(name));
      expect(res.headers.get("Strict-Transport-Security"), name).toBe(
        HSTS_VALUE,
      );
    }
  });
});

describe("the GET /v1/query exception", () => {
  it("applies to a successful GET only; errors on the route are no-store", () => {
    expect(isCacheableQuery("GET", "/v1/query", 200)).toBe(true);
    expect(isCacheableQuery("GET", "/v1/query", 401)).toBe(false);
    expect(isCacheableQuery("POST", "/v1/query", 200)).toBe(false);
    expect(isCacheableQuery("GET", "/v1/reviews", 200)).toBe(false);
  });

  it("a refused query is no-store like everything else", async () => {
    const res = await app.request("/v1/query?q=x");
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });
});
