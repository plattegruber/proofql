import { recordingSink } from "@proofql/core";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { REQUEST_ID_HEADER } from "./request-id.js";

const app = createApp();

describe("api app", () => {
  it("GET /health returns { ok: true }", async () => {
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("unknown routes 404 with the error envelope", async () => {
    const res = await app.request("/nope");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({
      error: {
        code: "not_found",
        doc_url: "https://docs.proofql.com/errors#not_found",
        request_id: res.headers.get(REQUEST_ID_HEADER),
      },
    });
  });

  it("attaches a uuid x-request-id to every response", async () => {
    const res = await app.request("/health");

    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("echoes an incoming x-request-id, else cf-ray", async () => {
    const own = await app.request("/health", {
      headers: { "x-request-id": "client-abc", "cf-ray": "ray-1" },
    });
    expect(own.headers.get(REQUEST_ID_HEADER)).toBe("client-abc");

    const ray = await app.request("/health", {
      headers: { "cf-ray": "ray-1" },
    });
    expect(ray.headers.get(REQUEST_ID_HEADER)).toBe("ray-1");
  });

  it("ignores an oversized incoming request id", async () => {
    const res = await app.request("/health", {
      headers: { "x-request-id": "x".repeat(129) },
    });
    expect(res.headers.get(REQUEST_ID_HEADER)).not.toBe("x".repeat(129));
  });

  it("regenerates an incoming request id outside the token charset (log injection)", async () => {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const hostile of [
      'abc"}{"event":"forged',
      "abc def",
      "abc,def",
      "<script>",
      "a/b",
    ]) {
      const res = await app.request("/health", {
        headers: { "x-request-id": hostile },
      });
      const echoed = res.headers.get(REQUEST_ID_HEADER);
      expect(echoed, hostile).not.toBe(hostile);
      expect(echoed, hostile).toMatch(uuid);
    }
    // The shapes real clients send stay as they are.
    for (const fine of [
      "req_1",
      "a.b:c-d",
      "8f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f",
    ]) {
      const res = await app.request("/health", {
        headers: { "x-request-id": fine },
      });
      expect(res.headers.get(REQUEST_ID_HEADER)).toBe(fine);
    }
  });

  it("every log line emitted during a request carries its request_id", async () => {
    const out = recordingSink();
    const logged = createApp({ logSink: out.sink });

    const res = await logged.request("/nope", {
      headers: { [REQUEST_ID_HEADER]: "req-log-1" },
    });

    expect(res.status).toBe(404);
    expect(out.records.length).toBeGreaterThan(0);
    for (const record of out.records) {
      expect(record).toMatchObject({
        service: "api",
        request_id: "req-log-1",
        method: "GET",
        path: "/nope",
      });
    }
    expect(out.only("request.rejected")).toMatchObject({
      code: "not_found",
      status: 404,
      // No bindings were passed to app.request(), so the environment is unknown.
      environment: "unknown",
    });
  });
});
