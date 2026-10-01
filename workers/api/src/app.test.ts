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
});
