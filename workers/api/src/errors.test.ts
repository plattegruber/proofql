import { recordingSink } from "@proofql/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";

import type { AppEnv } from "./bindings.js";
import {
  ApiError,
  docUrl,
  ERROR_CODES,
  notFound,
  onError,
  rejectionEvent,
} from "./errors.js";
import { REQUEST_ID_HEADER, requestContext } from "./request-id.js";

/** A bare app with only the error plumbing under test, logging into `out`. */
function harness() {
  const out = recordingSink();
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.notFound(notFound);
  app.use(requestContext({ sink: out.sink }));
  app.get("/api-error", () => {
    throw new ApiError("validation_failed", "Nope.", {
      details: [{ path: "0.rating", message: "Too big" }],
    });
  });
  app.get("/http-exception", () => {
    throw new HTTPException(413);
  });
  app.get("/boom", () => {
    throw new Error("secret stack trace material");
  });
  return Object.assign(app, { out });
}

describe("error envelope", () => {
  it("renders an ApiError with code, message, doc_url, request_id, details", async () => {
    const res = await harness().request("/api-error");

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({
      error: {
        code: "validation_failed",
        message: "Nope.",
        doc_url: "https://docs.proofql.com/errors#validation_failed",
        request_id: res.headers.get(REQUEST_ID_HEADER),
        details: [{ path: "0.rating", message: "Too big" }],
      },
    });
  });

  it("maps Hono HTTPExceptions onto the code set", async () => {
    const res = await harness().request("/http-exception");

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: { code: "payload_too_large" },
    });
  });

  it("turns unknown errors into 500 internal with the request id and no stack", async () => {
    const app = harness();
    const res = await app.request("/boom", {
      headers: { [REQUEST_ID_HEADER]: "req-42" },
    });

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret stack trace material");
    expect(text).not.toContain("at ");
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "internal",
        message: "Internal error. Quote request id req-42 when reporting it.",
        doc_url: "https://docs.proofql.com/errors#internal",
        request_id: "req-42",
      },
    });
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("req-42");

    // The cause is recorded exactly once, server-side, with the request id.
    expect(app.out.only("request.failed")).toMatchObject({
      level: "error",
      request_id: "req-42",
      method: "GET",
      path: "/boom",
      error: { name: "Error", message: "secret stack trace material" },
      stack: expect.stringContaining("secret stack trace material"),
    });
  });

  it("logs one <route>.rejected line per ApiError, with code and status", async () => {
    const app = harness();
    const res = await app.request("/api-error", {
      headers: { [REQUEST_ID_HEADER]: "req-7" },
    });

    expect(res.status).toBe(422);
    expect(app.out.records).toHaveLength(1);
    expect(app.out.only("request.rejected")).toMatchObject({
      level: "warn",
      request_id: "req-7",
      code: "validation_failed",
      status: 422,
    });

    await app.request("/http-exception");
    expect(app.out.find("request.rejected")).toHaveLength(2);
    expect(app.out.find("request.rejected")[1]).toMatchObject({
      code: "payload_too_large",
      status: 413,
    });
  });

  it("names the rejection after the route", () => {
    expect(rejectionEvent("/v1/query")).toBe("query.rejected");
    expect(rejectionEvent("/v1/query/")).toBe("query.rejected");
    expect(rejectionEvent("/v1/reviews")).toBe("reviews.rejected");
    expect(rejectionEvent("/v1/reviews/abc")).toBe("reviews.rejected");
    expect(rejectionEvent("/v1/queryx")).toBe("request.rejected");
    expect(rejectionEvent("/health")).toBe("request.rejected");
  });

  it("has one doc anchor per code", () => {
    for (const code of ERROR_CODES) {
      expect(docUrl(code)).toBe(`https://docs.proofql.com/errors#${code}`);
    }
  });
});
