// The CSV import end to end against the real schema: upload → preview →
// mapping → run → progress → error report, with an in-memory bucket and a
// recording queue standing in for R2 and the ingest queue.
import { readFileSync } from "node:fs";

import { createLogger, recordingSink } from "@proofql/core";
import { schema } from "@proofql/db";
import { account, project, setupTestDb } from "@proofql/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  failingQueue,
  fakeBucket,
  fakeQueue,
  QUEUE_LIMIT_MESSAGE,
} from "../../test/fake-r2";
import {
  capInfo,
  createUpload,
  errorReportCsv,
  errorsKey,
  findProjectRun,
  getRunProgress,
  ImportError,
  type ImportPlan,
  isStarted,
  loadUploadPreview,
  MAX_UPLOAD_BYTES,
  mappingFromForm,
  planKey,
  proposeMapping,
  runImport,
  startImport,
  uploadOptionsSchema,
} from "./csv.server";

const t = setupTestDb();

function fixture(name: string): ArrayBuffer {
  const buffer = readFileSync(
    new URL(
      `../../../../packages/core/test/fixtures/csv/${name}`,
      import.meta.url,
    ),
  );
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

/** Steps 1–2 with the auto-detected mapping, returning what step 3 needs. */
async function uploadAndStart(
  projectId: string,
  name: string,
  options: Partial<{
    profile: string;
    source: string;
    environment: "live" | "test";
  }> = {},
) {
  const store = fakeBucket(512);
  const queue = fakeQueue();
  const { runId, artifactKey } = await createUpload(t.db, store, {
    projectId,
    environment: options.environment ?? "live",
    filename: name,
    contentType: name.endsWith(".json") ? "application/json" : "text/csv",
    bytes: fixture(name),
  });
  const preview = await loadUploadPreview(store, artifactKey);
  const { detected, defaults } = proposeMapping(
    preview,
    uploadOptionsSchema.parse({
      profile: options.profile,
      source: options.source,
    }),
  );
  const plan: ImportPlan = {
    mapping: detected.mapping,
    defaults,
    profile: detected.profile,
    headers: preview.headers,
    totalRows: preview.totalRows,
  };
  const run = await findProjectRun(t.db, projectId, runId);
  expect(isStarted(run)).toBe(false);
  await startImport(t.db, store, run, plan);
  return { store, queue, runId, artifactKey, preview, plan };
}

async function storedReviews(projectId: string) {
  return t.db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.projectId, projectId));
}

describe("createUpload", () => {
  it("stores the file under uploads/<project>/<run>.<ext> and opens a running csv run", async () => {
    const p = await project(t.db);
    const store = fakeBucket();
    const { runId, artifactKey, kind } = await createUpload(t.db, store, {
      projectId: p.id,
      environment: "test",
      filename: "Reviews.json",
      contentType: "application/octet-stream",
      bytes: fixture("google-takeout.json"),
    });
    expect(kind).toBe("json");
    expect(artifactKey).toBe(`uploads/${p.id}/${runId}.json`);
    expect(store.objects.has(artifactKey)).toBe(true);
    const run = await findProjectRun(t.db, p.id, runId);
    expect(run).toMatchObject({
      kind: "csv",
      status: "running",
      environment: "test",
      received: 0,
      artifactKey,
    });
  });

  it("rejects empty, oversized and unknown files before touching storage", async () => {
    const p = await project(t.db);
    const store = fakeBucket();
    const base = {
      projectId: p.id,
      environment: "live" as const,
      contentType: "text/csv",
    };
    await expect(
      createUpload(t.db, store, {
        ...base,
        filename: "a.csv",
        bytes: new ArrayBuffer(0),
      }),
    ).rejects.toThrow(/empty/);
    await expect(
      createUpload(t.db, store, {
        ...base,
        filename: "a.csv",
        bytes: new ArrayBuffer(MAX_UPLOAD_BYTES + 1),
      }),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      createUpload(t.db, store, {
        ...base,
        filename: "a.xlsx",
        contentType: "application/vnd.ms-excel",
        bytes: fixture("yelp.csv"),
      }),
    ).rejects.toBeInstanceOf(ImportError);
    // A disguised file: the browser's declared type says CSV, the name does
    // not. Refused server-side (#49), whatever the form's `accept=` said.
    await expect(
      createUpload(t.db, store, {
        ...base,
        filename: "payload.exe",
        contentType: "text/csv",
        bytes: fixture("yelp.csv"),
      }),
    ).rejects.toThrow(/\.csv or a \.json/);
    expect(store.objects.size).toBe(0);
  });

  it("never returns another project's run", async () => {
    const a = await project(t.db);
    const b = await project(t.db);
    const { runId } = await createUpload(t.db, fakeBucket(), {
      projectId: a.id,
      environment: "live",
      filename: "yelp.csv",
      contentType: "text/csv",
      bytes: fixture("yelp.csv"),
    });
    await expect(findProjectRun(t.db, b.id, runId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(findProjectRun(t.db, b.id, "nope")).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("loadUploadPreview + proposeMapping", () => {
  it("streams the first 20 rows and counts the rest", async () => {
    const p = await project(t.db);
    const store = fakeBucket(100);
    const { artifactKey } = await createUpload(t.db, store, {
      projectId: p.id,
      environment: "live",
      filename: "generic-50.csv",
      contentType: "text/csv",
      bytes: fixture("generic-50.csv"),
    });
    const preview = await loadUploadPreview(store, artifactKey);
    expect(preview.headers).toEqual([
      "Review ID",
      "Author",
      "Rating",
      "Date",
      "Review Text",
      "Location",
    ]);
    expect(preview.rows).toHaveLength(20);
    expect(preview.totalRows).toBe(50);

    const auto = proposeMapping(preview, uploadOptionsSchema.parse({}));
    expect(auto.detected.profile).toBe("generic");
    expect(auto.defaults.source).toBe("custom");
    const forced = proposeMapping(
      preview,
      uploadOptionsSchema.parse({ profile: "yelp", source: "google" }),
    );
    expect(forced.detected.profile).toBe("yelp");
    expect(forced.defaults.source).toBe("google");
  });

  it("explains cap headroom for step 2", () => {
    expect(capInfo("free", 4_980, 50)).toEqual({
      limit: 5_000,
      reviewCount: 4_980,
      room: 20,
      wouldReject: 30,
    });
    expect(capInfo("paid", 10, 50).wouldReject).toBe(0);
  });
});

describe("mappingFromForm", () => {
  it("reads field.* and metadata.* entries and insists on text and date", () => {
    const form = new FormData();
    form.set("field.text", "Review Text");
    form.set("field.occurred_at", "Date");
    form.set("field.rating", "");
    form.set("metadata.Location", "location");
    form.set("metadata.Ignored", "");
    expect(mappingFromForm(form)).toEqual({
      fields: { text: "Review Text", occurred_at: "Date" },
      metadata: { Location: "location" },
    });
    form.delete("field.text");
    expect(() => mappingFromForm(form)).toThrow(/review text/);
    form.set("field.text", "Review Text");
    form.set("metadata.Location", "Not A Key");
    expect(() => mappingFromForm(form)).toThrow(/metadata keys/);
  });
});

/** Upload and start a generated generic CSV of `rows` rows. */
async function uploadGenerated(projectId: string, rows: number) {
  const store = fakeBucket(700);
  const csv = [
    "id,author,stars,date,text",
    ...Array.from(
      { length: rows },
      (_, i) =>
        `gen-${i},Author ${i},${(i % 5) + 1},2026-01-${String((i % 28) + 1).padStart(2, "0")},"Row ${i}: a sentence long enough to be a review."`,
    ),
  ].join("\n");
  const { runId, artifactKey } = await createUpload(t.db, store, {
    projectId,
    environment: "live",
    filename: "generated.csv",
    contentType: "text/csv",
    bytes: new TextEncoder().encode(csv).buffer as ArrayBuffer,
  });
  const preview = await loadUploadPreview(store, artifactKey);
  const { detected, defaults } = proposeMapping(
    preview,
    uploadOptionsSchema.parse({}),
  );
  await startImport(t.db, store, await findProjectRun(t.db, projectId, runId), {
    mapping: detected.mapping,
    defaults,
    profile: detected.profile,
    headers: preview.headers,
    totalRows: preview.totalRows,
  });
  return { store, runId };
}

describe("runImport", () => {
  it("imports a 50-row generic CSV: 50 reviews, 50 messages, a succeeded run", async () => {
    const p = await project(t.db);
    const { store, queue, runId, artifactKey } = await uploadAndStart(
      p.id,
      "generic-50.csv",
    );
    expect(store.textOf(planKey(artifactKey))).toContain('"Review Text"');

    const outcome = await runImport({ db: t.db, store, queue }, runId);

    expect(outcome.state).toBe("finished");
    expect(outcome.run).toMatchObject({
      status: "succeeded",
      received: 50,
      created: 50,
      updated: 0,
      skipped: 0,
      failed: 0,
      error: null,
    });
    expect(outcome.run.finishedAt).not.toBeNull();
    const reviews = await storedReviews(p.id);
    expect(reviews).toHaveLength(50);
    expect(
      reviews.every((r) => r.environment === "live" && r.source === "custom"),
    ).toBe(true);
    expect(reviews.find((r) => r.externalId === "r-1000")).toMatchObject({
      rating: 5,
      authorName: "Marcus T.",
      occurredAt: new Date("2026-01-05T00:00:00Z"),
      sentiment: "positive",
      indexedAt: null,
    });
    // "★★★★★" and "5 stars" and "4/5" all parsed; dates in six formats.
    expect(reviews.find((r) => r.externalId === "r-1004")?.rating).toBe(5);
    expect(reviews.find((r) => r.externalId === "r-1006")?.occurredAt).toEqual(
      new Date("2025-03-01T00:00:00Z"),
    );
    expect(queue.messages).toHaveLength(50);
    expect(new Set(queue.messages.map((m) => m.reviewId)).size).toBe(50);
    expect(queue.messages[0]).toMatchObject({
      type: "review.index",
      projectId: p.id,
      environment: "live",
    });
    const [after] = await t.db
      .select({ reviewCount: schema.projects.reviewCount })
      .from(schema.projects)
      .where(eq(schema.projects.id, p.id));
    expect(after?.reviewCount).toBe(50);
    expect(store.objects.has(errorsKey(artifactKey))).toBe(false);
    expect(await errorReportCsv(store, outcome.run)).toBeNull();

    const progress = await getRunProgress(t.db, outcome.run);
    expect(progress).toMatchObject({ processed: 50, indexed: 0, indexing: 50 });
  });

  it("re-importing the same file creates nothing and updates every row", async () => {
    const p = await project(t.db);
    const first = await uploadAndStart(p.id, "generic-50.csv");
    await runImport(
      { db: t.db, store: first.store, queue: first.queue },
      first.runId,
    );

    const second = await uploadAndStart(p.id, "generic-50.csv");
    const outcome = await runImport(
      { db: t.db, store: second.store, queue: second.queue },
      second.runId,
    );

    expect(outcome.run).toMatchObject({
      status: "succeeded",
      created: 0,
      updated: 50,
      skipped: 0,
      failed: 0,
    });
    expect(await storedReviews(p.id)).toHaveLength(50);
    // Unchanged text ⇒ nothing to re-index.
    expect(second.queue.messages).toHaveLength(0);
  });

  it("a file with 3 bad rows: 47 created, 3 failed with reasons in the report", async () => {
    const p = await project(t.db);
    const { store, queue, runId } = await uploadAndStart(
      p.id,
      "generic-50-3-bad.csv",
    );

    const outcome = await runImport({ db: t.db, store, queue }, runId);

    expect(outcome.run).toMatchObject({
      status: "succeeded",
      received: 50,
      created: 47,
      failed: 3,
    });
    expect(await storedReviews(p.id)).toHaveLength(47);
    expect(queue.messages).toHaveLength(47);
    const report = await errorReportCsv(store, outcome.run);
    expect(report).not.toBeNull();
    const lines = (report as string).split("\r\n");
    expect(lines[0]).toBe("row,reason");
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual([
      "5",
      "17",
      "33",
    ]);
    expect(lines[1]).toMatch(/is empty/);
    expect(lines[2]).toMatch(/excellent.*not a rating/);
    expect(lines[3]).toMatch(/sometime last spring.*not a date/);
  });

  it("near the plan cap: inserts what fits, counts the rest as failed with the limit reason", async () => {
    const a = await account(t.db, { plan: "free" });
    const p = await project(t.db, { accountId: a.id, reviewCount: 4_980 });
    const { store, queue, runId } = await uploadAndStart(
      p.id,
      "generic-50.csv",
    );

    const outcome = await runImport({ db: t.db, store, queue }, runId);

    expect(outcome.run).toMatchObject({
      status: "succeeded",
      created: 20,
      updated: 0,
      failed: 30,
    });
    expect(await storedReviews(p.id)).toHaveLength(20);
    expect(queue.messages).toHaveLength(20);
    const report = (await errorReportCsv(store, outcome.run)) as string;
    const lines = report.split("\r\n");
    expect(lines).toHaveLength(31);
    expect(lines[1]).toMatch(/^21,"Project review limit reached \(5,000/);
    expect(lines[30]?.startsWith("50,")).toBe(true);
  });

  it("imports Google Takeout JSON with the profile's source and ids", async () => {
    const p = await project(t.db);
    const { store, queue, runId } = await uploadAndStart(
      p.id,
      "google-takeout.json",
      {
        environment: "test",
      },
    );
    const outcome = await runImport({ db: t.db, store, queue }, runId);
    expect(outcome.run).toMatchObject({
      status: "succeeded",
      created: 2,
      failed: 1,
    });
    const reviews = await storedReviews(p.id);
    expect(
      reviews
        .map((r) => [r.environment, r.source, r.externalId, r.rating])
        .sort(),
    ).toEqual([
      ["test", "google", "accounts/1/locations/2/reviews/AbC123", 5],
      ["test", "google", "accounts/1/locations/2/reviews/DeF456", 4],
    ]);
    expect(reviews[0]?.authorAvatarUrl ?? reviews[1]?.authorAvatarUrl).toBe(
      "https://lh3.googleusercontent.com/a/photo1",
    );
  });

  it("Queues daily limit: imports every row, stops sending after the first refusal, logs quota.exhausted (#159)", async () => {
    const p = await project(t.db);
    const { store, runId } = await uploadGenerated(p.id, 250);
    const queue = failingQueue();
    const out = recordingSink();
    const log = createLogger({
      service: "dashboard",
      environment: "test",
      sink: out.sink,
    });

    const outcome = await runImport({ db: t.db, store, queue, log }, runId);

    expect(outcome.state).toBe("finished");
    expect(outcome.run).toMatchObject({
      status: "succeeded",
      received: 250,
      created: 250,
      failed: 0,
      error: null,
    });
    const reviews = await storedReviews(p.id);
    expect(reviews).toHaveLength(250);
    expect(reviews.every((r) => r.indexedAt === null)).toBe(true);
    // One refused send; the other two batches did not try.
    expect(queue.attempts).toBe(1);
    expect(out.only("quota.exhausted")).toMatchObject({
      level: "error",
      resource: "queues",
      site: "dashboard.csv_import",
      messages: 100,
      ingest_run_id: runId,
      error: { message: QUEUE_LIMIT_MESSAGE },
    });
    expect(out.only("import.finished")).toMatchObject({
      created: 250,
      indexing_deferred: 250,
    });
    expect(out.find("import.failed")).toHaveLength(0);
    // The run page's progress shows them as still indexing.
    expect(await getRunProgress(t.db, outcome.run)).toMatchObject({
      processed: 250,
      indexed: 0,
      indexing: 250,
    });
  });

  it("any other queue failure: the import still succeeds, every batch is tried, ingest.enqueue_deferred per batch", async () => {
    const p = await project(t.db);
    const { store, runId } = await uploadGenerated(p.id, 250);
    const queue = failingQueue("Queue sendBatch failed: Unknown error");
    const out = recordingSink();
    const log = createLogger({
      service: "dashboard",
      environment: "test",
      sink: out.sink,
    });

    const outcome = await runImport({ db: t.db, store, queue, log }, runId);

    expect(outcome.run).toMatchObject({ status: "succeeded", created: 250 });
    expect(queue.attempts).toBe(3);
    expect(out.find("ingest.enqueue_deferred")).toHaveLength(3);
    expect(out.find("quota.exhausted")).toHaveLength(0);
  });

  it("pauses at the time budget and resumes from the counts without duplicating", async () => {
    const p = await project(t.db);
    const store = fakeBucket(700);
    const queue = fakeQueue();
    const csv = [
      "id,author,stars,date,text",
      ...Array.from(
        { length: 250 },
        (_, i) =>
          `big-${i},Author ${i},${(i % 5) + 1},2026-01-${String((i % 28) + 1).padStart(2, "0")},"Row ${i}: a sentence long enough to be a review."`,
      ),
    ].join("\n");
    const { runId, artifactKey } = await createUpload(t.db, store, {
      projectId: p.id,
      environment: "live",
      filename: "big.csv",
      contentType: "text/csv",
      bytes: new TextEncoder().encode(csv).buffer as ArrayBuffer,
    });
    const preview = await loadUploadPreview(store, artifactKey);
    const { detected, defaults } = proposeMapping(
      preview,
      uploadOptionsSchema.parse({}),
    );
    await startImport(t.db, store, await findProjectRun(t.db, p.id, runId), {
      mapping: detected.mapping,
      defaults,
      profile: detected.profile,
      headers: preview.headers,
      totalRows: preview.totalRows,
    });

    // A negative budget: every batch boundary is "over time".
    const paused = await runImport(
      { db: t.db, store, queue, budgetMs: -1 },
      runId,
    );
    expect(paused.state).toBe("paused");
    expect(paused.run).toMatchObject({
      status: "running",
      received: 250,
      created: 100,
    });
    expect(await storedReviews(p.id)).toHaveLength(100);

    const resumed = await runImport(
      { db: t.db, store, queue, budgetMs: -1 },
      runId,
    );
    expect(resumed.state).toBe("paused");
    expect(resumed.run.created).toBe(200);

    const finished = await runImport({ db: t.db, store, queue }, runId);
    expect(finished.state).toBe("finished");
    expect(finished.run).toMatchObject({
      status: "succeeded",
      created: 250,
      updated: 0,
    });
    expect(await storedReviews(p.id)).toHaveLength(250);
    expect(queue.messages).toHaveLength(250);
    expect(new Set(queue.messages.map((m) => m.reviewId)).size).toBe(250);

    // A further call on a finished run is a no-op.
    const again = await runImport({ db: t.db, store, queue }, runId);
    expect(again.state).toBe("finished");
    expect(queue.messages).toHaveLength(250);
  });

  it("marks a run failed when the mapping was never confirmed", async () => {
    const p = await project(t.db);
    const store = fakeBucket();
    const { runId } = await createUpload(t.db, store, {
      projectId: p.id,
      environment: "live",
      filename: "yelp.csv",
      contentType: "text/csv",
      bytes: fixture("yelp.csv"),
    });
    const outcome = await runImport(
      { db: t.db, store, queue: fakeQueue() },
      runId,
    );
    expect(outcome.state).toBe("failed");
    expect(outcome.run).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/never started/),
    });
  });
});
