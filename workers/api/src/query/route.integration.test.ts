/**
 * `/v1/query` end to end against a real database (#26, #27): the app is
 * built with the harness `Db` and the deterministic fake embedder from
 * `@proofql/ai` (hashed bag of content words: shared vocabulary → near,
 * unrelated → orthogonal), so these tests assert auth, CORS, policy, the
 * floor, modes, and the response contract — not bge-m3's semantics.
 *
 * The fixture mirrors the demo seed's shape: one project, several reviews
 * on distinct topics, each indexed as a `full` chunk, including a
 * low-rated topical review and a hidden one that must never render.
 */

import { FakeEmbeddingProvider, fakeEmbed } from "@proofql/ai";
import {
  bumpProjectGeneration,
  chunkReview,
  generateApiKey,
  recordingSink,
} from "@proofql/core";
import { type Db, setAccountPlan } from "@proofql/db";
import {
  type ApiKey,
  account,
  chunk,
  type Project,
  project,
  review,
  setupTestDb,
} from "@proofql/db/test";
import type { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

import { fakeKv, issueKey, testEnv } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { AUTH_CACHE_TTL_SECONDS } from "../auth-cache.js";
import type { ApiBindings, AppEnv } from "../bindings.js";
import type { ErrorEnvelope } from "../errors.js";
import type { QueryResponse } from "./route.js";

const t = setupTestDb();

/**
 * One fake KV for the whole file, so repeated identical queries exercise
 * the cache's HIT path (#28) as they would in production; the assertions
 * here hold either way, since a hit returns what the miss computed.
 */
const env = testEnv();

const ORIGIN = "https://shop.example";
const OTHER_ORIGIN = "https://evil.example";

// Short on purpose: the fake embedder's cosine is shared/sqrt(|q|·|review|)
// over content words, so with a two-word query a review may have at most six
// content words to clear the 0.55 floor. Each text below is annotated with
// its content-word count.
const IMPLANT = "My implant feels like my own tooth."; // 5
const CLEANING = "Painless cleaning, very gentle hygienist."; // 5
const PARKING = "Parking behind the building was easy."; // 4
const BAD_IMPLANT = "Implant consult was a waste, tooth hurts."; // 5, rated 1
const HIDDEN_IMPLANT = "Implant tooth went fine, hidden by owner."; // 6, hidden

interface Fixture {
  project: Project;
  secret: string;
  publishable: string;
  secretKey: ApiKey;
  reviews: Record<
    "implant" | "cleaning" | "parking" | "badImplant" | "hidden",
    string
  >;
}

function embed(text: string): number[] {
  const [vector] = fakeEmbed([text]);
  if (!vector) throw new Error("fakeEmbed returned nothing");
  return vector;
}

/** A review with its embedded `full` chunk — what the pipeline produces. */
async function indexed(
  db: Db,
  projectId: string,
  text: string,
  overrides: Parameters<typeof review>[1] = {},
): Promise<string> {
  const r = await review(db, { projectId, text, ...overrides });
  await chunk(db, {
    reviewId: r.id,
    kind: "full",
    text,
    startOffset: 0,
    embedding: embed(text),
  });
  return r.id;
}

/**
 * A longer review: its `full` chunk plus an embedded `window` chunk for
 * every substring in `windows`, each at its UTF-16 offset — what the
 * pipeline's chunker produces (`chunkReview` in @proofql/core).
 */
async function indexedWindows(
  db: Db,
  projectId: string,
  text: string,
  windows: string[],
  overrides: Parameters<typeof review>[1] = {},
): Promise<string> {
  const id = await indexed(db, projectId, text, overrides);
  for (const w of windows) {
    const startOffset = text.indexOf(w);
    if (startOffset < 0) throw new Error(`window not in review: ${w}`);
    await chunk(db, {
      reviewId: id,
      kind: "window",
      text: w,
      startOffset,
      embedding: embed(w),
    });
  }
  return id;
}

/**
 * A review indexed exactly as the pipeline indexes it: every chunk
 * `chunkReview` emits (`full`, `window`s, `sentence`s; #127), embedded.
 */
async function indexedByChunker(
  db: Db,
  projectId: string,
  text: string,
  overrides: Parameters<typeof review>[1] = {},
): Promise<string> {
  const r = await review(db, { projectId, text, ...overrides });
  const chunks = chunkReview(text, { locale: r.language });
  const vectors = fakeEmbed(chunks.map((c) => c.text));
  for (const [i, c] of chunks.entries()) {
    await chunk(db, {
      reviewId: r.id,
      kind: c.kind,
      text: c.text,
      startOffset: c.startOffset,
      embedding: vectors[i] ?? null,
    });
  }
  return r.id;
}

const makeKey = (
  db: Db,
  projectId: string,
  kind: "secret" | "publishable",
): Promise<{ plaintext: string; row: ApiKey }> => issueKey(db, projectId, kind);

async function fixture(
  db: Db,
  overrides: Partial<Project> = {},
): Promise<Fixture> {
  const p = await project(db, {
    allowedOrigins: [ORIGIN, "http://localhost:3000"],
    minRating: 4,
    similarityFloor: 0.55,
    showBadge: true,
    ...overrides,
  });
  const secret = await makeKey(db, p.id, "secret");
  const publishable = await makeKey(db, p.id, "publishable");
  const reviews = {
    implant: await indexed(db, p.id, IMPLANT, {
      rating: 5,
      source: "google",
      occurredAt: new Date("2026-03-01T00:00:00Z"),
      metadata: { location: "north" },
      url: "https://maps.google.com/implant",
    }),
    cleaning: await indexed(db, p.id, CLEANING, {
      rating: 4,
      source: "yelp",
      occurredAt: new Date("2026-02-01T00:00:00Z"),
      metadata: { location: "south" },
    }),
    parking: await indexed(db, p.id, PARKING, {
      rating: 5,
      source: "google",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    }),
    // Topical and keyword-heavy, but one star: policy must drop it.
    badImplant: await indexed(db, p.id, BAD_IMPLANT, {
      rating: 1,
      occurredAt: new Date("2026-03-10T00:00:00Z"),
    }),
    hidden: await indexed(db, p.id, HIDDEN_IMPLANT, {
      rating: 5,
      hiddenAt: new Date("2026-03-11T00:00:00Z"),
      occurredAt: new Date("2026-03-12T00:00:00Z"),
    }),
  };
  return {
    project: p,
    secret: secret.plaintext,
    publishable: publishable.plaintext,
    secretKey: secret.row,
    reviews,
  };
}

function appWith(embedder = new FakeEmbeddingProvider()): Hono<AppEnv> {
  return createApp({ db: t.db, embedder });
}

async function post(
  app: Hono<AppEnv>,
  key: string,
  body: unknown,
  headers: Record<string, string> = {},
  bindings: ApiBindings = env,
): Promise<Response> {
  return app.request(
    "/v1/query",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
}

async function get(
  app: Hono<AppEnv>,
  qs: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(`/v1/query?${qs}`, { method: "GET", headers }, env);
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("/v1/query", () => {
  let f: Fixture;
  let app: Hono<AppEnv>;

  beforeAll(async () => {
    f = await fixture(t.db);
    app = appWith();
  });

  describe("hybrid search with a secret key", () => {
    it("returns the topical, publishable review with score = cosine similarity", async () => {
      const res = await post(app, f.secret, { q: "implant tooth" });

      expect(res.status).toBe(200);
      expect(res.headers.get("Vary")).toBe("Origin");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      const body = await json<QueryResponse>(res);
      expect(body.results.map((r) => r.review.id)).toEqual([f.reviews.implant]);
      const [top] = body.results;
      expect(top?.excerpt).toBe(IMPLANT);
      expect(top?.excerpt_id).toMatch(/^[0-9a-f-]{36}$/);
      // {implant, tooth} ∩ five content words = 2: cosine 2/sqrt(2·5).
      expect(top?.score).toBeCloseTo(2 / Math.sqrt(10), 3);
      expect(top?.review).toEqual({
        id: f.reviews.implant,
        rating: 5,
        author_name: expect.stringMatching(/^Author \d+$/),
        author_avatar_url: null,
        source: "google",
        occurred_at: "2026-03-01T00:00:00.000Z",
        url: "https://maps.google.com/implant",
        metadata: { location: "north" },
      });
      expect(top?.review).not.toHaveProperty("text");
      expect(body.cached).toBe(false);
      expect(body.badge).toBe(true);
      expect(typeof body.took_ms).toBe("number");
    });

    it("excludes the low-rated topical review and the hidden one", async () => {
      // Both clear the floor for this query (cosine 0.63 and 0.58); policy,
      // not relevance, removes them.
      const res = await post(app, f.secret, { q: "implant tooth", limit: 20 });
      const ids = (await json<QueryResponse>(res)).results.map(
        (r) => r.review.id,
      );
      expect(ids).toEqual([f.reviews.implant]);

      // Proof the one-star review is topical: a project whose policy admits
      // one-star reviews returns it. The hidden one stays hidden regardless.
      const lax = await fixture(t.db, { minRating: 1 });
      const laxIds = (
        await json<QueryResponse>(
          await post(app, lax.secret, { q: "implant tooth", limit: 20 }),
        )
      ).results.map((r) => r.review.id);
      expect(laxIds).toContain(lax.reviews.badImplant);
      expect(laxIds).toContain(lax.reviews.implant);
      expect(laxIds).not.toContain(lax.reviews.hidden);
    });

    it("returns results: [] below the floor rather than padding", async () => {
      const res = await post(app, f.secret, {
        q: "mortgage refinancing rates",
      });
      expect(res.status).toBe(200);
      expect((await json<QueryResponse>(res)).results).toEqual([]);
    });

    it("drops a keyword-only hit that has no vector proximity above the floor", async () => {
      // "parking" shares one word with a four-content-word review:
      // full-text matches, cosine = 0.5 < 0.55.
      const res = await post(app, f.secret, { q: "parking" });
      expect((await json<QueryResponse>(res)).results).toEqual([]);
    });

    it("GET maps query params onto the same handler", async () => {
      const res = await get(app, "q=implant+tooth&limit=2&mode=excerpts", {
        Authorization: `Bearer ${f.secret}`,
      });
      expect(res.status).toBe(200);
      const body = await json<QueryResponse>(res);
      expect(body.results.map((r) => r.review.id)).toEqual([f.reviews.implant]);
    });
  });

  describe("modes", () => {
    it("mode=reviews includes the whole review text; excerpts does not", async () => {
      const reviews = await json<QueryResponse>(
        await post(app, f.secret, { q: "implant tooth", mode: "reviews" }),
      );
      expect(reviews.results[0]?.review.text).toBe(IMPLANT);
      expect(reviews.results[0]?.excerpt).toBe(IMPLANT);

      const excerpts = await json<QueryResponse>(
        await post(app, f.secret, { q: "implant tooth", mode: "excerpts" }),
      );
      expect(excerpts.results[0]?.review).not.toHaveProperty("text");
    });

    it("no q: newest publishable first, score null, policy still applied", async () => {
      const res = await post(app, f.secret, {});
      expect(res.status).toBe(200);
      const body = await json<QueryResponse>(res);
      expect(body.results.map((r) => r.review.id)).toEqual([
        f.reviews.implant, // 2026-03-01
        f.reviews.cleaning, // 2026-02-01
        f.reviews.parking, // 2026-01-01
      ]);
      expect(body.results.every((r) => r.score === null)).toBe(true);
      expect(body.results[0]?.excerpt).toBe(IMPLANT);

      const asGet = await json<QueryResponse>(
        await get(app, "limit=1", { Authorization: `Bearer ${f.secret}` }),
      );
      expect(asGet.results.map((r) => r.review.id)).toEqual([
        f.reviews.implant,
      ]);
    });
  });

  describe("highlight (#85): where the excerpt sits in the whole review", () => {
    // Emoji (a surrogate pair), a symbol, and CJK before the matching
    // sentence: the UTF-16 offset differs from both the code-point and the
    // byte offset, so a wrong unit would fail the slice assertion.
    const LONG =
      "🦷✨ 歯医者さん, five stars. The front desk was warm. My implant feels like my own tooth. Parking was fine too.";
    const WINDOW = "My implant feels like my own tooth.";
    const START = LONG.indexOf(WINDOW);
    let h: Fixture & { long: string };

    beforeAll(async () => {
      const base = await fixture(t.db);
      const long = await indexedWindows(t.db, base.project.id, LONG, [WINDOW], {
        rating: 5,
        occurredAt: new Date("2026-04-01T00:00:00Z"),
      });
      h = { ...base, long };
      // Sanity: the fixture is only meaningful if the units disagree.
      expect([...LONG.slice(0, START)].length).not.toBe(START);
      expect(new TextEncoder().encode(LONG.slice(0, START)).length).not.toBe(
        START,
      );
    });

    /** `review.text.slice(start, end) === excerpt` for every result. */
    function expectVerbatim(body: QueryResponse): void {
      for (const r of body.results) {
        const text = r.review.text;
        expect(text, r.excerpt_id).toBeTypeOf("string");
        if (r.highlight === null) {
          expect(r.excerpt).toBe(text);
        } else {
          expect(r.highlight.end - r.highlight.start).toBe(r.excerpt.length);
          expect(text?.slice(r.highlight.start, r.highlight.end)).toBe(
            r.excerpt,
          );
        }
      }
    }

    it("excerpts: a window match carries its UTF-16 span; a whole-review match is null; include=text adds the text", async () => {
      const body = await json<QueryResponse>(
        await post(app, h.secret, {
          q: "implant tooth",
          include: ["text"],
          limit: 5,
        }),
      );
      const ids = body.results.map((r) => r.review.id);
      expect(ids).toEqual(expect.arrayContaining([h.long, h.reviews.implant]));

      const long = body.results.find((r) => r.review.id === h.long);
      expect(long?.excerpt).toBe(WINDOW);
      expect(long?.highlight).toEqual({
        start: START,
        end: START + WINDOW.length,
      });
      expect(long?.review.text).toBe(LONG);

      const full = body.results.find((r) => r.review.id === h.reviews.implant);
      expect(full?.excerpt).toBe(IMPLANT);
      expect(full?.highlight).toBeNull();
      expect(full?.review.text).toBe(IMPLANT);
      expectVerbatim(body);
    });

    it("excerpts without include: highlight is present, text is not", async () => {
      const body = await json<QueryResponse>(
        await post(app, h.secret, { q: "implant tooth", limit: 5 }),
      );
      const long = body.results.find((r) => r.review.id === h.long);
      expect(long?.highlight).toEqual({
        start: START,
        end: START + WINDOW.length,
      });
      expect(long?.review).not.toHaveProperty("text");
    });

    it("reviews: the same span against the text that is always present", async () => {
      const body = await json<QueryResponse>(
        await post(app, h.secret, {
          q: "implant tooth",
          mode: "reviews",
          limit: 5,
        }),
      );
      const long = body.results.find((r) => r.review.id === h.long);
      expect(long?.review.text).toBe(LONG);
      expect(long?.highlight).toEqual({
        start: START,
        end: START + WINDOW.length,
      });
      expectVerbatim(body);
    });

    it("a sentence chunk narrows the highlight to exactly the sentence that answered (#127)", async () => {
      // Four sentences, indexed by the real chunker (full + two windows +
      // four sentences); only the third is about whitening, so the
      // `sentence` chunk beats the window and the full chunk and the
      // highlight is that one sentence's span — not the 2–3 around it.
      const FOUR =
        "Parking behind the building was easy. 🙏 The front desk was warm. Whitening made a visible difference for my wedding photos. Our kids love the hygienist.";
      const SENTENCE =
        "Whitening made a visible difference for my wedding photos.";
      const id = await indexedByChunker(t.db, h.project.id, FOUR, {
        rating: 5,
        occurredAt: new Date("2025-12-01T00:00:00Z"), // older than `long`
      });

      for (const mode of ["excerpts", "reviews"] as const) {
        const body = await json<QueryResponse>(
          await post(app, h.secret, {
            q: "whitening wedding photos",
            mode,
            include: ["text"],
            limit: 5,
          }),
        );
        // One row for the review, despite its seven chunks.
        expect(body.results.filter((r) => r.review.id === id)).toHaveLength(1);
        const hit = body.results.find((r) => r.review.id === id);
        expect(hit?.excerpt).toBe(SENTENCE);
        expect(hit?.review.text).toBe(FOUR);
        const start = FOUR.indexOf(SENTENCE);
        expect(hit?.highlight).toEqual({ start, end: start + SENTENCE.length });
        expect(
          FOUR.slice(hit?.highlight?.start ?? 0, hit?.highlight?.end ?? 0),
        ).toBe(SENTENCE);
        expectVerbatim(body);
      }
    });

    it("no q: highlight is null on every result, text on request", async () => {
      const body = await json<QueryResponse>(
        await post(app, h.secret, { include: ["text"], limit: 10 }),
      );
      expect(body.results[0]?.review.id).toBe(h.long); // newest
      expect(body.results.every((r) => r.highlight === null)).toBe(true);
      expect(body.results.every((r) => r.score === null)).toBe(true);
      expectVerbatim(body);
    });

    it("GET: include=text, and the cache keeps include variants apart", async () => {
      const auth = { Authorization: `Bearer ${h.secret}` };
      const withText = await json<QueryResponse>(
        await get(app, "q=implant+tooth&include=text&limit=5", auth),
      );
      expect(
        withText.results.every((r) => typeof r.review.text === "string"),
      ).toBe(true);
      // The same query without `include` must not be served the stored
      // `include=text` body: `include` is part of the cache key.
      const without = await json<QueryResponse>(
        await get(app, "q=implant+tooth&limit=5", auth),
      );
      expect(without.results.length).toBe(withText.results.length);
      expect(without.results.every((r) => r.review.text === undefined)).toBe(
        true,
      );
      const bad = await get(app, "q=implant&include=html", auth);
      expect(bad.status).toBe(422);
      expect((await json<ErrorEnvelope>(bad)).error.details?.[0]?.path).toBe(
        "include.0",
      );
    });
  });

  describe("honest fallback (#86): match and matched", () => {
    it("match: query — real matches, every result matched: true", async () => {
      const body = await json<QueryResponse>(
        await post(app, f.secret, { q: "implant tooth", fallback: "recent" }),
      );
      expect(body.match).toBe("query");
      expect(body.results.map((r) => r.review.id)).toEqual([f.reviews.implant]);
      expect(body.results.every((r) => r.matched && r.score !== null)).toBe(
        true,
      );
    });

    it("match: none — the default keeps results: [] (empty beats irrelevant)", async () => {
      for (const extra of [{}, { fallback: "none" }]) {
        const body = await json<QueryResponse>(
          await post(app, f.secret, { q: "mortgage refinancing", ...extra }),
        );
        expect(body.match).toBe("none");
        expect(body.results).toEqual([]);
      }
    });

    it("match: fallback — the newest publishable reviews, labelled, score and highlight null", async () => {
      const body = await json<QueryResponse>(
        await post(app, f.secret, {
          q: "mortgage refinancing",
          fallback: "recent",
          limit: 10,
        }),
      );
      expect(body.match).toBe("fallback");
      // Same order and policy as the no-q statement: hidden and one-star
      // reviews never appear, even as fallback.
      expect(body.results.map((r) => r.review.id)).toEqual([
        f.reviews.implant,
        f.reviews.cleaning,
        f.reviews.parking,
      ]);
      for (const r of body.results) {
        expect(r.matched).toBe(false);
        expect(r.score).toBeNull();
        expect(r.highlight).toBeNull();
      }
    });

    it("match: recent — no q, regardless of fallback", async () => {
      for (const extra of [{}, { fallback: "recent" }]) {
        const body = await json<QueryResponse>(
          await post(app, f.secret, { limit: 2, ...extra }),
        );
        expect(body.match).toBe("recent");
        expect(body.results).toHaveLength(2);
        expect(body.results.every((r) => !r.matched && r.score === null)).toBe(
          true,
        );
      }
    });

    it("never mixes: a partial page is not topped up", async () => {
      // "implant tooth" matches exactly one review; limit 5 leaves room.
      const body = await json<QueryResponse>(
        await post(app, f.secret, {
          q: "implant tooth",
          fallback: "recent",
          limit: 5,
        }),
      );
      expect(body.match).toBe("query");
      expect(body.results).toHaveLength(1);
    });

    it("fallback rows respect the request's filters and min_rating", async () => {
      const body = await json<QueryResponse>(
        await post(app, f.secret, {
          q: "mortgage refinancing",
          fallback: "recent",
          filters: { source: ["yelp"], min_rating: 4 },
        }),
      );
      expect(body.match).toBe("fallback");
      expect(body.results.map((r) => r.review.id)).toEqual([
        f.reviews.cleaning,
      ]);
      const strict = await json<QueryResponse>(
        await post(app, f.secret, {
          q: "mortgage refinancing",
          fallback: "recent",
          filters: { min_rating: 5, since: "2026-02-15" },
        }),
      );
      expect(strict.results.map((r) => r.review.id)).toEqual([
        f.reviews.implant,
      ]);
    });

    it("GET ?fallback=recent, and the cache keeps fallback values apart (and the verdict on a HIT)", async () => {
      const auth = { Authorization: `Bearer ${f.secret}` };
      const none = await get(app, "q=mortgage+refinancing&limit=2", auth);
      expect((await json<QueryResponse>(none)).match).toBe("none");
      const recent = await get(
        app,
        "q=mortgage+refinancing&limit=2&fallback=recent",
        auth,
      );
      const recentBody = await json<QueryResponse>(recent);
      expect(recentBody.match).toBe("fallback");
      expect(recentBody.results).toHaveLength(2);
      // Second identical request is a HIT and still says fallback.
      const hit = await get(
        app,
        "q=mortgage+refinancing&limit=2&fallback=recent",
        auth,
      );
      expect(hit.headers.get("x-cache")).toBe("HIT");
      const hitBody = await json<QueryResponse>(hit);
      expect(hitBody.cached).toBe(true);
      expect(hitBody.match).toBe("fallback");
      expect(hitBody.results).toEqual(recentBody.results);
      // And the no-fallback variant was not overwritten.
      const noneAgain = await get(app, "q=mortgage+refinancing&limit=2", auth);
      expect((await json<QueryResponse>(noneAgain)).match).toBe("none");
      const bad = await get(app, "q=x&fallback=sometimes", auth);
      expect(bad.status).toBe(422);
    });
  });

  describe("filters and policy", () => {
    it("filters.min_rating raises the floor above the project policy", async () => {
      const body = await json<QueryResponse>(
        await post(app, f.secret, { filters: { min_rating: 5 } }),
      );
      expect(body.results.map((r) => r.review.id)).toEqual([
        f.reviews.implant,
        f.reviews.parking,
      ]);
    });

    it("filters.min_rating cannot lower the project policy", async () => {
      const body = await json<QueryResponse>(
        await post(app, f.secret, {
          q: "implant consult waste money",
          filters: { min_rating: 1 },
          limit: 20,
        }),
      );
      expect(body.results.map((r) => r.review.id)).not.toContain(
        f.reviews.badImplant,
      );
    });

    it("source, since, and metadata filters narrow the result", async () => {
      const bySource = await json<QueryResponse>(
        await get(app, "source=yelp", { Authorization: `Bearer ${f.secret}` }),
      );
      expect(bySource.results.map((r) => r.review.id)).toEqual([
        f.reviews.cleaning,
      ]);

      const since = await json<QueryResponse>(
        await post(app, f.secret, { filters: { since: "2026-02-01" } }),
      );
      expect(since.results.map((r) => r.review.id)).toEqual([
        f.reviews.implant,
        f.reviews.cleaning,
      ]);

      const byMetadata = await json<QueryResponse>(
        await get(app, "metadata.location=south", {
          Authorization: `Bearer ${f.secret}`,
        }),
      );
      expect(byMetadata.results.map((r) => r.review.id)).toEqual([
        f.reviews.cleaning,
      ]);
    });

    it("badge derives from the account plan, not projects.show_badge", async () => {
      // A paid account whose project still carries a stale `show_badge`
      // mirror: the response must follow the plan.
      const paid = await account(t.db, { plan: "paid" });
      const stale = await fixture(t.db, {
        accountId: paid.id,
        showBadge: true,
      });
      const body = await json<QueryResponse>(await post(app, stale.secret, {}));
      expect(body.badge).toBe(false);
    });

    it("badge flips with the plan once the auth-cache entry turns over, cache HIT or not", async () => {
      // The plan rides in the auth cache (auth-cache.ts, #108), so a plan
      // change shows within AUTH_CACHE_TTL_SECONDS or on the next generation
      // bump — never later, and independently of the query cache, whose
      // entries carry no badge (cache.ts "What is stored").
      let clock = Date.parse("2026-10-04T12:00:00Z");
      const kv = fakeKv({ now: () => clock });
      const bindings = testEnv({ kv });
      const free = await fixture(t.db);
      const first = await post(
        app,
        free.secret,
        { q: "implant tooth" },
        {},
        bindings,
      );
      expect(first.headers.get("x-cache")).toBe("MISS");
      expect((await json<QueryResponse>(first)).badge).toBe(true);

      const upgraded = await setAccountPlan(
        t.db,
        free.project.accountId,
        "paid",
      );
      expect(upgraded?.projectsSynced).toBe(1);

      // Within the TTL the cached context still says free: the documented lag.
      const stale = await post(
        app,
        free.secret,
        { q: "implant tooth" },
        {},
        bindings,
      );
      expect(stale.headers.get("x-cache")).toBe("HIT");
      expect((await json<QueryResponse>(stale)).badge).toBe(true);

      // Once the auth entry expires the key is looked up again; the query
      // cache entry (24 h) is still there, so this is a HIT with the new plan.
      clock += AUTH_CACHE_TTL_SECONDS * 1000;
      const hit = await post(
        app,
        free.secret,
        { q: "implant tooth" },
        {},
        bindings,
      );
      expect(hit.headers.get("x-cache")).toBe("HIT");
      const hitBody = await json<QueryResponse>(hit);
      expect(hitBody.cached).toBe(true);
      expect(hitBody.badge).toBe(false);
      expect(hitBody.results.map((r) => r.review.id)).toEqual([
        free.reviews.implant,
      ]);

      // And back down: a generation bump (what the dashboard does on a
      // policy, key or allowlist change) refreshes the auth entry at once.
      await setAccountPlan(t.db, free.project.accountId, "free");
      await bumpProjectGeneration(kv, free.project.id);
      const again = await post(
        app,
        free.secret,
        { q: "implant tooth" },
        {},
        bindings,
      );
      expect(again.headers.get("x-cache")).toBe("MISS");
      expect((await json<QueryResponse>(again)).badge).toBe(true);
    });

    it("a project with a lower similarity floor sees more", async () => {
      const lax = await fixture(t.db, { similarityFloor: 0.1 });
      const body = await json<QueryResponse>(
        await post(app, lax.secret, { q: "parking" }),
      );
      expect(body.results.map((r) => r.excerpt)).toEqual([PARKING]);
    });
  });

  describe("validation and errors", () => {
    it("422 validation_failed with the envelope on an unknown field", async () => {
      const res = await post(app, f.secret, { limt: 3 });
      expect(res.status).toBe(422);
      const body = await json<ErrorEnvelope>(res);
      expect(body.error).toMatchObject({
        code: "validation_failed",
        doc_url: "https://docs.proofql.com/errors#validation_failed",
        details: [{ path: "limt", message: expect.any(String) }],
      });
      expect(body.error.request_id).toBe(res.headers.get("X-Request-Id"));
    });

    it("422 validation_failed on a malformed JSON body, like /v1/reviews", async () => {
      const res = await app.request(
        "/v1/query",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${f.secret}`,
            // Declared JSON: this test is about the parse, not the media
            // type (an undeclared body is a 415, src/request-guards.ts).
            "content-type": "application/json",
          },
          body: "{not json",
        },
        env,
      );
      expect(res.status).toBe(422);
      const body = await json<ErrorEnvelope>(res);
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.message).toMatch(/not valid JSON/);
    });

    it("503 embedding_unavailable when embedding fails — never an FTS-only fallback", async () => {
      const failing = appWith(
        new FakeEmbeddingProvider({
          shouldFail: () => new Error("Workers AI is down"),
        }),
      );
      // Earlier tests cached this query: a hit needs no embedding, so the
      // outage is invisible to a repeat caller (#28). Bypass to reach it.
      const hit = await post(failing, f.secret, { q: "implant tooth" });
      expect(hit.status).toBe(200);
      expect(hit.headers.get("x-cache")).toBe("HIT");

      const res = await post(
        failing,
        f.secret,
        { q: "implant tooth" },
        { "Cache-Control": "no-cache" },
      );
      expect(res.status).toBe(503);
      const body = await json<ErrorEnvelope>(res);
      expect(body.error.code).toBe("embedding_unavailable");
      expect(body.error.message).toMatch(/retry/);

      // The same app still serves no-q mode: nothing to embed.
      const noQ = await post(failing, f.secret, {});
      expect(noQ.status).toBe(200);
    });
  });

  describe("authentication", () => {
    it("401 unauthorized with no key, a malformed key, an unknown key, or a revoked key", async () => {
      const none = await app.request("/v1/query", { method: "POST" }, env);
      expect(none.status).toBe(401);
      expect((await json<ErrorEnvelope>(none)).error.code).toBe("unauthorized");

      const malformed = await post(app, "pq_sk_live_short", {});
      expect(malformed.status).toBe(401);

      const unknown = await post(
        app,
        (await generateApiKey({ kind: "secret", environment: "live" }))
          .plaintext,
        {},
      );
      expect(unknown.status).toBe(401);

      const revoked = await fixture(t.db);
      await t.sql`UPDATE api_keys SET revoked_at = now() WHERE id = ${revoked.secretKey.id}`;
      expect((await post(app, revoked.secret, {})).status).toBe(401);
    });

    it("refuses a secret key in ?key= (URLs leak) but accepts a publishable one", async () => {
      const viaUrl = await get(app, `key=${f.secret}`);
      expect(viaUrl.status).toBe(401);
      expect((await json<ErrorEnvelope>(viaUrl)).error.message).toMatch(
        /Authorization header/,
      );

      const pk = await get(app, `key=${f.publishable}&q=implant+tooth`, {
        Origin: ORIGIN,
      });
      expect(pk.status).toBe(200);
      expect(pk.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    });

    it("the Authorization header wins over ?key= when both are present", async () => {
      const res = await get(app, `key=${f.publishable}`, {
        Authorization: `Bearer ${f.secret}`,
      });
      // Secret key: no Origin needed.
      expect(res.status).toBe(200);
    });
  });

  describe("publishable keys on other routes", () => {
    it("POST /v1/reviews with a real publishable key is 403 forbidden", async () => {
      const res = await app.request(
        "/v1/reviews",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${f.publishable}`,
            "Content-Type": "application/json",
          },
          body: "[]",
        },
        env,
      );
      expect(res.status).toBe(403);
      const body = await json<ErrorEnvelope>(res);
      expect(body.error.code).toBe("forbidden");
      expect(body.error.message).toMatch(/secret key/);
    });
  });

  describe("publishable keys and CORS", () => {
    it("listed origin: 200 with Access-Control-Allow-Origin and Vary: Origin", async () => {
      const res = await post(
        app,
        f.publishable,
        { q: "implant tooth" },
        { Origin: ORIGIN },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
      expect(res.headers.get("Vary")).toBe("Origin");
      const body = await json<QueryResponse>(res);
      expect(body.results.map((r) => r.review.id)).toEqual([f.reviews.implant]);
    });

    it("matches case-insensitively on host, exactly on scheme and port", async () => {
      expect(
        (await post(app, f.publishable, {}, { Origin: "https://SHOP.example" }))
          .status,
      ).toBe(200);
      expect(
        (await post(app, f.publishable, {}, { Origin: "http://shop.example" }))
          .status,
      ).toBe(403);
      expect(
        (
          await post(
            app,
            f.publishable,
            {},
            { Origin: "https://shop.example:8443" },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await post(
            app,
            f.publishable,
            {},
            { Origin: "http://localhost:3000" },
          )
        ).status,
      ).toBe(200);
    });

    it("missing Origin: 403 forbidden naming the fix, no allow-origin header", async () => {
      const res = await post(app, f.publishable, {});
      expect(res.status).toBe(403);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.headers.get("Vary")).toBe("Origin");
      const body = await json<ErrorEnvelope>(res);
      expect(body.error.code).toBe("forbidden");
      expect(body.error.message).toMatch(/Origin header/);
    });

    it("unlisted Origin: 403 forbidden naming the origin, no allow-origin header", async () => {
      const res = await post(app, f.publishable, {}, { Origin: OTHER_ORIGIN });
      expect(res.status).toBe(403);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      const body = await json<ErrorEnvelope>(res);
      expect(body.error.code).toBe("forbidden");
      expect(body.error.message).toContain(OTHER_ORIGIN);
      expect(body.error.message).toMatch(/Allowed origins/);
    });

    it("a project with no allowed origins refuses every publishable request", async () => {
      const bare = await fixture(t.db, { allowedOrigins: [] });
      expect(
        (await post(app, bare.publishable, {}, { Origin: ORIGIN })).status,
      ).toBe(403);
    });

    it("errors for a listed origin still carry the CORS headers so the page can read them", async () => {
      const res = await post(
        app,
        f.publishable,
        { limit: 99 },
        { Origin: ORIGIN },
      );
      expect(res.status).toBe(422);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    });

    it("secret keys skip the origin check and echo an Origin if one is sent", async () => {
      const res = await post(app, f.secret, {}, { Origin: OTHER_ORIGIN });
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(OTHER_ORIGIN);
    });
  });

  describe("OPTIONS /v1/query preflight", () => {
    const preflight = (qs: string, headers: Record<string, string>) =>
      app.request(
        `/v1/query${qs}`,
        {
          method: "OPTIONS",
          headers: {
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization,content-type",
            ...headers,
          },
        },
        env,
      );

    it("echoes a listed origin for a key in ?key= with the allow headers, without auth", async () => {
      const res = await preflight(`?key=${f.publishable}&q=implant`, {
        Origin: ORIGIN,
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
      expect(res.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST, OPTIONS",
      );
      expect(res.headers.get("Access-Control-Allow-Headers")).toBe(
        "Authorization, Cache-Control, Content-Type",
      );
      expect(res.headers.get("Access-Control-Max-Age")).toBe("600");
      expect(res.headers.get("Vary")).toBe("Origin");
    });

    it("also reads the key from an Authorization header", async () => {
      const res = await preflight("", {
        Origin: ORIGIN,
        Authorization: `Bearer ${f.publishable}`,
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    });

    it("does not echo an unlisted origin, an unknown key, or no key at all", async () => {
      const unlisted = await preflight(`?key=${f.publishable}`, {
        Origin: OTHER_ORIGIN,
      });
      expect(unlisted.status).toBe(204);
      expect(unlisted.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(unlisted.headers.get("Vary")).toBe("Origin");

      const unknown = await preflight(
        "?key=pq_pk_live_00000000000000000000000000000000",
        {
          Origin: ORIGIN,
        },
      );
      expect(unknown.headers.get("Access-Control-Allow-Origin")).toBeNull();

      const none = await preflight("", { Origin: ORIGIN });
      expect(none.status).toBe(204);
      expect(none.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("echoes any origin for a secret key, matching the real request", async () => {
      const res = await preflight("", {
        Origin: OTHER_ORIGIN,
        Authorization: `Bearer ${f.secret}`,
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(OTHER_ORIGIN);
    });
  });

  describe("logging (#30, docs/observability.md)", () => {
    function loggedApp() {
      const out = recordingSink();
      return {
        app: createApp({
          db: t.db,
          embedder: new FakeEmbeddingProvider(),
          logSink: out.sink,
        }),
        out,
      };
    }

    it("one query.completed line per answered query, with the documented fields and never the text", async () => {
      const { app: logged, out } = loggedApp();
      const res = await post(
        logged,
        f.secret,
        { q: "implant tooth", limit: 3 },
        { "x-request-id": "req-q-1", "Cache-Control": "no-cache" },
      );
      expect(res.status).toBe(200);

      const line = out.only("query.completed");
      expect(line).toEqual({
        ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        service: "api",
        environment: "test",
        event: "query.completed",
        level: "info",
        request_id: "req-q-1",
        method: "POST",
        path: "/v1/query",
        project_id: f.project.id,
        key_kind: "secret",
        key_environment: "live",
        mode: "excerpts",
        fallback: "none",
        has_q: true,
        q_length: "implant tooth".length,
        limit: 3,
        min_rating: 4,
        similarity_floor: 0.55,
        returned: 1,
        match: "query",
        cached: "BYPASS",
        took_ms: expect.any(Number),
        embedding_ms: expect.any(Number),
        search_ms: expect.any(Number),
      });
      expect(line.search_ms).toBeGreaterThanOrEqual(0);
      // No review text, excerpt, or query text anywhere in the line.
      const raw = JSON.stringify(line);
      expect(raw).not.toContain("implant");
      expect(raw).not.toContain(IMPLANT);
      expect(
        out.records.filter((r) => r.event.startsWith("query.")),
      ).toHaveLength(1);
    });

    it("a cache hit logs cached: HIT with zero embedding and search time; GET carries key_kind publishable", async () => {
      const { app: logged, out } = loggedApp();
      // limit=4 keeps this request distinct from the one the previous test
      // stored (BYPASS still writes), so the first call here is a real miss.
      await get(logged, `key=${f.publishable}&q=implant+tooth&limit=4`, {
        Origin: ORIGIN,
      });
      const second = await get(
        logged,
        `key=${f.publishable}&q=implant+tooth&limit=4`,
        { Origin: ORIGIN },
      );
      expect(second.headers.get("x-cache")).toBe("HIT");

      const lines = out.find("query.completed");
      expect(lines.map((l) => l.cached)).toEqual(["MISS", "HIT"]);
      expect(lines[1]).toMatchObject({
        method: "GET",
        key_kind: "publishable",
        key_environment: "live",
        environment: "test",
        embedding_ms: 0,
        search_ms: 0,
        returned: 1,
      });
      // A URL-borne key never reaches the log: `path` excludes the query string.
      expect(JSON.stringify(out.records)).not.toContain(f.publishable);
    });

    it("a refused query is one query.rejected line with the code", async () => {
      const { app: logged, out } = loggedApp();
      const res = await post(logged, f.secret, { limt: 3 });
      expect(res.status).toBe(422);

      expect(out.only("query.rejected")).toMatchObject({
        level: "warn",
        code: "validation_failed",
        status: 422,
        project_id: f.project.id,
        key_kind: "secret",
        request_id: res.headers.get("x-request-id"),
      });
      expect(out.find("query.completed")).toEqual([]);

      const unauthorized = await post(logged, "pq_sk_live_short", {});
      expect(unauthorized.status).toBe(401);
      expect(out.find("query.rejected")[1]).toMatchObject({
        code: "unauthorized",
        status: 401,
      });
      expect(out.find("query.rejected")[1]).not.toHaveProperty("project_id");
    });

    it("an embedding outage is query.embedding_failed at level error, without the query text", async () => {
      const out = recordingSink();
      const failing = createApp({
        db: t.db,
        logSink: out.sink,
        embedder: new FakeEmbeddingProvider({
          shouldFail: () => new Error("Workers AI is down"),
        }),
      });
      const res = await post(
        failing,
        f.secret,
        { q: "implant tooth" },
        { "Cache-Control": "no-cache" },
      );
      expect(res.status).toBe(503);

      expect(out.only("query.embedding_failed")).toMatchObject({
        level: "error",
        project_id: f.project.id,
        q_length: "implant tooth".length,
        error: { name: "Error", message: "Workers AI is down" },
      });
      expect(JSON.stringify(out.records)).not.toContain("implant tooth");
      expect(out.only("query.rejected").code).toBe("embedding_unavailable");
    });
  });
});
