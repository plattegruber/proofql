import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";

import type { AppEnv } from "./bindings.js";
import { ApiError, docUrl, ERROR_CODES, notFound, onError } from "./errors.js";
import { REQUEST_ID_HEADER, requestId } from "./request-id.js";

/** A bare app with only the error plumbing under test. */
function harness() {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.notFound(notFound);
  app.use(requestId);
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
  return app;
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
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await harness().request("/boom", {
      headers: { [REQUEST_ID_HEADER]: "req-42" },
    });
    error.mockRestore();

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
  });

  it("has one doc anchor per code", () => {
    for (const code of ERROR_CODES) {
      expect(docUrl(code)).toBe(`https://docs.proofql.com/errors#${code}`);
    }
  });
});
