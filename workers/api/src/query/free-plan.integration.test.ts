/**
 * `/v1/query` within the Workers Free plan's quotas (#158), end to end
 * against a real database:
 *
 * - on a custom domain results go to the Cache API, never to KV, and the
 *   generation in the key still purges them;
 * - on `*.workers.dev` they go to KV only on their second MISS (the write
 *   budget);
 * - a KV binding that throws the literal daily-limit errors on every get
 *   and put degrades the request (uncachable, swallowed writes) and never
 *   fails it, and a review edit's generation bump is swallowed the same way;
 * - Hyperdrive's daily-limit error is a 503 with `Retry-After` on a MISS
 *   while HITs keep being served.
 */

import { FakeEmbeddingProvider, fakeEmbed } from "@proofql/ai";
import {
  bumpProjectGeneration,
  exhaustedKv,
  recordingSink,
} from "@proofql/core";
import type { Db } from "@proofql/db";
import { chunk, project, review, setupTestDb } from "@proofql/db/test";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  fakeCtx,
  fakeEdgeCache,
  fakeKv,
  issueKey,
  testEnv,
} from "../../test/helpers.js";
import { type CreateAppOptions, createApp } from "../app.js";
import { AuthCache } from "../auth-cache.js";
import type { ApiBindings, AppEnv } from "../bindings.js";

const t = setupTestDb();

const TEXT = "My implant feels like my own tooth.";

async function fixture(db: Db) {
  const p = await project(db, { minRating: 1, similarityFloor: 0.3 });
  const r = await review(db, { projectId: p.id, text: TEXT, rating: 5 });
  await chunk(db, {
    reviewId: r.id,
    kind: "full",
    text: TEXT,
    startOffset: 0,
    embedding: fakeEmbed([TEXT])[0] ?? null,
  });
  const secret = await issueKey(db, p.id, "secret");
  return { project: p, reviewId: r.id, secret: secret.plaintext };
}

function app(options: Partial<CreateAppOptions> = {}): Hono<AppEnv> {
  return createApp({
    db: t.db,
    embedder: new FakeEmbeddingProvider(),
    rateLimiter: { limit: async () => ({ success: true }) },
    ...options,
  });
}

async function query(
  a: Hono<AppEnv>,
  env: ApiBindings,
  key: string,
  q: string,
  host = "http://localhost",
): Promise<Response> {
  const ctx = fakeCtx();
  const res = await a.request(
    `${host}/v1/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ q }),
    },
    env,
    ctx.asExecutionContext(),
  );
  await ctx.flush();
  return res;
}

const qKeys = (kv: ReturnType<typeof fakeKv>) =>
  [...kv.store.keys()].filter((k) => k.startsWith("q:"));

describe("query cache on a custom domain: the Cache API, not KV", () => {
  it("stores in the Cache API with the TTL as max-age, serves HITs from it, writes no KV", async () => {
    const f = await fixture(t.db);
    const kv = fakeKv();
    const env = testEnv({ kv });
    const edge = fakeEdgeCache();
    const a = app({ edgeCache: edge });
    const host = "https://api.proofql.com";

    const miss = await query(a, env, f.secret, "implant tooth", host);
    expect(miss.status).toBe(200);
    expect(miss.headers.get("x-cache")).toBe("MISS");
    const keys = [...edge.store.keys()].filter((k) =>
      k.includes("/__proofql_cache/q/"),
    );
    expect(keys).toHaveLength(1);
    // The resolved key went to the Cache API as well, not to KV.
    expect(
      [...edge.store.keys()].filter((k) =>
        k.includes("/__proofql_cache/auth/"),
      ),
    ).toHaveLength(1);
    expect(keys[0]).toMatch(
      new RegExp(
        `^${host}/__proofql_cache/q/q%3A${f.project.id}%3Alive%3A0%3A`,
      ),
    );
    expect(edge.store.get(keys[0] as string)?.headers).toContainEqual([
      "cache-control",
      "max-age=86400",
    ]);

    const hit = await query(a, env, f.secret, "implant tooth", host);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(((await hit.json()) as { cached: boolean }).cached).toBe(true);
    // Nothing but the generation read touched KV.
    expect(qKeys(kv)).toEqual([]);
    expect([...kv.store.keys()]).toEqual([]);

    // Purge-by-generation still works: a bump moves the key.
    await bumpProjectGeneration(kv, f.project.id);
    const after = await query(a, env, f.secret, "implant tooth", host);
    expect(after.headers.get("x-cache")).toBe("MISS");
    expect(
      [...edge.store.keys()].filter((k) => k.includes("/__proofql_cache/q/")),
    ).toHaveLength(2);
  });

  it("on *.workers.dev the Cache API is never touched; KV is the cache", async () => {
    const f = await fixture(t.db);
    const kv = fakeKv();
    const env = testEnv({ kv });
    const edge = fakeEdgeCache();
    const a = app({ edgeCache: edge });
    const host = "https://proofql-api-preview.x.workers.dev";
    await query(a, env, f.secret, "implant tooth", host);
    const hit = await query(a, env, f.secret, "implant tooth", host);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(edge.calls).toEqual({ puts: 0, matches: 0 });
    expect(qKeys(kv)).toHaveLength(1);
  });
});

describe("the KV write budget", () => {
  it("writes a result only on its second MISS; one-off queries never write", async () => {
    const f = await fixture(t.db);
    const kv = fakeKv();
    const env = testEnv({ kv });
    const a = app({ kvWriteAfterMisses: 2 });

    for (const q of ["implant", "tooth", "own tooth", "feels"]) {
      expect((await query(a, env, f.secret, q)).headers.get("x-cache")).toBe(
        "MISS",
      );
    }
    expect(qKeys(kv)).toEqual([]);

    expect(
      (await query(a, env, f.secret, "implant")).headers.get("x-cache"),
    ).toBe("MISS");
    expect(qKeys(kv)).toHaveLength(1);
    expect(
      (await query(a, env, f.secret, "implant")).headers.get("x-cache"),
    ).toBe("HIT");
  });
});

describe("KV at its daily limits (literal Cloudflare errors)", () => {
  it("reads exhausted: every query is answered, uncachable, with no KV write attempted", async () => {
    const f = await fixture(t.db);
    const kv = exhaustedKv();
    const env = testEnv();
    env.CACHE = kv as unknown as KVNamespace;
    const rec = recordingSink();
    const a = app({ logSink: rec.sink });

    for (let i = 0; i < 3; i++) {
      const res = await query(a, env, f.secret, "implant tooth");
      expect(res.status).toBe(200);
      expect(res.headers.get("x-cache")).toBe("MISS");
    }
    expect(kv.calls.put).toBe(0);
    expect(kv.calls.getWithMetadata).toBe(0);
    // Logged once per isolate per minute, at warn.
    expect(rec.find("kv.limit_exceeded")).toHaveLength(1);
    expect(rec.find("kv.limit_exceeded")[0]).toMatchObject({ level: "warn" });
    expect(rec.find("request.failed")).toEqual([]);
  });

  it("writes exhausted: results are not stored, the request still succeeds", async () => {
    const f = await fixture(t.db);
    const kv = exhaustedKv({ reads: false });
    const env = testEnv();
    env.CACHE = kv as unknown as KVNamespace;
    const rec = recordingSink();
    const a = app({ logSink: rec.sink });

    for (let i = 0; i < 2; i++) {
      const res = await query(a, env, f.secret, "implant tooth");
      expect(res.status).toBe(200);
      expect(res.headers.get("x-cache")).toBe("MISS");
    }
    expect(kv.calls.put).toBe(2);
    expect(rec.only("kv.limit_exceeded")).toMatchObject({
      level: "warn",
      op: "put",
      site: "api.query_cache",
    });
  });

  it("a review edit whose generation bump hits the write limit still succeeds", async () => {
    const f = await fixture(t.db);
    const env = testEnv();
    env.CACHE = exhaustedKv({ reads: false }) as unknown as KVNamespace;
    const a = app();
    const patch = await a.request(
      `/v1/reviews/${f.reviewId}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${f.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ hidden: true }),
      },
      env,
    );
    expect(patch.status).toBe(200);
    const del = await a.request(
      `/v1/reviews/${f.reviewId}`,
      { method: "DELETE", headers: { authorization: `Bearer ${f.secret}` } },
      env,
    );
    expect(del.status).toBe(204);
  });
});

describe("Hyperdrive at its daily limit (#142)", () => {
  it("a MISS is a 503 with Retry-After; a HIT is still served", async () => {
    const f = await fixture(t.db);
    const kv = fakeKv();
    const env = testEnv({ kv });
    const authCache = new AuthCache();
    // Prime auth and the result cache with a working database.
    await query(app({ authCache }), env, f.secret, "implant tooth");

    const rec = recordingSink();
    const limited = createApp({
      authCache,
      embedder: new FakeEmbeddingProvider(),
      rateLimiter: { limit: async () => ({ success: true }) },
      logSink: rec.sink,
      usageWriter: async () => {},
      usageFlushMs: 0,
      dbProvider: () => {
        throw Object.assign(
          new Error(
            "Usage limit for account exceeded, usage renews at 2099-01-01 00:00:00 UTC",
          ),
          { name: "PostgresError" },
        );
      },
    });

    const hit = await query(limited, env, f.secret, "implant tooth");
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-cache")).toBe("HIT");

    const miss = await query(limited, env, f.secret, "something new");
    expect(miss.status).toBe(503);
    expect(Number(miss.headers.get("Retry-After"))).toBeGreaterThan(86_400);
    expect(
      ((await miss.json()) as { error: { code: string } }).error.code,
    ).toBe("service_unavailable");
    expect(rec.only("quota.exhausted")).toMatchObject({
      level: "error",
      resource: "hyperdrive",
    });
  });
});
