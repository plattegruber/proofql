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

describe("/v1/query ?key= (no database)", () => {
  function get(qs: string, headers: Record<string, string> = {}) {
    return app.request(`/v1/query${qs}`, { headers });
  }

  it("401 unauthorized for a secret key in the URL, before any lookup", async () => {
    const { plaintext } = await generateApiKey({
      kind: "secret",
      environment: "live",
    });
    const res = await get(`?key=${plaintext}`);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: {
        code: "unauthorized",
        message: expect.stringMatching(
          /Authorization header, never in the URL/,
        ),
      },
    });
  });

  it("401 with a hint naming ?key= when neither header nor param is sent", async () => {
    const res = await get("");

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: "unauthorized", message: expect.stringMatching(/\?key=/) },
    });
  });

  it("401 for a malformed ?key=", async () => {
    const res = await get("?key=pq_pk_live_short");

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: {
        code: "unauthorized",
        message: expect.stringMatching(/Malformed/),
      },
    });
  });

  it("the Authorization header is checked first when both are present", async () => {
    const res = await get("?key=whatever", { authorization: "Basic abc" });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: "unauthorized", message: expect.stringMatching(/Bearer/) },
    });
  });

  // #91: `?key=` is a GET-only affordance for the snippet.
  describe("POST /v1/query", () => {
    function postQuery(qs: string, headers: Record<string, string> = {}) {
      return app.request(`/v1/query${qs}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
    }

    it("401 unauthorized for a publishable ?key=, pointing at the header", async () => {
      const { plaintext } = await generateApiKey({
        kind: "publishable",
        environment: "live",
      });
      const res = await postQuery(`?key=${plaintext}`);

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error: {
          code: "unauthorized",
          message: expect.stringMatching(
            /accepted on GET \/v1\/query only.*Authorization: Bearer/,
          ),
        },
      });
    });

    it("401 even when a Bearer header accompanies the ?key=", async () => {
      const { plaintext } = await generateApiKey({
        kind: "publishable",
        environment: "live",
      });
      const res = await postQuery(`?key=${plaintext}`, {
        authorization: `Bearer ${plaintext}`,
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error: {
          code: "unauthorized",
          message: expect.stringMatching(/GET \/v1\/query only/),
        },
      });
    });

    it("the missing-header hint does not advertise ?key= on POST", async () => {
      const res = await postQuery("");

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toMatch(/Missing Authorization header/);
      expect(body.error.message).not.toMatch(/\?key=/);
    });
  });
});
