import { describe, expect, it } from "vitest";

import { app } from "./app.js";

describe("api app", () => {
  it("GET /health returns { ok: true }", async () => {
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("unknown routes 404", async () => {
    const res = await app.request("/nope");

    expect(res.status).toBe(404);
  });
});
