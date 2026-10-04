/**
 * The headers every api response carries, on success, on error envelopes,
 * on 404s and on the preflight; the `GET /v1/query` exception; and HSTS
 * only where the environment is served over HTTPS.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import type { ApiBindings } from "./bindings.js";
import {
  HSTS_VALUE,
  isCacheableQuery,
  NO_STORE,
  QUERY_CACHE_CONTROL,
  SECURITY_HEADERS,
  securityHeaders,
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

describe("Cache-Control on a successful GET /v1/query (#112)", () => {
  // The real route needs a database; a stub behind the same middleware shows
  // the policy the middleware applies to its 2xx.
  const stub = new Hono()
    .use(securityHeaders)
    .get("/v1/query", (c) => c.json({ results: [] }))
    .post("/v1/query", (c) => c.json({ results: [] }))
    .get("/v1/query/pinned", (c) =>
      c.json({ results: [] }, 200, { "Cache-Control": "no-store" }),
    );

  it("is private, max-age=0, must-revalidate", async () => {
    const res = await stub.request("/v1/query?q=x");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(QUERY_CACHE_CONTROL);
  });

  it("leaves a POST no-store", async () => {
    const res = await stub.request("/v1/query", { method: "POST" });
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });

  it("keeps a policy the route set itself", async () => {
    const res = await stub.request("/v1/query/pinned");
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });
});
