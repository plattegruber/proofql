/**
 * Review CRUD against the real schema: the @proofql/db harness gives this
 * file a private database, `createApp({ db })` injects it, and a Map-backed
 * fake stands in for the KV cache so the generation counter can be
 * asserted (see ../cache-purge.ts).
 */

import { FakeEmbeddingProvider, fakeEmbed } from "@proofql/ai";
import { type Db, schema } from "@proofql/db";
import { chunk, project, review, setupTestDb } from "@proofql/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  type FakeKv,
  fakeKv,
  issueKey,
  refusingQueue,
  testEnv,
} from "../../test/helpers.js";
import { createApp } from "../app.js";
import type { ApiBindings } from "../bindings.js";
import { generationKey } from "../cache-purge.js";
import type { QueryResponse } from "../query/route.js";
import { REQUEST_ID_HEADER } from "../request-id.js";
import type { ListReviewsResponse, ReviewResource } from "./reviews-crud.js";

const t = setupTestDb();

function env(kv: FakeKv): ApiBindings {
  return testEnv({ kv, queue: refusingQueue("CRUD routes must not enqueue") });
}

/** One authenticated request against a fresh app over `db`. */
async function call(
  db: Db,
  plaintext: string,
  method: "GET" | "PATCH" | "DELETE",
  path: string,
  options: { body?: unknown; kv?: FakeKv } = {},
) {
  const kv = options.kv ?? fakeKv();
  const app = createApp({ db });
  const headers: Record<string, string> = {
    authorization: `Bearer ${plaintext}`,
  };
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body =
      typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  }
  const res = await app.request(path, init, env(kv));
  // biome-ignore lint/suspicious/noExplicitAny: test reads success and error shapes
  const json: any = res.status === 204 ? null : await res.json();
  return { res, json, kv };
}

function generation(kv: FakeKv, projectId: string): number {
  return Number(kv.peek(generationKey(projectId)) ?? "0");
}

async function reviewCount(db: Db, projectId: string): Promise<number> {
  const [row] = await db
    .select({ reviewCount: schema.projects.reviewCount })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  return row?.reviewCount ?? Number.NaN;
}

/** A project, its secret key, and `n` reviews one day apart (newest first). */
async function seeded(n: number) {
  const p = await project(t.db);
  const { plaintext } = await issueKey(t.db, p.id);
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(
      await review(t.db, {
        projectId: p.id,
        externalId: `ext-${i}`,
        occurredAt: new Date(Date.UTC(2026, 0, 1 + i)),
      }),
    );
  }
  rows.reverse();
  return { p, plaintext, rows };
}

describe("GET /v1/reviews", () => {
  it("returns the full review shape, newest first", async () => {
    const p = await project(t.db);
    const { plaintext } = await issueKey(t.db, p.id);
    const older = await review(t.db, {
      projectId: p.id,
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      metadata: { location: "north" },
      language: "en",
      url: "https://maps.google.com/r/1",
      indexedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const newer = await review(t.db, {
      projectId: p.id,
      occurredAt: new Date("2026-02-01T00:00:00Z"),
      rating: null,
      hiddenAt: new Date("2026-02-02T00:00:00Z"),
    });

    const { res, json } = await call(t.db, plaintext, "GET", "/v1/reviews");

    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
    const body = json as ListReviewsResponse;
    expect(body.next_cursor).toBeNull();
    expect(body.reviews.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(body.reviews[1]).toEqual({
      id: older.id,
      external_id: older.externalId,
      source: "google",
      rating: 5,
      text: older.text,
      author_name: older.authorName,
      author_avatar_url: null,
      occurred_at: "2026-01-01T00:00:00.000Z",
      url: "https://maps.google.com/r/1",
      language: "en",
      metadata: { location: "north" },
      sentiment: null,
      sentiment_source: null,
      hidden: false,
      status: "indexed",
      created_at: older.createdAt.toISOString(),
      updated_at: older.updatedAt.toISOString(),
    });
    expect(body.reviews[0]).toMatchObject({
      id: newer.id,
      rating: null,
      hidden: true,
      status: "indexing",
    });
    // The shape has exactly these keys, nothing from the row leaks through.
    expect(Object.keys(body.reviews[0] as ReviewResource).sort()).toEqual(
      [
        "author_avatar_url",
        "author_name",
        "created_at",
        "external_id",
        "hidden",
        "id",
        "language",
        "metadata",
        "occurred_at",
        "rating",
        "sentiment",
        "sentiment_source",
        "source",
        "status",
        "text",
        "updated_at",
        "url",
      ].sort(),
    );
  });

  it("paginates across pages with stable ordering, no duplicates or gaps", async () => {
    const { p, plaintext, rows } = await seeded(5);
    // Ties on occurred_at must break on id, and null occurred_at sorts last.
    const tied1 = await review(t.db, {
      projectId: p.id,
      occurredAt: new Date(Date.UTC(2026, 0, 3)),
    });
    const tied2 = await review(t.db, {
      projectId: p.id,
      occurredAt: new Date(Date.UTC(2026, 0, 3)),
    });
    const undated = await review(t.db, { projectId: p.id, occurredAt: null });
    const total = rows.length + 3;

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const path: string =
        cursor === null
          ? "/v1/reviews?limit=3"
          : `/v1/reviews?limit=3&cursor=${cursor}`;
      const { res, json } = await call(t.db, plaintext, "GET", path);
      expect(res.status).toBe(200);
      const body = json as ListReviewsResponse;
      pages++;
      if (pages < 3) expect(body.reviews).toHaveLength(3);
      seen.push(...body.reviews.map((r) => r.id));
      cursor = body.next_cursor;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    // Newest first; the two tied rows adjacent (higher id first); undated last.
    const expected = [...rows.map((r) => r.id)];
    const tiedIds = [tied1.id, tied2.id].sort().reverse();
    // Jan 5, Jan 4, [Jan 3 ties...], Jan 3 (ext-2), Jan 2, Jan 1
    const jan3 = rows.find((r) => r.externalId === "ext-2")?.id as string;
    const jan3Block = [...tiedIds, jan3].sort().reverse();
    const ordered = [
      ...expected.slice(0, 2),
      ...jan3Block,
      ...expected.slice(3),
      undated.id,
    ];
    expect(seen).toEqual(ordered);

    // Exactly `limit` rows left: no empty trailing page is advertised.
    const { json: exact } = await call(
      t.db,
      plaintext,
      "GET",
      `/v1/reviews?limit=${total}`,
    );
    expect((exact as ListReviewsResponse).reviews).toHaveLength(total);
    expect((exact as ListReviewsResponse).next_cursor).toBeNull();
  });

  it("stays on the page while rows are deleted ahead of it", async () => {
    const { plaintext, rows } = await seeded(6);

    const first = await call(t.db, plaintext, "GET", "/v1/reviews?limit=2");
    expect(first.json.reviews.map((r: ReviewResource) => r.id)).toEqual([
      rows[0]?.id,
      rows[1]?.id,
    ]);
    // Delete a row on the page already served; the next page is unaffected.
    await t.db
      .delete(schema.reviews)
      .where(eq(schema.reviews.id, rows[0]?.id as string));

    const second = await call(
      t.db,
      plaintext,
      "GET",
      `/v1/reviews?limit=2&cursor=${first.json.next_cursor}`,
    );
    expect(second.json.reviews.map((r: ReviewResource) => r.id)).toEqual([
      rows[2]?.id,
      rows[3]?.id,
    ]);
  });

  it("applies source, min_rating, hidden, since, and indexed filters", async () => {
    const p = await project(t.db);
    const { plaintext } = await issueKey(t.db, p.id);
    const yelp3 = await review(t.db, {
      projectId: p.id,
      source: "yelp",
      rating: 3,
      occurredAt: new Date("2026-01-10T00:00:00Z"),
    });
    const google5hidden = await review(t.db, {
      projectId: p.id,
      rating: 5,
      hiddenAt: new Date(),
      occurredAt: new Date("2026-01-20T00:00:00Z"),
    });
    const google4indexed = await review(t.db, {
      projectId: p.id,
      rating: 4,
      indexedAt: new Date(),
      occurredAt: new Date("2026-02-01T00:00:00Z"),
    });
    const unrated = await review(t.db, {
      projectId: p.id,
      source: "custom",
      rating: null,
      occurredAt: new Date("2026-02-10T00:00:00Z"),
    });

    const ids = async (qs: string) => {
      const { res, json } = await call(
        t.db,
        plaintext,
        "GET",
        `/v1/reviews?${qs}`,
      );
      expect(res.status, qs).toBe(200);
      return (json as ListReviewsResponse).reviews.map((r) => r.id);
    };

    expect(await ids("source=yelp")).toEqual([yelp3.id]);
    expect(await ids("source=google")).toEqual([
      google4indexed.id,
      google5hidden.id,
    ]);
    // Unrated reviews never satisfy min_rating.
    expect(await ids("min_rating=4")).toEqual([
      google4indexed.id,
      google5hidden.id,
    ]);
    expect(await ids("min_rating=5")).toEqual([google5hidden.id]);
    expect(await ids("hidden=true")).toEqual([google5hidden.id]);
    expect(await ids("hidden=false")).toEqual([
      unrated.id,
      google4indexed.id,
      yelp3.id,
    ]);
    expect(await ids("hidden=all")).toHaveLength(4);
    expect(await ids("since=2026-01-20")).toEqual([
      unrated.id,
      google4indexed.id,
      google5hidden.id,
    ]);
    expect(await ids("since=2026-01-20T00:00:01Z")).toEqual([
      unrated.id,
      google4indexed.id,
    ]);
    expect(await ids("indexed=true")).toEqual([google4indexed.id]);
    expect(await ids("indexed=false")).toEqual([
      unrated.id,
      google5hidden.id,
      yelp3.id,
    ]);
    expect(await ids("source=google&min_rating=4&hidden=false")).toEqual([
      google4indexed.id,
    ]);
  });

  it("filters combine with the cursor", async () => {
    const { plaintext } = await seeded(4);
    const firstPage = await call(
      t.db,
      plaintext,
      "GET",
      "/v1/reviews?limit=1&source=google&min_rating=5",
    );
    expect(firstPage.json.reviews).toHaveLength(1);
    const rest = await call(
      t.db,
      plaintext,
      "GET",
      `/v1/reviews?limit=10&source=google&min_rating=5&cursor=${firstPage.json.next_cursor}`,
    );
    expect(rest.json.reviews).toHaveLength(3);
    expect(rest.json.next_cursor).toBeNull();
  });

  it("422 validation_failed for a bad cursor, limit, or unknown parameter", async () => {
    const { plaintext } = await seeded(1);

    const expect422 = async (qs: string, path: string) => {
      const { res, json } = await call(
        t.db,
        plaintext,
        "GET",
        `/v1/reviews?${qs}`,
      );
      expect(res.status, qs).toBe(422);
      expect(json.error.code).toBe("validation_failed");
      expect(json.error.details.map((d: { path: string }) => d.path)).toContain(
        path,
      );
      expect(json.error.request_id).toBe(res.headers.get(REQUEST_ID_HEADER));
    };

    await expect422("cursor=eyJvIjpudWxsLCJpIjoibm9wZSJ9", "cursor");
    await expect422("cursor=%2A%2A", "cursor");
    await expect422("limit=0", "limit");
    await expect422("limit=101", "limit");
    await expect422("hidden=maybe", "hidden");
    await expect422("page=2", "");
  });

  it("scopes to the key's project and environment", async () => {
    const a = await project(t.db);
    const b = await project(t.db);
    const keyA = await issueKey(t.db, a.id);
    const keyATest = await issueKey(t.db, a.id, "secret", "test");
    const live = await review(t.db, { projectId: a.id });
    const test = await review(t.db, { projectId: a.id, environment: "test" });
    await review(t.db, { projectId: b.id });

    const liveList = await call(t.db, keyA.plaintext, "GET", "/v1/reviews");
    expect(liveList.json.reviews.map((r: ReviewResource) => r.id)).toEqual([
      live.id,
    ]);
    const testList = await call(t.db, keyATest.plaintext, "GET", "/v1/reviews");
    expect(testList.json.reviews.map((r: ReviewResource) => r.id)).toEqual([
      test.id,
    ]);
  });
});

describe("GET /v1/reviews/:id", () => {
  it("returns the review", async () => {
    const { plaintext, rows } = await seeded(1);
    const target = rows[0] as NonNullable<(typeof rows)[0]>;

    const { res, json } = await call(
      t.db,
      plaintext,
      "GET",
      `/v1/reviews/${target.id}`,
    );

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      id: target.id,
      external_id: "ext-0",
      hidden: false,
      status: "indexing",
    });
  });

  it("404 not_found across projects, across environments, and for a non-uuid", async () => {
    const a = await project(t.db);
    const b = await project(t.db);
    const keyB = await issueKey(t.db, b.id);
    const keyATest = await issueKey(t.db, a.id, "secret", "test");
    const liveInA = await review(t.db, { projectId: a.id });

    for (const [plaintext, path] of [
      [keyB.plaintext, `/v1/reviews/${liveInA.id}`],
      [keyATest.plaintext, `/v1/reviews/${liveInA.id}`],
      [keyB.plaintext, "/v1/reviews/not-a-uuid"],
      [keyB.plaintext, "/v1/reviews/00000000-0000-0000-0000-000000000000"],
    ] as const) {
      const { res, json } = await call(t.db, plaintext, "GET", path);
      expect(res.status, path).toBe(404);
      expect(json).toMatchObject({
        error: {
          code: "not_found",
          doc_url: "https://docs.proofql.com/errors#not_found",
          request_id: res.headers.get(REQUEST_ID_HEADER),
        },
      });
    }
  });
});

describe("PATCH /v1/reviews/:id", () => {
  it("hides, excludes from hidden=false, unhides; bumps the generation each time", async () => {
    const { p, plaintext, rows } = await seeded(2);
    const target = rows[0] as NonNullable<(typeof rows)[0]>;
    const kv = fakeKv();
    const before = Date.now();

    const hide = await call(
      t.db,
      plaintext,
      "PATCH",
      `/v1/reviews/${target.id}`,
      { body: { hidden: true }, kv },
    );
    expect(hide.res.status).toBe(200);
    expect(hide.json).toMatchObject({ id: target.id, hidden: true });
    expect(generation(kv, p.id)).toBe(1);
    const [hiddenRow] = await t.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, target.id));
    expect(hiddenRow?.hiddenAt?.getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
    expect(hiddenRow?.updatedAt.getTime()).toBeGreaterThan(
      target.updatedAt.getTime(),
    );
    expect(new Date(hide.json.updated_at).getTime()).toBe(
      hiddenRow?.updatedAt.getTime(),
    );

    const visible = await call(
      t.db,
      plaintext,
      "GET",
      "/v1/reviews?hidden=false",
      { kv },
    );
    expect(visible.json.reviews.map((r: ReviewResource) => r.id)).toEqual([
      rows[1]?.id,
    ]);
    const all = await call(t.db, plaintext, "GET", "/v1/reviews", { kv });
    expect(all.json.reviews).toHaveLength(2);

    const unhide = await call(
      t.db,
      plaintext,
      "PATCH",
      `/v1/reviews/${target.id}`,
      { body: { hidden: false }, kv },
    );
    expect(unhide.res.status).toBe(200);
    expect(unhide.json.hidden).toBe(false);
    expect(generation(kv, p.id)).toBe(2);
    const [unhiddenRow] = await t.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, target.id));
    expect(unhiddenRow?.hiddenAt).toBeNull();

    const again = await call(
      t.db,
      plaintext,
      "GET",
      "/v1/reviews?hidden=false",
      { kv },
    );
    expect(again.json.reviews).toHaveLength(2);
    // Reads never bump.
    expect(generation(kv, p.id)).toBe(2);
  });

  it("replaces the whole metadata map and bumps the generation", async () => {
    const p = await project(t.db);
    const { plaintext } = await issueKey(t.db, p.id);
    const target = await review(t.db, {
      projectId: p.id,
      metadata: { location: "north", tier: "gold" },
    });
    const kv = fakeKv();

    const { res, json } = await call(
      t.db,
      plaintext,
      "PATCH",
      `/v1/reviews/${target.id}`,
      { body: { metadata: { location: "south" } }, kv },
    );

    expect(res.status).toBe(200);
    expect(json.metadata).toEqual({ location: "south" });
    expect(json.hidden).toBe(false);
    expect(generation(kv, p.id)).toBe(1);
    const [row] = await t.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, target.id));
    expect(row?.metadata).toEqual({ location: "south" });

    // Clearing is an explicit empty map.
    const cleared = await call(
      t.db,
      plaintext,
      "PATCH",
      `/v1/reviews/${target.id}`,
      { body: { metadata: {} }, kv },
    );
    expect(cleared.json.metadata).toEqual({});
    expect(generation(kv, p.id)).toBe(2);
  });

  it("hidden and metadata together, with one generation bump", async () => {
    const { p, plaintext, rows } = await seeded(1);
    const target = rows[0] as NonNullable<(typeof rows)[0]>;
    const kv = fakeKv();

    const { res, json } = await call(
      t.db,
      plaintext,
      "PATCH",
      `/v1/reviews/${target.id}`,
      { body: { hidden: true, metadata: { a: "b" } }, kv },
    );

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ hidden: true, metadata: { a: "b" } });
    expect(generation(kv, p.id)).toBe(1);
  });

  it("a no-op PATCH (same values) writes nothing and does not bump", async () => {
    const p = await project(t.db);
    const { plaintext } = await issueKey(t.db, p.id);
    const target = await review(t.db, {
      projectId: p.id,
      metadata: { location: "north", tier: "gold" },
      hiddenAt: new Date("2026-03-01T00:00:00Z"),
    });
    const kv = fakeKv();

    const bodies = [
      { hidden: true },
      { metadata: { tier: "gold", location: "north" } },
      { hidden: true, metadata: { location: "north", tier: "gold" } },
    ];
    for (const body of bodies) {
      const { res, json } = await call(
        t.db,
        plaintext,
        "PATCH",
        `/v1/reviews/${target.id}`,
        { body, kv },
      );
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(json).toMatchObject({
        id: target.id,
        hidden: true,
        metadata: { location: "north", tier: "gold" },
        updated_at: target.updatedAt.toISOString(),
      });
    }
    expect(generation(kv, p.id)).toBe(0);
    expect(kv.store.size).toBe(0);
    const [row] = await t.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, target.id));
    // Re-hiding an already hidden review keeps the original hidden_at.
    expect(row?.hiddenAt?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(row?.updatedAt.getTime()).toBe(target.updatedAt.getTime());
  });

  it("422 validation_failed for an empty body, non-flat metadata, unknown keys, bad JSON", async () => {
    const { p, plaintext, rows } = await seeded(1);
    const target = rows[0] as NonNullable<(typeof rows)[0]>;
    const kv = fakeKv();

    const cases: Array<[unknown, string]> = [
      [{}, ""],
      [{ metadata: { nested: { a: "b" } } }, "metadata.nested"],
      [{ metadata: { n: 1 } }, "metadata.n"],
      [{ hidden: "yes" }, "hidden"],
      [{ hidden: true, text: "rewritten" }, ""],
      ["{not json", ""],
    ];
    for (const [body, path] of cases) {
      const { res, json } = await call(
        t.db,
        plaintext,
        "PATCH",
        `/v1/reviews/${target.id}`,
        { body, kv },
      );
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(json.error.code).toBe("validation_failed");
      expect(
        json.error.details.map((d: { path: string }) => d.path),
        JSON.stringify(body),
      ).toContain(path);
    }
    expect(generation(kv, p.id)).toBe(0);
  });

  it("404 not_found across projects and environments; nothing bumped", async () => {
    const a = await project(t.db);
    const b = await project(t.db);
    const keyB = await issueKey(t.db, b.id);
    const keyATest = await issueKey(t.db, a.id, "secret", "test");
    const liveInA = await review(t.db, { projectId: a.id });
    const kv = fakeKv();

    for (const plaintext of [keyB.plaintext, keyATest.plaintext]) {
      const { res, json } = await call(
        t.db,
        plaintext,
        "PATCH",
        `/v1/reviews/${liveInA.id}`,
        { body: { hidden: true }, kv },
      );
      expect(res.status).toBe(404);
      expect(json.error.code).toBe("not_found");
    }
    expect(kv.store.size).toBe(0);
    const [row] = await t.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, liveInA.id));
    expect(row?.hiddenAt).toBeNull();
  });
});

describe("DELETE /v1/reviews/:id", () => {
  it("deletes the review and its chunks, decrements review_count, bumps, then 404s", async () => {
    const p = await project(t.db, { reviewCount: 3 });
    const { plaintext } = await issueKey(t.db, p.id);
    const target = await review(t.db, { projectId: p.id });
    const keep = await review(t.db, { projectId: p.id });
    await chunk(t.db, { reviewId: target.id });
    await chunk(t.db, {
      reviewId: target.id,
      kind: "window",
      text: target.text.slice(0, 40),
      startOffset: 0,
    });
    const keptChunk = await chunk(t.db, { reviewId: keep.id });
    const kv = fakeKv();

    const { res, json } = await call(
      t.db,
      plaintext,
      "DELETE",
      `/v1/reviews/${target.id}`,
      { kv },
    );

    expect(res.status).toBe(204);
    expect(json).toBeNull();
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
    expect(generation(kv, p.id)).toBe(1);
    expect(await reviewCount(t.db, p.id)).toBe(2);

    const chunks = await t.db.select().from(schema.reviewChunks);
    expect(chunks.map((c) => c.id)).toEqual([keptChunk.id]);
    const remaining = await t.db
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(eq(schema.reviews.projectId, p.id));
    expect(remaining.map((r) => r.id)).toEqual([keep.id]);

    const after = await call(
      t.db,
      plaintext,
      "GET",
      `/v1/reviews/${target.id}`,
      { kv },
    );
    expect(after.res.status).toBe(404);

    // Deleting again: 404, no second decrement, no bump.
    const again = await call(
      t.db,
      plaintext,
      "DELETE",
      `/v1/reviews/${target.id}`,
      { kv },
    );
    expect(again.res.status).toBe(404);
    expect(again.json.error.code).toBe("not_found");
    expect(await reviewCount(t.db, p.id)).toBe(2);
    expect(generation(kv, p.id)).toBe(1);
  });

  it("never takes review_count below 0", async () => {
    const p = await project(t.db, { reviewCount: 0 });
    const { plaintext } = await issueKey(t.db, p.id);
    const target = await review(t.db, { projectId: p.id });

    const { res } = await call(
      t.db,
      plaintext,
      "DELETE",
      `/v1/reviews/${target.id}`,
    );

    expect(res.status).toBe(204);
    expect(await reviewCount(t.db, p.id)).toBe(0);
  });

  it("404 not_found across projects and environments; count and generation untouched", async () => {
    const a = await project(t.db, { reviewCount: 1 });
    const b = await project(t.db, { reviewCount: 1 });
    const keyB = await issueKey(t.db, b.id);
    const keyATest = await issueKey(t.db, a.id, "secret", "test");
    const liveInA = await review(t.db, { projectId: a.id });
    const kv = fakeKv();

    for (const plaintext of [keyB.plaintext, keyATest.plaintext]) {
      const { res } = await call(
        t.db,
        plaintext,
        "DELETE",
        `/v1/reviews/${liveInA.id}`,
        { kv },
      );
      expect(res.status).toBe(404);
    }
    expect(kv.store.size).toBe(0);
    expect(await reviewCount(t.db, a.id)).toBe(1);
    expect(await reviewCount(t.db, b.id)).toBe(1);
    const [row] = await t.db
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, liveInA.id));
    expect(row?.id).toBe(liveInA.id);
  });
});

describe("auth on every CRUD route", () => {
  const routes = (id: string) =>
    [
      ["GET", "/v1/reviews", undefined],
      ["GET", `/v1/reviews/${id}`, undefined],
      ["PATCH", `/v1/reviews/${id}`, { hidden: true }],
      ["DELETE", `/v1/reviews/${id}`, undefined],
    ] as const;

  it("403 forbidden for a publishable key", async () => {
    const p = await project(t.db, { reviewCount: 1 });
    const target = await review(t.db, { projectId: p.id });
    const pk = await issueKey(t.db, p.id, "publishable");
    const kv = fakeKv();

    for (const [method, path, body] of routes(target.id)) {
      const { res, json } = await call(t.db, pk.plaintext, method, path, {
        body,
        kv,
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(json).toMatchObject({
        error: {
          code: "forbidden",
          doc_url: "https://docs.proofql.com/errors#forbidden",
          request_id: res.headers.get(REQUEST_ID_HEADER),
        },
      });
    }
    expect(kv.store.size).toBe(0);
    expect(await reviewCount(t.db, p.id)).toBe(1);
  });

  it("401 unauthorized for a revoked key and a missing header", async () => {
    const p = await project(t.db, { reviewCount: 1 });
    const target = await review(t.db, { projectId: p.id });
    const { plaintext, row } = await issueKey(t.db, p.id);
    await t.db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiKeys.id, row.id));
    const kv = fakeKv();

    for (const [method, path, body] of routes(target.id)) {
      const { res, json } = await call(t.db, plaintext, method, path, {
        body,
        kv,
      });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(json.error.code).toBe("unauthorized");
    }

    const app = createApp({ db: t.db });
    const bare = await app.request("/v1/reviews", { method: "GET" }, env(kv));
    expect(bare.status).toBe(401);

    expect(kv.store.size).toBe(0);
    expect(await reviewCount(t.db, p.id)).toBe(1);
    const [stillThere] = await t.db
      .select({ hiddenAt: schema.reviews.hiddenAt })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, target.id));
    expect(stillThere?.hiddenAt).toBeNull();
  });
});

describe("CRUD changes reach /v1/query", () => {
  /** A review with its embedded `full` chunk — what the pipeline produces. */
  async function indexed(projectId: string, text: string, occurredAt: Date) {
    const r = await review(t.db, {
      projectId,
      text,
      rating: 5,
      occurredAt,
      indexedAt: new Date(),
    });
    const [embedding] = fakeEmbed([text]);
    await chunk(t.db, {
      reviewId: r.id,
      kind: "full",
      text,
      startOffset: 0,
      embedding,
    });
    return r;
  }

  /** Newest publishable reviews (no `q`), as ids. */
  async function queried(plaintext: string, kv: FakeKv): Promise<string[]> {
    const app = createApp({ db: t.db, embedder: new FakeEmbeddingProvider() });
    const res = await app.request(
      "/v1/query",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${plaintext}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ limit: 10 }),
      },
      env(kv),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as QueryResponse;
    return body.results.map((r) => r.review.id);
  }

  it("a hidden review disappears from query results, returns on unhide, and is gone after delete", async () => {
    const p = await project(t.db, { reviewCount: 2 });
    const { plaintext } = await issueKey(t.db, p.id);
    const newer = await indexed(
      p.id,
      "The hygienist was gentle.",
      new Date("2026-03-02T00:00:00Z"),
    );
    const older = await indexed(
      p.id,
      "Parking was easy.",
      new Date("2026-03-01T00:00:00Z"),
    );
    const kv = fakeKv();

    expect(await queried(plaintext, kv)).toEqual([newer.id, older.id]);

    const hide = await call(
      t.db,
      plaintext,
      "PATCH",
      `/v1/reviews/${newer.id}`,
      { body: { hidden: true }, kv },
    );
    expect(hide.res.status).toBe(200);
    expect(await queried(plaintext, kv)).toEqual([older.id]);

    const unhide = await call(
      t.db,
      plaintext,
      "PATCH",
      `/v1/reviews/${newer.id}`,
      { body: { hidden: false }, kv },
    );
    expect(unhide.res.status).toBe(200);
    expect(await queried(plaintext, kv)).toEqual([newer.id, older.id]);

    const del = await call(
      t.db,
      plaintext,
      "DELETE",
      `/v1/reviews/${newer.id}`,
      { kv },
    );
    expect(del.res.status).toBe(204);
    expect(await queried(plaintext, kv)).toEqual([older.id]);
    expect(generation(kv, p.id)).toBe(3);
  });
});
