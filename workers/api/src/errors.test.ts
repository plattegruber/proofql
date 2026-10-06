import { recordingSink } from "@proofql/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";

import type { AppEnv } from "./bindings.js";
import { quotaExhaustion } from "./db.js";
import {
  ApiError,
  docUrl,
  ERROR_CODES,
  notFound,
  onError,
  rejectionEvent,
} from "./errors.js";
import { REQUEST_ID_HEADER, requestContext } from "./request-id.js";

/** Hyperdrive's literal message (#141), renewing `inSeconds` from now. */
function hyperdriveLimit(inSeconds: number): string {
  const at = new Date(Math.ceil(Date.now() / 1000) * 1000 + inSeconds * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
  return `Usage limit for account exceeded, usage renews at ${at} UTC`;
}

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
  // Drizzle wraps the driver's error: the SQLSTATE is on `cause`.
  app.get("/too-many-clients", () => {
    throw new Error("Failed query: select ...", {
      cause: Object.assign(new Error("sorry, too many clients already"), {
        name: "PostgresError",
        code: "53300",
      }),
    });
  });
  app.get("/connect-timeout", () => {
    throw Object.assign(new Error("write CONNECT_TIMEOUT"), {
      code: "CONNECT_TIMEOUT",
    });
  });
  // What postgres-js threw on preview when Hyperdrive's daily quota was
  // spent (#141): a PostgresError with no SQLSTATE, wrapped by Drizzle.
  app.get("/hyperdrive-limit", () => {
    throw new Error("Failed query: select ...", {
      cause: Object.assign(new Error(hyperdriveLimit(3600)), {
        name: "PostgresError",
      }),
    });
  });
  app.get("/hyperdrive-limit-no-time", () => {
    throw Object.assign(new Error("Usage limit for account exceeded"), {
      name: "PostgresError",
    });
  });
  app.get("/kv-limit", () => {
    throw new Error("KV get() limit exceeded for the day.");
  });
  app.get("/kv-put-limit", () => {
    throw new Error("KV put() limit exceeded for the day.");
  });
  app.get("/syntax-error", () => {
    throw new Error("Failed query", {
      cause: Object.assign(new Error("syntax error"), { code: "42601" }),
    });
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
        doc_url: "https://docs.proofql.dev/errors#validation_failed",
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
        doc_url: "https://docs.proofql.dev/errors#internal",
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

  it("maps a database connection failure to 503 service_unavailable with Retry-After", async () => {
    const app = harness();
    for (const path of ["/too-many-clients", "/connect-timeout"]) {
      const res = await app.request(path);
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("1");
      const body = (await res.json()) as {
        error: { code: string; message: string; request_id: string };
      };
      expect(body.error.code).toBe("service_unavailable");
      expect(body.error.message).not.toMatch(/too many clients|CONNECT/);
      expect(body.error.message).toContain(body.error.request_id);
    }
    // One db.unavailable (warn, with the code) and one request.rejected
    // (error, 503) per request; never a request.failed.
    const unavailable = app.out.find("db.unavailable");
    expect(unavailable.map((l) => l.code)).toEqual([
      "53300",
      "CONNECT_TIMEOUT",
    ]);
    expect(unavailable.every((l) => l.level === "warn")).toBe(true);
    expect(
      app.out
        .find("request.rejected")
        .filter((l) => l.code === "service_unavailable"),
    ).toHaveLength(2);
    expect(app.out.find("request.failed")).toEqual([]);
  });

  it("maps Hyperdrive's daily usage limit to 503 with Retry-After until the renewal (#142)", async () => {
    const app = harness();
    const res = await app.request("/hyperdrive-limit");
    expect(res.status).toBe(503);
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(3590);
    expect(retryAfter).toBeLessThanOrEqual(3601);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("service_unavailable");
    expect(body.error.message).not.toMatch(/Usage limit/);
    expect(app.out.only("quota.exhausted")).toMatchObject({
      level: "error",
      resource: "hyperdrive",
      retry_after: retryAfter,
    });
    expect(app.out.find("request.failed")).toEqual([]);
    expect(app.out.find("db.unavailable")).toEqual([]);
  });

  it("falls back to Retry-After 300 when no renewal time is stated, and maps KV's limit errors too", async () => {
    const app = harness();
    for (const [path, resource] of [
      ["/hyperdrive-limit-no-time", "hyperdrive"],
      ["/kv-limit", "kv"],
      ["/kv-put-limit", "kv"],
    ] as const) {
      const res = await app.request(path);
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("300");
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("service_unavailable");
      expect(app.out.find("quota.exhausted").at(-1)).toMatchObject({
        level: "error",
        resource,
      });
    }
    expect(app.out.find("request.failed")).toEqual([]);
  });

  it("parses the renewal time from the literal message", () => {
    const now = Date.parse("2026-10-04T22:00:00Z");
    expect(
      quotaExhaustion(
        new Error(
          "Usage limit for account exceeded, usage renews at 2026-10-05 00:00:00 UTC",
        ),
        now,
      ),
    ).toEqual({
      resource: "hyperdrive",
      retryAfter: 7200,
      renewsAt: "2026-10-05T00:00:00.000Z",
    });
    // A renewal already past means "any moment": at least one second.
    expect(
      quotaExhaustion(
        new Error(
          "Usage limit for account exceeded, usage renews at 2026-10-04 00:00:00 UTC",
        ),
        now,
      )?.retryAfter,
    ).toBe(1);
    expect(quotaExhaustion(new Error("syntax error"), now)).toBeNull();
  });

  it("leaves other database errors as 500 internal", async () => {
    const app = harness();
    const res = await app.request("/syntax-error");
    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(app.out.find("request.failed")).toHaveLength(1);
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
      expect(docUrl(code)).toBe(`https://docs.proofql.dev/errors#${code}`);
    }
  });
});
