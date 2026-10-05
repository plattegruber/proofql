/**
 * The auth cache's own contract (#108, #158): the isolate tier, the Cache
 * API tier on a custom domain (never on `*.workers.dev`), freshness and
 * the stale window, and that nothing which does not parse as a current
 * entry is ever served. Whether `requireApiKey` consults it correctly is
 * the integration test.
 */

import { createLogger, silentSink } from "@proofql/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { fakeEdgeCache, testEnv } from "../test/helpers.js";
import {
  AUTH_CACHE_TTL_SECONDS,
  AUTH_STALE_SECONDS,
  AuthCache,
  type AuthCacheEntry,
  getCachedAuth,
  isAuthCacheEntry,
  putCachedAuth,
} from "./auth-cache.js";
import type { AppEnv, AuthContext } from "./bindings.js";
import {
  type EdgeCacheLike,
  edgeCacheUrl,
  GenerationMemo,
  MissCounter,
} from "./edge-cache.js";

const HASH = "a".repeat(64);

const auth: AuthContext = {
  apiKeyId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  environment: "live",
  kind: "publishable",
  plan: "paid",
  project: {
    allowedOrigins: ["https://shop.example"],
    minRating: 4,
    similarityFloor: 0.55,
  },
};

/** A tiny app exposing put/get over one shared AuthCache and edge cache. */
function harness(edge: EdgeCacheLike | null, now: () => number) {
  const cache = new AuthCache({ now });
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("authCache", cache);
    c.set("edge", {
      cache: edge,
      missCounter: new MissCounter({ windowMs: 1 }),
      generations: new GenerationMemo(0),
    });
    c.set(
      "log",
      createLogger({ service: "api", environment: "test", sink: silentSink }),
    );
    await next();
  });
  app.get("/put", (c) => {
    putCachedAuth(c, HASH, { auth, lastUsedAt: null, generation: 2 });
    return c.json("ok");
  });
  app.get("/get", async (c) => c.json(await getCachedAuth(c, HASH)));
  const call = async (host: string, path: string) =>
    (await app.request(`https://${host}${path}`, {}, testEnv())).json();
  return { cache, call };
}

describe("isolate tier", () => {
  it("round-trips the context, last_used_at and generation", async () => {
    const clock = Date.parse("2026-10-04T12:00:00Z");
    const { call } = harness(null, () => clock);
    await call("api.example", "/put");
    expect(await call("api.example", "/get")).toEqual({
      v: 1,
      auth,
      lastUsedAt: null,
      generation: 2,
      storedAt: "2026-10-04T12:00:00.000Z",
    });
  });

  it("is fresh for the TTL, then kept (stale) until the stale window ends", async () => {
    let clock = Date.parse("2026-10-04T12:00:00Z");
    const { cache, call } = harness(null, () => clock);
    await call("api.example", "/put");
    const entry = (await call("api.example", "/get")) as AuthCacheEntry;
    expect(cache.isFresh(entry)).toBe(true);
    clock += AUTH_CACHE_TTL_SECONDS * 1000;
    expect(cache.isFresh(entry)).toBe(false);
    expect(await call("api.example", "/get")).not.toBeNull();
    clock += (AUTH_STALE_SECONDS - AUTH_CACHE_TTL_SECONDS) * 1000;
    expect(await call("api.example", "/get")).toBeNull();
  });
});

describe("Cache API tier", () => {
  it("on a custom domain, stores under the reserved path and a fresh isolate finds it", async () => {
    const clock = Date.parse("2026-10-04T12:00:00Z");
    const edge = fakeEdgeCache({ now: () => clock });
    const first = harness(edge, () => clock);
    await first.call("api.proofql.com", "/put");
    // `waitUntil` has no execution context under app.request: detached.
    await new Promise((r) => setTimeout(r, 0));
    const url = edgeCacheUrl("https://api.proofql.com/", "auth", HASH);
    expect(url).toBe(`https://api.proofql.com/__proofql_cache/auth/${HASH}`);
    expect(edge.store.has(url)).toBe(true);
    expect(edge.store.get(url)?.headers).toContainEqual([
      "cache-control",
      `max-age=${AUTH_STALE_SECONDS}`,
    ]);

    const second = harness(edge, () => clock);
    expect(await second.call("api.proofql.com", "/get")).toMatchObject({
      generation: 2,
      auth: { projectId: auth.projectId },
    });
  });

  it("is never used on *.workers.dev, where put is a no-op", async () => {
    const clock = Date.now();
    const edge = fakeEdgeCache();
    const { call } = harness(edge, () => clock);
    await call("proofql-api-preview.x.workers.dev", "/put");
    await call("proofql-api-preview.x.workers.dev", "/get");
    await new Promise((r) => setTimeout(r, 0));
    expect(edge.calls).toEqual({ puts: 0, matches: 0 });
  });

  it("a throwing Cache API is a miss, not an error", async () => {
    const broken: EdgeCacheLike = {
      match: async () => {
        throw new Error("cache down");
      },
      put: async () => {
        throw new Error("cache down");
      },
    };
    const { call } = harness(broken, Date.now);
    expect(await call("api.proofql.com", "/put")).toBe("ok");
    expect(await call("api.proofql.com", "/get")).not.toBeNull(); // isolate tier
    const other = harness(broken, Date.now);
    expect(await other.call("api.proofql.com", "/get")).toBeNull();
  });

  it("ignores an entry that does not parse", async () => {
    const edge = fakeEdgeCache();
    await edge.put(
      edgeCacheUrl("https://api.proofql.com/", "auth", HASH),
      new Response(JSON.stringify({ v: 1, auth: { ...auth, plan: "x" } }), {
        headers: { "cache-control": "max-age=60" },
      }),
    );
    const { call } = harness(edge, Date.now);
    expect(await call("api.proofql.com", "/get")).toBeNull();
  });
});

describe("isAuthCacheEntry", () => {
  const good: AuthCacheEntry = {
    v: 1,
    auth,
    lastUsedAt: null,
    generation: 3,
    storedAt: "2026-10-04T12:00:00.000Z",
  };

  it("accepts a complete entry, and one whose generation was unknown (-1)", () => {
    expect(isAuthCacheEntry(good)).toBe(true);
    expect(isAuthCacheEntry({ ...good, generation: -1 })).toBe(true);
  });

  it.each([
    ["kind", { ...good, auth: { ...auth, kind: "admin" } }],
    ["environment", { ...good, auth: { ...auth, environment: "staging" } }],
    ["plan", { ...good, auth: { ...auth, plan: 1 } }],
    ["generation", { ...good, generation: "3" }],
    ["negative generation", { ...good, generation: -2 }],
    ["storedAt", { ...good, storedAt: "x" }],
    ["lastUsedAt", { ...good, lastUsedAt: 5 }],
    [
      "allowedOrigins",
      {
        ...good,
        auth: { ...auth, project: { ...auth.project, allowedOrigins: "x" } },
      },
    ],
    [
      "minRating",
      {
        ...good,
        auth: { ...auth, project: { ...auth.project, minRating: "4" } },
      },
    ],
    ["project", { ...good, auth: { ...auth, project: null } }],
    ["null", null],
    ["array", []],
  ])("rejects a bad %s", (_name, value) => {
    expect(isAuthCacheEntry(value)).toBe(false);
  });
});
