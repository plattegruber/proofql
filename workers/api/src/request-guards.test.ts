/**
 * The body guards without a database: 415 for a non-JSON body, 413 over
 * the per-path ceiling, and the cases that must pass untouched (GET, no
 * body, non-/v1 paths). The app is built with a throwing db provider so a
 * refused request that reached auth would fail the test loudly.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import {
  bodyLimitFor,
  DEFAULT_BODY_LIMIT_BYTES,
  isJsonContentType,
  QUERY_BODY_LIMIT_BYTES,
} from "./request-guards.js";

const app = createApp({
  dbProvider: () => {
    throw new Error("database must not be touched by a refused body");
  },
});

describe("classification", () => {
  it("picks the ceiling by path", () => {
    expect(bodyLimitFor("/v1/query")).toBe(QUERY_BODY_LIMIT_BYTES);
    expect(bodyLimitFor("/v1/reviews")).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(bodyLimitFor("/v1/reviews/abc")).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(QUERY_BODY_LIMIT_BYTES).toBe(16 * 1024);
  });

  it("accepts application/json with or without parameters, case-insensitively", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("Application/JSON; charset=utf-8")).toBe(true);
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType("application/x-www-form-urlencoded")).toBe(false);
    expect(isJsonContentType("multipart/form-data; boundary=x")).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});

describe("415 unsupported_media_type", () => {
  it.each([
    ["POST", "/v1/reviews", "text/plain"],
    ["POST", "/v1/reviews", "application/x-www-form-urlencoded"],
    ["PATCH", "/v1/reviews/00000000-0000-4000-8000-000000000000", "text/plain"],
    ["POST", "/v1/query", "multipart/form-data; boundary=x"],
  ])("%s %s with %s", async (method, path, contentType) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": contentType },
      body: '{"q":"implant"}',
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({
      error: {
        code: "unsupported_media_type",
        doc_url: "https://docs.proofql.dev/errors#unsupported_media_type",
        message: expect.stringMatching(/application\/json/),
      },
    });
  });

  it("refuses a body with no Content-Type at all", async () => {
    const res = await app.request("/v1/query", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(415);
  });

  it("lets a bodiless POST through to auth (which then asks for a key)", async () => {
    const res = await app.request("/v1/query", { method: "POST" });
    expect(res.status).toBe(401);
    const empty = await app.request("/v1/query", {
      method: "POST",
      headers: { "content-length": "0" },
      body: "",
    });
    expect(empty.status).toBe(401);
  });

  it("ignores GET and DELETE, and anything outside /v1", async () => {
    const get = await app.request("/v1/query?q=x", {
      headers: { "content-type": "text/plain" },
    });
    expect(get.status).toBe(401);
    const del = await app.request(
      "/v1/reviews/00000000-0000-4000-8000-000000000000",
      { method: "DELETE", headers: { "content-type": "text/plain" } },
    );
    expect(del.status).toBe(401);
    const health = await app.request("/health", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    // No POST /health route: the guard did not intervene first.
    expect(health.status).toBe(404);
  });
});

describe("413 payload_too_large", () => {
  it("caps POST /v1/query at 16 KiB, from Content-Length", async () => {
    const res = await app.request("/v1/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(QUERY_BODY_LIMIT_BYTES + 1),
      },
      body: "x".repeat(QUERY_BODY_LIMIT_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: {
        code: "payload_too_large",
        message: expect.stringContaining(String(QUERY_BODY_LIMIT_BYTES)),
      },
    });
  });

  it("leaves a 16 KiB query body under the cap alone", async () => {
    const res = await app.request("/v1/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(QUERY_BODY_LIMIT_BYTES),
      },
      body: "x".repeat(QUERY_BODY_LIMIT_BYTES),
    });
    expect(res.status).toBe(401);
  });

  it("backstops every other /v1 route at 1 MiB", async () => {
    const res = await app.request("/v1/reviews", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(DEFAULT_BODY_LIMIT_BYTES + 1),
      },
      body: "x".repeat(DEFAULT_BODY_LIMIT_BYTES + 1),
    });
    expect(res.status).toBe(413);
  });
});
