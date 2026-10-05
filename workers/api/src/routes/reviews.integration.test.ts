/**
 * `POST /v1/reviews` against the real schema: the @proofql/db harness gives
 * this file a private database, `createApp({ db })` injects it, and a
 * recording fake stands in for the ingest queue. The execution context is
 * faked too, so `waitUntil` work (last_used_at) can be awaited and asserted.
 */

import {
  generateApiKey,
  type IngestMessage,
  PRICING_URL,
  recordingSink,
} from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { project, review, setupTestDb } from "@proofql/db/test";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { fakeCtx, issueKey, testEnv } from "../../test/helpers.js";
import { createApp } from "../app.js";
import type { ApiBindings } from "../bindings.js";
import type { IngestResponse } from "./reviews.js";

const t = setupTestDb();

/** What workerd throws once the free plan's daily Queues operations are spent (#159). */
const QUEUE_LIMIT_MESSAGE = "Queue sendBatch failed: Free tier limit exceeded";

/**
 * Records every `sendBatch` call; `send` is unused by the route. With
 * `failWith`, every `sendBatch` throws that message instead.
 */
function fakeQueue(failWith?: string) {
  const batches: IngestMessage[][] = [];
  const queue = {
    batches,
    attempts: 0,
    send: async () => {
      throw new Error("route must use sendBatch");
    },
    sendBatch: async (messages: Iterable<{ body: IngestMessage }>) => {
      queue.attempts += 1;
      if (failWith !== undefined) throw new Error(failWith);
      batches.push([...messages].map((m) => m.body));
    },
  };
  return queue;
}

function env(queue: ReturnType<typeof fakeQueue>): ApiBindings {
  return testEnv({ queue: queue as unknown as Queue<IngestMessage> });
}

function reviewBody(n: number, overrides: Record<string, unknown> = {}) {
  return {
    external_id: `ext-${n}`,
    source: "google",
    rating: 5,
    text: `Review number ${n}: the hygienist was gentle and thorough.`,
    author_name: `Author ${n}`,
    occurred_at: "2026-03-14T18:20:00Z",
    ...overrides,
  };
}

/** One request: app, env, ctx wired; returns parsed JSON and the ctx. */
async function post(
  db: Db,
  plaintext: string,
  body: unknown,
  queue = fakeQueue(),
  out = recordingSink(),
) {
  const app = createApp({ db, logSink: out.sink });
  const ctx = fakeCtx();
  const res = await app.request(
    "/v1/reviews",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${plaintext}`,
        "content-type": "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env(queue),
    ctx.asExecutionContext(),
  );
  await ctx.flush();
  // biome-ignore lint/suspicious/noExplicitAny: test reads both success and error shapes
  const json = (await res.json()) as any;
  return { res, json, queue, ctx, out };
}

async function storedReviews(db: Db, projectId: string) {
  return db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.projectId, projectId))
    .orderBy(schema.reviews.externalId);
}

async function runs(db: Db, projectId: string) {
  return db
    .select()
    .from(schema.ingestRuns)
    .where(eq(schema.ingestRuns.projectId, projectId))
    .orderBy(schema.ingestRuns.startedAt);
}

describe("POST /v1/reviews", () => {
  it("inserts new reviews, enqueues one message each, records the run", async () => {
    const p = await project(t.db);
    const { plaintext, row: key } = await issueKey(t.db, p.id);

    const { res, json, queue } = await post(t.db, plaintext, [
      reviewBody(1),
      reviewBody(2, { rating: null, source: "custom" }),
    ]);

    expect(res.status).toBe(200);
    const body = json as IngestResponse;
    expect(body.indexing).toBeUndefined();
    expect(body.reviews).toHaveLength(2);
    expect(
      body.reviews.map((r) => [r.external_id, r.source, r.status]),
    ).toEqual([
      ["ext-1", "google", "indexing"],
      ["ext-2", "custom", "indexing"],
    ]);

    const stored = await storedReviews(t.db, p.id);
    expect(stored).toHaveLength(2);
    const [r1, r2] = stored;
    expect(r1).toMatchObject({
      environment: "live",
      rating: 5,
      sentiment: "positive",
      sentimentSource: "rating",
      indexedAt: null,
      authorName: "Author 1",
      metadata: {},
    });
    // Unrated: sentiment is the pipeline's job.
    expect(r2).toMatchObject({
      rating: null,
      sentiment: null,
      sentimentSource: null,
    });

    expect(queue.batches).toHaveLength(1);
    expect(queue.batches[0]).toEqual(
      body.reviews.map((r) => ({
        type: "review.index",
        reviewId: r.id,
        projectId: p.id,
        environment: "live",
      })),
    );

    const [run] = await runs(t.db, p.id);
    expect(run).toMatchObject({
      kind: "api",
      environment: "live",
      status: "succeeded",
      received: 2,
      created: 2,
      updated: 0,
      skipped: 0,
      failed: 0,
      error: null,
    });
    expect(run?.finishedAt).not.toBeNull();

    const [after] = await t.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, p.id));
    expect(after?.reviewCount).toBe(2);

    const [usedKey] = await t.db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, key.id));
    expect(usedKey?.lastUsedAt).not.toBeNull();
  });

  it("refreshes last_used_at at most once per minute", async () => {
    const p = await project(t.db);
    const { plaintext, row: key } = await issueKey(t.db, p.id);

    const first = await post(t.db, plaintext, reviewBody(1));
    expect(first.res.status).toBe(200);
    const [afterFirst] = await t.db
      .select({ lastUsedAt: schema.apiKeys.lastUsedAt })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, key.id));

    const second = await post(t.db, plaintext, reviewBody(1));
    expect(second.res.status).toBe(200);
    // waitUntil carries the db-close promise on every request; the first
    // request also carried the last_used_at refresh, the second did not.
    expect(second.ctx.pending).toHaveLength(first.ctx.pending.length - 1);
    const [afterSecond] = await t.db
      .select({ lastUsedAt: schema.apiKeys.lastUsedAt })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, key.id));
    expect(afterSecond?.lastUsedAt?.getTime()).toBe(
      afterFirst?.lastUsedAt?.getTime(),
    );
  });

  it("Queues daily limit: stores the reviews, answers 200 with indexing deferred, logs quota.exhausted (#159)", async () => {
    const p = await project(t.db);
    const { plaintext } = await issueKey(t.db, p.id);

    const { res, json, queue, out } = await post(
      t.db,
      plaintext,
      [reviewBody(1), reviewBody(2)],
      fakeQueue(QUEUE_LIMIT_MESSAGE),
    );

    expect(res.status).toBe(200);
    const body = json as IngestResponse;
    expect(body.indexing).toBe("deferred");
    expect(body.reviews.map((r) => [r.external_id, r.status])).toEqual([
      ["ext-1", "indexing"],
      ["ext-2", "indexing"],
    ]);
    expect(queue.attempts).toBe(1);

    // The rows are committed and unindexed: the sweep will pick them up.
    const stored = await storedReviews(t.db, p.id);
    expect(stored.map((r) => [r.externalId, r.indexedAt])).toEqual([
      ["ext-1", null],
      ["ext-2", null],
    ]);
    const [run] = await runs(t.db, p.id);
    expect(run).toMatchObject({
      status: "succeeded",
      received: 2,
      created: 2,
      failed: 0,
    });

    expect(out.only("quota.exhausted")).toMatchObject({
      level: "error",
      resource: "queues",
      site: "api.ingest",
      messages: 2,
      project_id: p.id,
      key_environment: "live",
      renews_at: expect.stringMatching(/T00:00:00\.000Z$/),
      error: { message: QUEUE_LIMIT_MESSAGE },
    });
    expect(out.find("request.failed")).toHaveLength(0);
  });

  it("any other queue failure: 200 with indexing deferred and ingest.enqueue_deferred at warn", async () => {
    const p = await project(t.db);
    const { plaintext } = await issueKey(t.db, p.id);

    const { res, json, out } = await post(
      t.db,
      plaintext,
      reviewBody(1),
      fakeQueue("Queue sendBatch failed: Unknown error"),
    );

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      indexing: "deferred",
      reviews: [{ external_id: "ext-1", status: "indexing" }],
    });
    expect(out.only("ingest.enqueue_deferred")).toMatchObject({
      level: "warn",
      site: "api.ingest",
      messages: 1,
    });
    expect(out.find("quota.exhausted")).toHaveLength(0);
  });

  it("nothing to index: a failing queue is never called and nothing is deferred", async () => {
    const p = await project(t.db);
    const { plaintext } = await issueKey(t.db, p.id);
    expect((await post(t.db, plaintext, reviewBody(1))).res.status).toBe(200);

    // Same text again: an update with nothing to enqueue.
    const again = await post(
      t.db,
      plaintext,
      reviewBody(1),
      fakeQueue(QUEUE_LIMIT_MESSAGE),
    );
    expect(again.res.status).toBe(200);
    expect(again.json.indexing).toBeUndefined();
    expect(again.queue.attempts).toBe(0);
  });

  it("accepts a single object body", async () => {
    const p = await project(t.db);
    const { plaintext } = await issueKey(t.db, p.id);

    const { res, json } = await post(t.db, plaintext, reviewBody(7));

    expect(res.status).toBe(200);
    expect(json.reviews).toHaveLength(1);
    expect(json.reviews[0].external_id).toBe("ext-7");
  });

  it("accepts a batch of 100 and refuses 101 with 422 validation_failed", async () => {
    const p = await project(t.db);
    const { plaintext } = await issueKey(t.db, p.id);

    const ok = await post(
      t.db,
      plaintext,
      Array.from({ length: 100 }, (_, i) => reviewBody(i)),
    );
    expect(ok.res.status).toBe(200);
    expect(ok.json.reviews).toHaveLength(100);
    expect(ok.queue.batches).toHaveLength(1);
    expect(ok.queue.batches[0]).toHaveLength(100);

    const tooMany = await post(
      t.db,
      plaintext,
      Array.from({ length: 101 }, (_, i) => reviewBody(1000 + i)),
    );
    expect(tooMany.res.status).toBe(422);
    expect(tooMany.json).toMatchObject({
      error: {
        code: "validation_failed",
        doc_url: "https://docs.proofql.com/errors#validation_failed",
        details: [{ path: "", message: expect.stringMatching(/100/) }],
      },
    });
    expect(tooMany.queue.batches).toHaveLength(0);
    expect(await storedReviews(t.db, p.id)).toHaveLength(100);

    const all = await runs(t.db, p.id);
    expect(all.map((r) => r.status)).toEqual(["succeeded", "failed"]);
    expect(all[1]).toMatchObject({
      received: 0,
      error: expect.stringMatching(/^validation_failed:/),
    });
  });

  it("422 validation_failed with flattened zod issues for bad fields", async () => {
    const p = await project(t.db);
    const { plaintext } = await issueKey(t.db, p.id);

    const { res, json, queue } = await post(t.db, plaintext, [
      reviewBody(1),
      reviewBody(2, { rating: 9, bogus: true }),
    ]);

    expect(res.status).toBe(422);
    expect(json.error.code).toBe("validation_failed");
    const paths = json.error.details
      .map((d: { path: string }) => d.path)
      .sort();
    expect(paths).toEqual(["1", "1.rating"]);
    expect(queue.batches).toHaveLength(0);
    expect(await storedReviews(t.db, p.id)).toHaveLength(0);
  });

  it("422 validation_failed for a body that is not JSON", async () => {
    const p = await project(t.db);
    const { plaintext } = await issueKey(t.db, p.id);

    const { res, json } = await post(t.db, plaintext, "{not json");

    expect(res.status).toBe(422);
    expect(json.error.details).toEqual([
      { path: "", message: "Request body is not valid JSON." },
    ]);
  });

  it("collapses duplicate external_ids in one batch: last wins, one row", async () => {
    const p = await project(t.db);
    const { plaintext } = await issueKey(t.db, p.id);

    const { res, json, queue } = await post(t.db, plaintext, [
      reviewBody(1, { text: "first version" }),
      reviewBody(2),
      reviewBody(1, { text: "second version", rating: 4 }),
    ]);

    expect(res.status).toBe(200);
    expect(json.reviews).toHaveLength(2);
    expect(
      json.reviews.map((r: { external_id: string }) => r.external_id),
    ).toEqual(["ext-2", "ext-1"]);
    const stored = await storedReviews(t.db, p.id);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      externalId: "ext-1",
      text: "second version",
      rating: 4,
    });
    expect(queue.batches[0]).toHaveLength(2);

    const [run] = await runs(t.db, p.id);
    expect(run).toMatchObject({
      received: 3,
      created: 2,
      updated: 0,
      skipped: 1,
    });
  });

  it("re-posting unchanged text updates mutable fields without enqueueing", async () => {
    const p = await project(t.db);
    const { plaintext } = await issueKey(t.db, p.id);
    const first = await post(t.db, plaintext, reviewBody(1));
    const id = first.json.reviews[0].id as string;
    // Simulate the pipeline having indexed it.
    await t.db
      .update(schema.reviews)
      .set({ indexedAt: new Date("2026-03-15T00:00:00Z") })
      .where(eq(schema.reviews.id, id));

    const { res, json, queue } = await post(
      t.db,
      plaintext,
      reviewBody(1, {
        rating: 3,
        author_name: "Renamed",
        url: "https://maps.google.com/x",
        metadata: { location: "north" },
      }),
    );

    expect(res.status).toBe(200);
    expect(json.reviews).toEqual([
      { id, external_id: "ext-1", source: "google", status: "indexed" },
    ]);
    expect(queue.batches).toHaveLength(0);

    const [row] = await storedReviews(t.db, p.id);
    expect(row).toMatchObject({
      id,
      rating: 3,
      sentiment: "neutral",
      sentimentSource: "rating",
      authorName: "Renamed",
      url: "https://maps.google.com/x",
      metadata: { location: "north" },
    });
    expect(row?.indexedAt).not.toBeNull();
    expect(row?.updatedAt.getTime()).toBeGreaterThan(
      row?.createdAt.getTime() ?? 0,
    );

    const all = await runs(t.db, p.id);
    expect(all[1]).toMatchObject({
      received: 1,
      created: 0,
      updated: 1,
      skipped: 0,
    });
    const [after] = await t.db
      .select({ reviewCount: schema.projects.reviewCount })
      .from(schema.projects)
      .where(eq(schema.projects.id, p.id));
    expect(after?.reviewCount).toBe(1);
  });

  it("changed text re-enqueues and clears indexed_at", async () => {
    const p = await project(t.db);
    const { plaintext } = await issueKey(t.db, p.id);
    const first = await post(t.db, plaintext, reviewBody(1));
    const id = first.json.reviews[0].id as string;
    await t.db
      .update(schema.reviews)
      .set({ indexedAt: new Date() })
      .where(eq(schema.reviews.id, id));

    const { res, json, queue } = await post(
      t.db,
      plaintext,
      reviewBody(1, { text: "Completely rewritten." }),
    );

    expect(res.status).toBe(200);
    expect(json.reviews[0]).toMatchObject({ id, status: "indexing" });
    expect(queue.batches).toEqual([
      [
        {
          type: "review.index",
          reviewId: id,
          projectId: p.id,
          environment: "live",
        },
      ],
    ]);
    const [row] = await storedReviews(t.db, p.id);
    expect(row).toMatchObject({
      text: "Completely rewritten.",
      indexedAt: null,
    });
  });

  it("removing the rating re-enqueues so the model can classify sentiment", async () => {
    const p = await project(t.db);
    const { plaintext } = await issueKey(t.db, p.id);
    const first = await post(t.db, plaintext, reviewBody(1));
    const id = first.json.reviews[0].id as string;

    const { queue } = await post(
      t.db,
      plaintext,
      reviewBody(1, { rating: null }),
    );

    expect(queue.batches).toHaveLength(1);
    const [row] = await storedReviews(t.db, p.id);
    expect(row).toMatchObject({
      id,
      rating: null,
      sentiment: null,
      sentimentSource: null,
    });
  });

  it("401 unauthorized for a revoked key and for an unknown key", async () => {
    const p = await project(t.db);
    const { plaintext, row } = await issueKey(t.db, p.id);
    await t.db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiKeys.id, row.id));

    const revoked = await post(t.db, plaintext, reviewBody(1));
    expect(revoked.res.status).toBe(401);
    expect(revoked.json.error.code).toBe("unauthorized");

    const unknown = await generateApiKey({
      kind: "secret",
      environment: "live",
    });
    const never = await post(t.db, unknown.plaintext, reviewBody(1));
    expect(never.res.status).toBe(401);

    expect(await storedReviews(t.db, p.id)).toHaveLength(0);
    expect(await runs(t.db, p.id)).toHaveLength(0);
  });

  it("isolates projects: another project's key cannot touch these rows", async () => {
    const a = await project(t.db);
    const b = await project(t.db);
    const keyA = await issueKey(t.db, a.id);
    const keyB = await issueKey(t.db, b.id);

    await post(t.db, keyA.plaintext, reviewBody(1, { text: "A's text" }));
    const { res, json } = await post(
      t.db,
      keyB.plaintext,
      reviewBody(1, { text: "B's text" }),
    );

    expect(res.status).toBe(200);
    expect(json.reviews[0].status).toBe("indexing");
    const rowsA = await storedReviews(t.db, a.id);
    const rowsB = await storedReviews(t.db, b.id);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0]?.text).toBe("A's text");
    expect(rowsB[0]?.text).toBe("B's text");
    expect(rowsA[0]?.id).not.toBe(rowsB[0]?.id);
  });

  it("a test-environment key writes only environment = test rows", async () => {
    const p = await project(t.db);
    const live = await issueKey(t.db, p.id, "secret", "live");
    const test = await issueKey(t.db, p.id, "secret", "test");

    await post(t.db, live.plaintext, reviewBody(1, { text: "live text" }));
    const { res, json, queue } = await post(
      t.db,
      test.plaintext,
      reviewBody(1, { text: "test text" }),
    );

    expect(res.status).toBe(200);
    expect(json.reviews[0].status).toBe("indexing");
    expect(queue.batches[0]?.[0]).toMatchObject({ environment: "test" });

    const rows = await storedReviews(t.db, p.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.environment, r.text]).sort()).toEqual([
      ["live", "live text"],
      ["test", "test text"],
    ]);
    const [testRun] = await t.db
      .select()
      .from(schema.ingestRuns)
      .where(
        and(
          eq(schema.ingestRuns.projectId, p.id),
          eq(schema.ingestRuns.environment, "test"),
        ),
      );
    expect(testRun).toMatchObject({ created: 1 });
  });

  it("422 review_limit_reached when the batch would exceed the free cap; nothing written", async () => {
    const p = await project(t.db, { reviewCount: 4_999 });
    const { plaintext } = await issueKey(t.db, p.id);
    // An existing row that the batch also touches: updates do not count
    // toward the cap, but a rejected batch must leave it untouched too.
    const existing = await review(t.db, {
      projectId: p.id,
      externalId: "ext-9",
      text: "untouched",
    });

    const { res, json, queue } = await post(t.db, plaintext, [
      reviewBody(1),
      reviewBody(2),
      reviewBody(9, { text: "would change" }),
    ]);

    expect(res.status).toBe(422);
    expect(json).toMatchObject({
      error: {
        code: "review_limit_reached",
        doc_url: "https://docs.proofql.com/errors#review_limit_reached",
        message: expect.stringMatching(/5000/),
      },
    });
    // Names the plan, the limit, and where to go: the snippet shows nothing
    // on an error, so this message is the whole story for the integrator.
    expect(json.error.message).toMatch(/Free plan/);
    expect(json.error.message).toContain(PRICING_URL);
    expect(json.error.message).toMatch(/Nothing was written/);
    expect(queue.batches).toHaveLength(0);

    const rows = await storedReviews(t.db, p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: existing.id, text: "untouched" });
    const [after] = await t.db
      .select({ reviewCount: schema.projects.reviewCount })
      .from(schema.projects)
      .where(eq(schema.projects.id, p.id));
    expect(after?.reviewCount).toBe(4_999);

    const [run] = await runs(t.db, p.id);
    expect(run).toMatchObject({
      status: "failed",
      received: 3,
      failed: 3,
      error: expect.stringMatching(/^review_limit_reached:/),
    });
  });

  it("exactly reaching the cap is allowed", async () => {
    const p = await project(t.db, { reviewCount: 4_999 });
    const { plaintext } = await issueKey(t.db, p.id);

    const { res } = await post(t.db, plaintext, reviewBody(1));

    expect(res.status).toBe(200);
    const [after] = await t.db
      .select({ reviewCount: schema.projects.reviewCount })
      .from(schema.projects)
      .where(eq(schema.projects.id, p.id));
    expect(after?.reviewCount).toBe(5_000);
  });
});
