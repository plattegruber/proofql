/**
 * Auth decisions that need no database: a missing or malformed credential,
 * and a publishable key on a write route, are refused before `getDb()` is
 * ever called. The app is built with a db provider that throws, so any
 * accidental lookup fails the test loudly.
 */

import { generateApiKey } from "@proofql/core";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { extractBearerToken } from "./auth.js";

const app = createApp({
  dbProvider: () => {
    throw new Error("database must not be touched before auth decides");
  },
});

function post(headers: Record<string, string>, body = "{}") {
  return app.request("/v1/reviews", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("extractBearerToken", () => {
  it("accepts `Bearer <token>` case-insensitively and trims", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("bearer   abc  ")).toBe("abc");
  });

  it("rejects other schemes and empty tokens", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
    expect(extractBearerToken("Bearer ")).toBeNull();
  });
});

describe("POST /v1/reviews auth (no database)", () => {
  it("401 unauthorized without an Authorization header", async () => {
    const res = await post({});

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: {
        code: "unauthorized",
        message: expect.stringMatching(/Missing/),
      },
    });
  });

  it("401 unauthorized for a non-Bearer scheme", async () => {
    const res = await post({ authorization: "Basic dXNlcjpwYXNz" });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: "unauthorized", message: expect.stringMatching(/Bearer/) },
    });
  });

  it("401 unauthorized for a malformed key", async () => {
    for (const key of [
      "pq_sk_live_short",
      "sk_live_abc",
      `pq_sk_prod_${"a".repeat(32)}`,
    ]) {
      const res = await post({ authorization: `Bearer ${key}` });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error: {
          code: "unauthorized",
          message: expect.stringMatching(/Malformed/),
        },
      });
    }
  });

  it("403 forbidden for a well-formed publishable key on a write route", async () => {
    const { plaintext } = await generateApiKey({
      kind: "publishable",
      environment: "live",
    });
    const res = await post({ authorization: `Bearer ${plaintext}` });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: {
        code: "forbidden",
        doc_url: "https://docs.proofql.com/errors#forbidden",
      },
    });
  });
});
