/**
 * The KV query cache through the real `/v1/query` route (#28): the app over
 * the harness database, the deterministic fake embedder, and the Map-backed
 * fake KV from test/helpers.ts standing in for `env.CACHE`. Asserts the
 * HIT/MISS/BYPASS contract, byte-identical results on a hit, purge through
 * the generation counter when a review is hidden, that errors are never
 * stored, and that a broken KV degrades to a miss. Quota interplay (a hit
 * at quota is served and counted as free) lives in ../quota.integration.test.ts.
 */

import { FakeEmbeddingProvider, fakeEmbed } from "@proofql/ai";
import { generationKey } from "@proofql/core";
import type { Db } from "@proofql/db";
import { chunk, project, review, setupTestDb } from "@proofql/db/test";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { fakeCtx, fakeKv, issueKey, testEnv } from "../../test/helpers.js";
import { createApp } from "../app.js";
import type { ApiBindings, AppEnv } from "../bindings.js";
import type { ErrorEnvelope } from "../errors.js";
import type { QueryResponse } from "./route.js";

const t = setupTestDb();

const ORIGIN = "https://shop.example";
const IMPLANT = "My implant feels like my own tooth.";
const CLEANING = "Painless cleaning, very gentle hygienist.";

/** A review with its embedded `full` chunk — what the pipeline produces. */
async function indexed(
  db: Db,
  projectId: string,
  text: string,
  occurredAt: Date,
): Promise<string> {
  const r = await review(db, {
    projectId,
    text,
    rating: 5,
    occurredAt,
    indexedAt: new Date(),
  });
  const [embedding] = fakeEmbed([text]);
  await chunk(db, {
    reviewId: r.id,
    kind: "full",
    text,
    startOffset: 0,
    embedding,
  });
  return r.id;
}

async function fixture() {
  // Floor pinned, not the column default: these tests are about the cache,
  // and "implant tooth" scores 0.632 against IMPLANT under the fake
  // embedder — above 0.55, below the bge-m3-tuned default (#138).
  const p = await project(t.db, {
    allowedOrigins: [ORIGIN],
    similarityFloor: 0.55,
  });
  const secret = (await issueKey(t.db, p.id, "secret")).plaintext;
  const publishable = (await issueKey(t.db, p.id, "publishable")).plaintext;
  const implant = await indexed(
    t.db,
    p.id,
    IMPLANT,
    new Date("2026-03-01T00:00:00Z"),
  );
  const cleaning = await indexed(
    t.db,
    p.id,
    CLEANING,
    new Date("2026-02-01T00:00:00Z"),
  );
  const kv = fakeKv();
  return {
    project: p,
    secret,
    publishable,
    implant,
    cleaning,
    kv,
    env: testEnv({ kv }),
    app: createApp({ db: t.db, embedder: new FakeEmbeddingProvider() }),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

interface CallOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  env?: ApiBindings;
  app?: Hono<AppEnv>;
}

/** POST (default) or GET `/v1/query`, flushing post-response work. */
async function query(
  f: Fixture,
  key: string,
  body: Record<string, unknown>,
  options: CallOptions = {},
) {
  const ctx = fakeCtx();
  const method = options.method ?? "POST";
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    ...options.headers,
  };
  let path = "/v1/query";
  const init: RequestInit = { method, headers };
  if (method === "GET") {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) params.set(k, String(v));
    path += `?${params}`;
  } else {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await (options.app ?? f.app).request(
    path,
    init,
    options.env ?? f.env,
    ctx.asExecutionContext(),
  );
  await ctx.flush();
  const text = await res.text();
  return {
    res,
    text,
    json: JSON.parse(text) as QueryResponse & ErrorEnvelope,
    cache: res.headers.get("x-cache"),
  };
}

/** Keys of cached query entries (not the generation counter). */
function cachedKeys(f: Fixture): string[] {
  return [...f.kv.store.keys()].filter((k) => k.startsWith("q:"));
}

async function hide(f: Fixture, reviewId: string) {
  const res = await f.app.request(
    `/v1/reviews/${reviewId}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${f.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ hidden: true }),
    },
    f.env,
  );
  expect(res.status).toBe(200);
}

describe("/v1/query KV cache", () => {
  it("first query is a MISS, the identical query a HIT with byte-identical results", async () => {
    const f = await fixture();

    const first = await query(f, f.secret, { q: "implant tooth" });
    expect(first.res.status).toBe(200);
    expect(first.cache).toBe("MISS");
    expect(first.json.cached).toBe(false);
    expect(first.json.results.map((r) => r.review.id)).toEqual([f.implant]);
    expect(cachedKeys(f)).toHaveLength(1);
    expect(f.kv.store.get(cachedKeys(f)[0] ?? "")?.metadata).toEqual({
      generation: 0,
      storedAt: expect.any(String),
    });

    const second = await query(f, f.secret, { q: "implant tooth" });
    expect(second.res.status).toBe(200);
    expect(second.cache).toBe("HIT");
    expect(second.json.cached).toBe(true);
    expect(second.json.badge).toBe(true);
    expect(typeof second.json.took_ms).toBe("number");
    expect(JSON.stringify(second.json.results)).toBe(
      JSON.stringify(first.json.results),
    );
    expect(cachedKeys(f)).toHaveLength(1);
  });

  it("the key is the normalized request: whitespace, case, verb, and filter order do not matter", async () => {
    const f = await fixture();
    await query(f, f.secret, {
      q: "implant tooth",
      filters: { source: ["google", "yelp"], "metadata.a": "1", min_rating: 4 },
    });

    const spaced = await query(f, f.secret, {
      q: "  Implant \t TOOTH ",
      filters: {
        min_rating: 4,
        metadata: { a: "1" },
        source: ["yelp", "google"],
      },
    });
    expect(spaced.cache).toBe("HIT");

    const asGet = await query(
      f,
      f.secret,
      {
        q: "implant tooth",
        source: "yelp,google",
        "metadata.a": "1",
        min_rating: "4",
      },
      { method: "GET" },
    );
    expect(asGet.cache).toBe("HIT");
    expect(cachedKeys(f)).toHaveLength(1);
  });

  it("a different q, limit, mode, or filter is a MISS", async () => {
    const f = await fixture();
    await query(f, f.secret, { q: "implant tooth" });

    expect((await query(f, f.secret, { q: "gentle cleaning" })).cache).toBe(
      "MISS",
    );
    expect(
      (await query(f, f.secret, { q: "implant tooth", limit: 1 })).cache,
    ).toBe("MISS");
    expect(
      (await query(f, f.secret, { q: "implant tooth", mode: "reviews" })).cache,
    ).toBe("MISS");
    expect(
      (
        await query(f, f.secret, {
          q: "implant tooth",
          filters: { source: ["yelp"] },
        })
      ).cache,
    ).toBe("MISS");
    expect(cachedKeys(f)).toHaveLength(5);
  });

  it("no-q (newest) queries are cached too", async () => {
    const f = await fixture();
    const first = await query(f, f.secret, {});
    expect(first.cache).toBe("MISS");
    expect(first.json.results.map((r) => r.review.id)).toEqual([
      f.implant,
      f.cleaning,
    ]);
    const second = await query(f, f.secret, {});
    expect(second.cache).toBe("HIT");
    expect(second.json.results).toEqual(first.json.results);
  });

  it("hiding a review bumps the generation: the next query is a MISS without the review", async () => {
    const f = await fixture();
    const before = await query(f, f.secret, {});
    expect(before.json.results.map((r) => r.review.id)).toEqual([
      f.implant,
      f.cleaning,
    ]);
    expect((await query(f, f.secret, {})).cache).toBe("HIT");

    await hide(f, f.implant);
    expect(f.kv.peek(generationKey(f.project.id))).toBe("1");

    const after = await query(f, f.secret, {});
    expect(after.cache).toBe("MISS");
    expect(after.json.cached).toBe(false);
    expect(after.json.results.map((r) => r.review.id)).toEqual([f.cleaning]);
    // The old entry is orphaned under generation 0, the new one keyed on 1.
    expect(
      cachedKeys(f)
        .map((k) => k.split(":")[3])
        .sort(),
    ).toEqual(["0", "1"]);
    expect((await query(f, f.secret, {})).cache).toBe("HIT");
  });

  it("Cache-Control: no-cache bypasses the lookup but still stores", async () => {
    const f = await fixture();
    await query(f, f.secret, { q: "implant tooth" });

    const bypass = await query(
      f,
      f.secret,
      { q: "implant tooth" },
      { headers: { "cache-control": "no-cache" } },
    );
    expect(bypass.cache).toBe("BYPASS");
    expect(bypass.json.cached).toBe(false);
    expect(bypass.json.results.map((r) => r.review.id)).toEqual([f.implant]);

    // The bypass refreshed the entry; a normal request hits it.
    expect((await query(f, f.secret, { q: "implant tooth" })).cache).toBe(
      "HIT",
    );
    expect(cachedKeys(f)).toHaveLength(1);

    // A fresh project: the first request with no-cache still populates.
    const g = await fixture();
    expect(
      (
        await query(
          g,
          g.secret,
          { q: "implant tooth" },
          { headers: { "cache-control": "max-age=0, no-cache" } },
        )
      ).cache,
    ).toBe("BYPASS");
    expect((await query(g, g.secret, { q: "implant tooth" })).cache).toBe(
      "HIT",
    );
  });

  it("a HIT for a publishable key carries the CORS headers for its origin", async () => {
    const f = await fixture();
    const miss = await query(
      f,
      f.publishable,
      { q: "implant tooth" },
      { headers: { origin: ORIGIN } },
    );
    expect(miss.cache).toBe("MISS");
    expect(miss.res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);

    const hit = await query(
      f,
      f.publishable,
      { q: "implant tooth" },
      { headers: { origin: ORIGIN } },
    );
    expect(hit.res.status).toBe(200);
    expect(hit.cache).toBe("HIT");
    expect(hit.res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(hit.res.headers.get("Vary")).toBe("Origin");
    expect(hit.json.cached).toBe(true);

    // Secret and publishable keys of one project share the entry.
    expect(cachedKeys(f)).toHaveLength(1);

    // An unlisted origin is refused before the cache is consulted.
    const refused = await query(
      f,
      f.publishable,
      { q: "implant tooth" },
      { headers: { origin: "https://evil.example" } },
    );
    expect(refused.res.status).toBe(403);
    expect(refused.cache).toBeNull();
  });

  it("errors are never stored: 422 and 503 leave the cache untouched", async () => {
    const f = await fixture();
    const invalid = await query(f, f.secret, { limt: 3 });
    expect(invalid.res.status).toBe(422);
    expect(invalid.cache).toBeNull();

    const failing = createApp({
      db: t.db,
      embedder: new FakeEmbeddingProvider({
        shouldFail: () => new Error("Workers AI is down"),
      }),
    });
    const outage = await query(
      f,
      f.secret,
      { q: "implant tooth" },
      { app: failing },
    );
    expect(outage.res.status).toBe(503);
    expect(outage.json.error.code).toBe("embedding_unavailable");
    expect(cachedKeys(f)).toEqual([]);
  });

  it("a KV outage degrades to a MISS rather than an error", async () => {
    const f = await fixture();
    const broken = fakeKv();
    broken.getWithMetadata = async () => {
      throw new Error("KV unavailable");
    };
    const res = await query(
      f,
      f.secret,
      { q: "implant tooth" },
      { env: testEnv({ kv: broken }) },
    );
    expect(res.res.status).toBe(200);
    expect(res.cache).toBe("MISS");
    expect(res.json.results.map((r) => r.review.id)).toEqual([f.implant]);
  });

  it("test and live keys of one project never share an entry", async () => {
    const f = await fixture();
    const testKey = (await issueKey(t.db, f.project.id, "secret", "test"))
      .plaintext;
    await query(f, f.secret, { q: "implant tooth" });
    const other = await query(f, testKey, { q: "implant tooth" });
    expect(other.cache).toBe("MISS");
    expect(other.json.results).toEqual([]); // nothing indexed in `test`
    expect(cachedKeys(f)).toHaveLength(2);
  });
});
