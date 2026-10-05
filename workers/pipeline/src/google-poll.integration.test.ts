/**
 * The Google poller end to end against the real schema and the in-process
 * fake Google server: credentials are real AES-GCM ciphertext, reviews go
 * through `upsertReviews`, and the assertions read `reviews`, `ingest_runs`,
 * `connections` and the recording queue back.
 */

import { generationKey, type IngestMessage, MemoryKv } from "@proofql/core";
import { schema } from "@proofql/db";
import { project, review, setupTestDb } from "@proofql/db/test";
import {
  createPacer,
  decryptCredentials,
  encryptCredentials,
  importCredentialsKey,
  type MappedLocation,
} from "@proofql/google";
import { createFakeGoogle, type FakeGoogle } from "@proofql/google/fake";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { testLogger } from "../test/log.js";
import {
  type GooglePollContext,
  type GooglePollOptions,
  pollGoogleConnections,
} from "./google-poll.js";
import type { IngestQueue } from "./sweep.js";

const { connections, ingestRuns, reviews, projects } = schema;

const t = setupTestDb();

const CREDENTIALS_KEY = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
);

class FakeQueue implements IngestQueue {
  readonly sent: IngestMessage[] = [];
  async sendBatch(messages: Iterable<{ body: IngestMessage }>): Promise<void> {
    for (const m of messages) this.sent.push(m.body);
  }
}

/** What workerd throws once the free plan's daily Queues operations are spent (#159). */
const QUEUE_LIMIT_MESSAGE = "Queue sendBatch failed: Free tier limit exceeded";

/** A queue whose every `sendBatch` throws `message`; counts the attempts. */
class FailingQueue extends FakeQueue {
  attempts = 0;
  constructor(readonly message = QUEUE_LIMIT_MESSAGE) {
    super();
  }
  override async sendBatch(): Promise<void> {
    this.attempts += 1;
    throw new Error(this.message);
  }
}

/** The fixture locations as the dashboard would map them (#45). */
function mapped(
  overrides: Partial<
    Record<"201" | "202" | "203", Partial<MappedLocation>>
  > = {},
): MappedLocation[] {
  const base: MappedLocation[] = [
    {
      id: "201",
      account: "100",
      title: "North",
      verified: true,
      enabled: true,
      placeId: "ChIJnorth0000000000000001",
    },
    {
      id: "202",
      account: "100",
      title: "South",
      verified: true,
      enabled: true,
    },
    {
      id: "203",
      account: "100",
      title: "Lakeside",
      verified: false,
      enabled: true,
    },
  ];
  return base.map((l) => ({
    ...l,
    ...overrides[l.id as "201" | "202" | "203"],
  }));
}

let fake: FakeGoogle;
let clock: number;
// Connections, runs and reviews hang off projects; one DELETE resets a test.
afterEach(async () => {
  await t.db.delete(projects);
});
beforeEach(() => {
  clock = Date.parse("2026-10-01T06:00:00Z");
  fake = createFakeGoogle({ now: () => clock });
});

async function connect(
  input: {
    projectId?: string;
    locations?: MappedLocation[];
    expiry?: string;
    pending?: boolean;
    refreshToken?: string;
  } = {},
) {
  const projectId = input.projectId ?? (await project(t.db)).id;
  const key = await importCredentialsKey(CREDENTIALS_KEY);
  const tokens = fake.store.issueTokens();
  const credentials = await encryptCredentials(key, {
    access_token: tokens.accessToken,
    refresh_token: input.refreshToken ?? tokens.refreshToken,
    expiry: input.expiry ?? new Date(clock + 3600_000).toISOString(),
  });
  const [row] = await t.db
    .insert(connections)
    .values({
      projectId,
      kind: "google",
      status: "active",
      credentials,
      metadata: {
        locations: input.locations ?? mapped(),
        ...(input.pending ? { initial_sync_pending: true } : {}),
      },
    })
    .returning();
  if (!row) throw new Error("no connection row");
  return row;
}

function tick(
  options: Partial<GooglePollOptions> & Partial<GooglePollContext> = {},
) {
  const { log, out } = testLogger();
  const queue = (options.queue as FakeQueue | undefined) ?? new FakeQueue();
  const cache = new MemoryKv();
  const ctx: GooglePollContext = {
    db: t.db,
    queue,
    log,
    cache,
    env: {
      ENVIRONMENT: "test",
      CREDENTIALS_KEY,
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "secret",
    },
    fetch: fake.fetch,
    now: () => new Date(clock),
    pacer: createPacer({
      maxJitterMs: 0,
      sleep: async () => {},
      now: () => clock,
    }),
    sleep: async () => {},
    ...options,
  };
  const run = () =>
    pollGoogleConnections(ctx, {
      trigger: options.trigger ?? "cron",
      ...(options.connectionIds
        ? { connectionIds: options.connectionIds }
        : {}),
    });
  return { run, out, queue, cache };
}

async function reload(connectionId: string) {
  const [row] = await t.db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (!row) throw new Error("connection vanished");
  return row;
}

async function runsFor(projectId: string) {
  return t.db
    .select()
    .from(ingestRuns)
    .where(eq(ingestRuns.projectId, projectId));
}

async function reviewsFor(projectId: string) {
  return t.db.select().from(reviews).where(eq(reviews.projectId, projectId));
}

describe("pollGoogleConnections", () => {
  it("first sync imports every review of the enabled verified locations, advances cursors, writes a run", async () => {
    const connection = await connect({ pending: true });
    const { run, out, queue } = tick();

    const result = await run();

    expect(result).toMatchObject({
      connections: 1,
      synced: 1,
      needsReauth: 0,
      failed: 0,
      deferred: 0,
      rateLimited: false,
      received: 115, // 70 + 45; the unverified Lakeside is never asked
      created: 113, // minus one star-only per location
      updated: 0,
      skipped: 2,
      rejected: 0,
      requests: 3, // 201: two pages of 50; 202: one page
    });

    const stored = await reviewsFor(connection.projectId);
    expect(stored).toHaveLength(113);
    expect(
      stored.every((r) => r.source === "google" && r.environment === "live"),
    ).toBe(true);
    const byLocation = new Map<string, number>();
    for (const r of stored) {
      const loc = (r.metadata as Record<string, string>).location ?? "?";
      byLocation.set(loc, (byLocation.get(loc) ?? 0) + 1);
    }
    expect(byLocation.get("201")).toBe(69);
    expect(byLocation.get("202")).toBe(44);
    expect(byLocation.has("203")).toBe(false);
    const north = stored.find(
      (r) => (r.metadata as Record<string, string>).location === "201",
    );
    expect(north?.url).toContain("placeid=ChIJnorth");
    expect(north?.externalId).toMatch(
      /^accounts\/100\/locations\/201\/reviews\//,
    );
    expect(
      (north?.metadata as Record<string, string> | undefined)?.location_title,
    ).toBe("North");

    // Every stored review was handed to the queue for indexing.
    expect(queue.sent).toHaveLength(113);
    expect(
      new Set(queue.sent.map((m) => (m as { reviewId: string }).reviewId)).size,
    ).toBe(113);

    const [ingestRun] = await runsFor(connection.projectId);
    expect(ingestRun).toMatchObject({
      kind: "google",
      environment: "live",
      status: "succeeded",
      received: 115,
      created: 113,
      updated: 0,
      skipped: 2,
      failed: 0,
      error: null,
    });
    expect(ingestRun?.finishedAt).not.toBeNull();

    const after = await reload(connection.id);
    const cursor = JSON.parse(after.cursor ?? "{}") as Record<string, string>;
    expect(Object.keys(cursor).sort()).toEqual(["201", "202"]);
    const newest201 = fake.store.reviewsFor("201")[0]?.updateTime as string;
    expect(Date.parse(cursor["201"] as string)).toBe(Date.parse(newest201));
    expect(after.lastSyncedAt?.toISOString()).toBe(
      new Date(clock).toISOString(),
    );
    expect(
      (after.metadata as Record<string, unknown>).initial_sync_pending,
    ).toBeUndefined();
    expect(after.status).toBe("active");

    expect(out.only("google.tick.completed")).toMatchObject({
      service: "pipeline",
      trigger: "cron",
      connector: "google",
      created: 113,
      requests: 3,
    });
    expect(out.only("google.sync.completed")).toMatchObject({
      connection_id: connection.id,
      project_id: connection.projectId,
      ingest_run_id: ingestRun?.id,
    });
    // Nothing secret in any line.
    const lines = JSON.stringify(out.records);
    expect(lines).not.toMatch(/at_|rt_/);
  });

  it("second tick: one new and one edited review on the fake → one insert, one update, nothing else", async () => {
    const connection = await connect();
    await tick().run();
    expect(await reviewsFor(connection.projectId)).toHaveLength(113);

    clock += 60 * 60_000;
    const added = fake.store.addReview("202", {
      comment: "Came in for a chipped tooth; out in forty minutes.",
    });
    const editedName = fake.store.reviewsFor("201").find((r) => r.comment)
      ?.name as string;
    fake.store.editReview(
      editedName,
      "Edited: the follow-up went just as well.",
    );

    const { run, queue } = tick();
    const result = await run();

    expect(result).toMatchObject({
      synced: 1,
      received: 2,
      created: 1,
      updated: 1,
      skipped: 0,
      requests: 2, // one page per location, both stop at the cursor
    });
    const stored = await reviewsFor(connection.projectId);
    expect(stored).toHaveLength(114);
    expect(stored.find((r) => r.externalId === added.name)?.text).toContain(
      "chipped tooth",
    );
    const edited = stored.find((r) => r.externalId === editedName);
    expect(edited?.text).toBe("Edited: the follow-up went just as well.");
    expect(edited?.indexedAt).toBeNull();
    // Exactly the two changed reviews were re-enqueued.
    expect(queue.sent).toHaveLength(2);

    const runs = await runsFor(connection.projectId);
    expect(runs).toHaveLength(2);
    const cursor = JSON.parse(
      (await reload(connection.id)).cursor ?? "{}",
    ) as Record<string, string>;
    expect(Date.parse(cursor["202"] as string)).toBe(clock);
    expect(Date.parse(cursor["201"] as string)).toBe(clock);

    // A third tick with nothing new touches nothing.
    clock += 60_000;
    const quiet = await tick().run();
    expect(quiet).toMatchObject({
      received: 0,
      created: 0,
      updated: 0,
      requests: 2,
    });
    expect(await reviewsFor(connection.projectId)).toHaveLength(114);
  });

  it("a 429 stops the tick politely; the next tick resumes with no duplicate rows", async () => {
    const first = await connect();
    const second = await connect();
    // Let the first request through, then exhaust the quota on the second.
    let calls = 0;
    const gated: typeof fetch = async (input, init) => {
      calls += 1;
      if (calls === 2) fake.store.failNext(429);
      return fake.fetch(input, init);
    };
    const { run, out, queue } = tick({ fetch: gated });

    const result = await run();

    expect(result).toMatchObject({
      connections: 2,
      synced: 0,
      failed: 1,
      deferred: 1,
      rateLimited: true,
      requests: 2,
    });
    expect(out.only("google.rate_limited")).toMatchObject({
      level: "warn",
      retry_after_ms: 1000,
    });
    // The first page's reviews landed (the upsert is idempotent) but no
    // cursor advanced and the one run that opened is failed with a reason.
    const landed =
      (await reviewsFor(first.projectId)).length +
      (await reviewsFor(second.projectId)).length;
    expect(landed).toBe(queue.sent.length);
    expect(landed).toBeGreaterThan(0);
    expect(landed).toBeLessThan(113);
    const runs = [
      ...(await runsFor(first.projectId)),
      ...(await runsFor(second.projectId)),
    ];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed" });
    expect(runs[0]?.error).toContain("429");
    for (const c of [first, second]) {
      const row = await reload(c.id);
      expect(row.cursor).toBeNull();
      expect(row.lastSyncedAt).toBeNull();
      expect(row.status).toBe("active");
    }

    // Next tick: everything imports exactly once across both connections.
    clock += 6 * 3600_000;
    const next = await tick().run();
    expect(next).toMatchObject({ synced: 2, failed: 0, rateLimited: false });
    expect(await reviewsFor(first.projectId)).toHaveLength(113);
    expect(await reviewsFor(second.projectId)).toHaveLength(113);
  });

  it("Queues daily limit: the tick keeps its progress, sends once, and leaves the reviews for the sweep (#162)", async () => {
    const a = await connect({ pending: true });
    const b = await connect({ pending: true });
    const queue = new FailingQueue();
    const { run, out } = tick({ queue });

    const result = await run();

    expect(result).toMatchObject({
      connections: 2,
      synced: 2,
      failed: 0,
      created: 226,
      indexingDeferred: 226,
    });
    // One refused call; every later send in the tick is skipped.
    expect(queue.attempts).toBe(1);
    for (const c of [a, b]) {
      const [ingestRun] = await runsFor(c.projectId);
      expect(ingestRun).toMatchObject({
        status: "succeeded",
        created: 113,
        error: null,
      });
      const row = await reload(c.id);
      expect(Object.keys(JSON.parse(row.cursor ?? "{}")).sort()).toEqual([
        "201",
        "202",
      ]);
      expect(row.lastSyncedAt).not.toBeNull();
      expect(
        (row.metadata as Record<string, unknown>).initial_sync_pending,
      ).toBeUndefined();
      const stored = await reviewsFor(c.projectId);
      expect(stored).toHaveLength(113);
      expect(stored.every((r) => r.indexedAt === null)).toBe(true);
    }
    expect(out.only("quota.exhausted")).toMatchObject({
      level: "error",
      resource: "queues",
      site: "pipeline.google_poll",
      error: { message: QUEUE_LIMIT_MESSAGE },
    });
    expect(out.find("google.sync.completed")).toHaveLength(2);
    expect(
      out.find("google.sync.completed").map((l) => l.indexing_deferred),
    ).toEqual([113, 113]);
    expect(out.only("google.tick.completed")).toMatchObject({
      synced: 2,
      failed: 0,
      indexing_deferred: 226,
    });

    // The next tick finds nothing new and sends nothing: the sweep owns
    // the unindexed rows now.
    clock += 6 * 3600_000;
    const next = tick();
    expect(await next.run()).toMatchObject({ synced: 2, created: 0 });
    expect(next.queue.sent).toHaveLength(0);
  });

  it("any other send failure is logged at warn, does not fail the sync, and every batch is still tried", async () => {
    const connection = await connect();
    const queue = new FailingQueue("Queue sendBatch failed: Unknown error");
    const { run, out } = tick({ queue });

    const result = await run();

    expect(result).toMatchObject({ synced: 1, indexingDeferred: 113 });
    // One send per committed page batch: 201 has two pages, 202 one.
    expect(queue.attempts).toBe(3);
    expect(out.find("ingest.enqueue_deferred")).toHaveLength(3);
    expect(out.find("quota.exhausted")).toHaveLength(0);
    const [ingestRun] = await runsFor(connection.projectId);
    expect(ingestRun?.status).toBe("succeeded");
  });

  it("invalid_grant on refresh marks the connection needs_reauth and clears its credentials", async () => {
    const connection = await connect({
      expiry: new Date(clock + 60_000).toISOString(), // within the 5-minute window
    });
    fake.store.invalidGrant = true;
    const { run, out } = tick();

    const result = await run();

    expect(result).toMatchObject({
      connections: 1,
      synced: 0,
      needsReauth: 1,
      failed: 0,
      requests: 0,
    });
    const after = await reload(connection.id);
    expect(after.status).toBe("needs_reauth");
    expect(after.credentials).toBeNull();
    expect(await runsFor(connection.projectId)).toHaveLength(0);
    expect(out.only("google.needs_reauth")).toMatchObject({
      level: "warn",
      reason: "invalid_grant",
      connection_id: connection.id,
    });

    // Dead connections are not polled again.
    fake.store.invalidGrant = false;
    expect((await tick().run()).connections).toBe(0);
  });

  it("refreshes an expiring access token and stores the new one encrypted", async () => {
    const connection = await connect({
      expiry: new Date(clock + 2 * 60_000).toISOString(),
    });
    const key = await importCredentialsKey(CREDENTIALS_KEY);
    const before = await decryptCredentials(
      key,
      connection.credentials as string,
    );
    const { run, out } = tick();

    const result = await run();

    expect(result.synced).toBe(1);
    const after = await decryptCredentials(
      key,
      (await reload(connection.id)).credentials as string,
    );
    expect(after.access_token).not.toBe(before.access_token);
    expect(after.refresh_token).toBe(before.refresh_token);
    expect(Date.parse(after.expiry)).toBe(clock + 3600_000);
    expect(out.only("google.token_refreshed")).toMatchObject({
      connection_id: connection.id,
    });
  });

  it("skips disabled locations", async () => {
    const connection = await connect({
      locations: mapped({ "202": { enabled: false } }),
    });
    const result = await tick().run();
    expect(result).toMatchObject({ created: 69, received: 70, requests: 2 });
    const stored = await reviewsFor(connection.projectId);
    expect(
      stored.every(
        (r) => (r.metadata as Record<string, string>).location === "201",
      ),
    ).toBe(true);
    const cursor = JSON.parse((await reload(connection.id)).cursor ?? "{}");
    expect(Object.keys(cursor)).toEqual(["201"]);
  });

  it("truncates at the plan cap and counts the refused reviews as failed", async () => {
    const p = await project(t.db);
    // Free plan: 5,000 reviews per project. Leave room for ten.
    await t.db
      .update(projects)
      .set({ reviewCount: 4990 })
      .where(eq(projects.id, p.id));
    const connection = await connect({ projectId: p.id });
    const { run, out } = tick();

    const result = await run();

    expect(result).toMatchObject({
      synced: 1,
      created: 10,
      rejected: 103,
      received: 115,
    });
    expect(await reviewsFor(connection.projectId)).toHaveLength(10);
    const [ingestRun] = await runsFor(p.id);
    expect(ingestRun).toMatchObject({
      status: "succeeded",
      created: 10,
      failed: 103,
      skipped: 2,
    });
    expect(out.find("google.cap_reached").length).toBeGreaterThan(0);
    expect(out.find("google.cap_reached")[0]).toMatchObject({
      level: "warn",
      limit: 5000,
    });
    // The cursor still advanced: the refused reviews are a plan problem, not a
    // sync problem, and re-walking them every six hours would waste quota.
    expect(
      JSON.parse((await reload(connection.id)).cursor ?? "{}"),
    ).toHaveProperty("201");
  });

  it("retries a 5xx once, then fails only that connection", async () => {
    const connection = await connect();
    fake.store.failNext(503);
    const { run, out } = tick();
    const result = await run();
    expect(result).toMatchObject({
      synced: 1,
      failed: 0,
      created: 113,
      requests: 4,
    });
    expect(out.only("google.request_retry")).toMatchObject({
      status: 503,
      connection_id: connection.id,
    });

    // Twice in a row: that connection's run fails, the tick goes on.
    const other = await connect();
    clock += 3600_000;
    fake.store.failNext(503, 2);
    const second = await tick().run();
    expect(second).toMatchObject({
      connections: 2,
      failed: 1,
      synced: 1,
      rateLimited: false,
      deferred: 0,
    });
    const failedRuns = [
      ...(await runsFor(connection.projectId)),
      ...(await runsFor(other.projectId)),
    ].filter((r) => r.status === "failed");
    expect(failedRuns).toHaveLength(1);
    expect(failedRuns[0]?.error).toContain("UNAVAILABLE (503)");
  });

  it("an unexpected error fails only that connection's run, never leaving it running", async () => {
    const a = await connect();
    const b = await connect();
    // The very first reviews request of the tick dies on the wire.
    let fired = false;
    const flaky: typeof fetch = async (input, init) => {
      if (!fired && String(input).includes("/v4/")) {
        fired = true;
        throw new TypeError("fetch failed: ECONNRESET");
      }
      return fake.fetch(input, init);
    };
    const { run, out } = tick({ fetch: flaky });

    const result = await run();

    expect(result).toMatchObject({
      connections: 2,
      synced: 1,
      failed: 1,
      deferred: 0,
    });
    const runs = [
      ...(await runsFor(a.projectId)),
      ...(await runsFor(b.projectId)),
    ];
    expect(runs.map((r) => r.status).sort()).toEqual(["failed", "succeeded"]);
    const failedRun = runs.find((r) => r.status === "failed");
    expect(failedRun?.error).toContain("ECONNRESET");
    expect(failedRun?.finishedAt).not.toBeNull();
    expect(
      out
        .find("google.sync.failed")
        .some((l) => l.level === "error" && l.stage === "location"),
    ).toBe(true);
    // The failed connection has no cursor and no last sync; next tick heals it.
    const failedConnection = (
      await Promise.all([reload(a.id), reload(b.id)])
    ).find((c) => c.lastSyncedAt === null);
    expect(failedConnection?.cursor).toBeNull();
    expect(await tick().run()).toMatchObject({ synced: 2 });
  });

  it("the first sync supersedes the Places bootstrap rows and bumps the generation; later syncs do not touch them", async () => {
    const p = await project(t.db, { reviewCount: 2 });
    const connection = await connect({ projectId: p.id, pending: true });
    for (const n of [1, 2]) {
      await review(t.db, {
        projectId: p.id,
        source: "google",
        externalId: `places/ChIJnorth0000000000000001/reviews/${n}`,
        metadata: { place_id: "ChIJnorth0000000000000001" },
      });
    }
    // A push-API Google review with a non-Places id must survive.
    const keeper = await review(t.db, {
      projectId: p.id,
      source: "google",
      externalId: "accounts/999/locations/1/reviews/manual",
    });
    const { run, out, cache } = tick();

    const result = await run();

    expect(result.synced).toBe(1);
    const stored = await reviewsFor(p.id);
    expect(stored).toHaveLength(113 + 1);
    expect(stored.some((r) => r.externalId.startsWith("places/"))).toBe(false);
    expect(stored.some((r) => r.id === keeper.id)).toBe(true);
    const [row] = await t.db
      .select({ reviewCount: projects.reviewCount })
      .from(projects)
      .where(eq(projects.id, p.id));
    // 2 bootstrap rows gone, 113 connector rows added (the keeper was never counted).
    expect(row?.reviewCount).toBe(113);
    expect(cache.puts).toEqual([{ key: generationKey(p.id), value: "1" }]);
    expect(out.only("google.bootstrap_superseded")).toMatchObject({
      connection_id: connection.id,
      deleted: 2,
      generation: 1,
    });

    // Second sync: nothing to supersede, no bump.
    clock += 3600_000;
    const again = tick();
    await again.run();
    expect(again.cache.puts).toEqual([]);
    expect(again.out.find("google.bootstrap_superseded")).toEqual([]);
    expect(await reviewsFor(p.id)).toHaveLength(114);
  });

  it("the queue path syncs only the named connection and ignores the pending flag", async () => {
    const wanted = await connect();
    const other = await connect({ pending: true });
    const result = await tick({
      trigger: "queue",
      connectionIds: [wanted.id],
    }).run();
    expect(result).toMatchObject({ connections: 1, synced: 1 });
    expect(await reviewsFor(wanted.projectId)).toHaveLength(113);
    expect(await reviewsFor(other.projectId)).toHaveLength(0);
  });

  it("does nothing, loudly, when the connector is not configured", async () => {
    await connect();
    const { run, out } = tick({
      env: { ENVIRONMENT: "test", GOOGLE_CLIENT_ID: "TBD-provision-in-m3" },
    });
    const result = await run();
    expect(result.skippedReason).toBe("not_configured");
    expect(result.connections).toBe(0);
    expect(out.only("google.poll.skipped")).toMatchObject({
      level: "warn",
      reason: "not_configured",
      missing: ["CREDENTIALS_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    });
  });

  it("marks a connection needs_reauth when its ciphertext cannot be read (rotated key)", async () => {
    const connection = await connect();
    const otherKey = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    );
    const { run, out } = tick({
      env: {
        ENVIRONMENT: "test",
        CREDENTIALS_KEY: otherKey,
        GOOGLE_CLIENT_ID: "c",
        GOOGLE_CLIENT_SECRET: "s",
      },
    });
    const result = await run();
    expect(result.needsReauth).toBe(1);
    expect((await reload(connection.id)).status).toBe("needs_reauth");
    expect(out.only("google.needs_reauth")).toMatchObject({
      reason: "credentials_decrypt_failed",
    });
  });
});
