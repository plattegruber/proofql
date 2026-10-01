/**
 * Rate limiting through the real auth path: `requireApiKey` resolves a key
 * from the harness database and hands its id to the limiter the app was
 * built with. A recording fake stands in for the Cloudflare binding.
 */

import { generateApiKey } from "@proofql/core";
import { project, setupTestDb } from "@proofql/db/test";
import { describe, expect, it } from "vitest";

import { issueKey, testEnv } from "../test/helpers.js";
import { createApp } from "./app.js";
import { requireAnyKey } from "./auth.js";
import type { ApiBindings } from "./bindings.js";
import type { RateLimiter, RateLimiters } from "./rate-limit.js";

const t = setupTestDb();

function recordingLimiter(outcomes: boolean[] = []) {
  const keys: string[] = [];
  const limiter: RateLimiter & { keys: string[] } = {
    keys,
    limit: async (key) => {
      keys.push(key);
      return { success: outcomes.shift() ?? true };
    },
  };
  return limiter;
}

const env = testEnv({
  queue: {
    sendBatch: async () => {},
  } as unknown as ApiBindings["INGEST_QUEUE"],
});

/** The real app plus a read route either key kind may call. */
function appWith(limiters: RateLimiter | Partial<RateLimiters>) {
  const app = createApp({ db: t.db, rateLimiter: limiters });
  app.get("/v1/read-stub", requireAnyKey, (c) => c.json({ ok: true }));
  return app;
}

describe("per-key rate limiting via requireApiKey", () => {
  it("counts an authenticated write against the key's id and refuses with 429", async () => {
    const p = await project(t.db);
    const { plaintext, row } = await issueKey(t.db, p.id, "secret");
    const limiter = recordingLimiter([true, false]);
    const app = appWith(limiter);
    const post = () =>
      app.request(
        "/v1/reviews",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${plaintext}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            external_id: "e1",
            source: "google",
            rating: 5,
            text: "Great.",
            author_name: "A. Reviewer",
            occurred_at: "2026-03-14T18:20:00Z",
          }),
        },
        env,
      );

    const first = await post();
    expect(first.status).toBe(200);
    expect(first.headers.get("RateLimit-Limit")).toBe("300");

    const second = await post();
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({
      error: { code: "rate_limited" },
    });
    expect(second.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(limiter.keys).toEqual([row.id, row.id]);
  });

  it("selects the limiter by the stored key kind", async () => {
    const p = await project(t.db);
    const sk = await issueKey(t.db, p.id, "secret");
    const pk = await issueKey(t.db, p.id, "publishable");
    const secret = recordingLimiter();
    const publishable = recordingLimiter();
    const app = appWith({ secret, publishable });

    const a = await app.request(
      "/v1/read-stub",
      { headers: { authorization: `Bearer ${sk.plaintext}` } },
      env,
    );
    const b = await app.request(
      "/v1/read-stub",
      { headers: { authorization: `Bearer ${pk.plaintext}` } },
      env,
    );

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.headers.get("RateLimit-Policy")).toBe("300;w=60");
    expect(b.headers.get("RateLimit-Policy")).toBe("120;w=60");
    expect(secret.keys).toEqual([sk.row.id]);
    expect(publishable.keys).toEqual([pk.row.id]);
  });

  it("never consults the limiter for a request that fails auth", async () => {
    const limiter = recordingLimiter([false]);
    const app = appWith(limiter);
    const unknown = await generateApiKey({
      kind: "secret",
      environment: "live",
    });

    const res = await app.request(
      "/v1/read-stub",
      { headers: { authorization: `Bearer ${unknown.plaintext}` } },
      env,
    );

    expect(res.status).toBe(401);
    expect(limiter.keys).toEqual([]);
  });
});
