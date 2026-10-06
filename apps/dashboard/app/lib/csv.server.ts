/**
 * The CSV / JSON review import (issue #38): upload → preview → run → report.
 *
 * Plain functions over injected `Db`, upload store and queue so the
 * integration tests drive the whole flow against the real schema with an
 * in-memory bucket and a recording queue (`csv.server.integration.test.ts`),
 * and the route modules stay thin.
 *
 * Storage layout, all under the dashboard's `UPLOADS` R2 bucket:
 *
 *   uploads/<projectId>/<runId>.<csv|json>   the file as uploaded
 *   uploads/<projectId>/<runId>.plan.json    the confirmed mapping (step 2)
 *   uploads/<projectId>/<runId>.errors.json  per-row failures (step 3)
 *
 * Every object under `uploads/` expires `UPLOAD_RETENTION_DAYS` (7) after
 * it was written (R2 lifecycle rule, infra/provisioning.md; #169), and a
 * deleted project's prefix is removed at once. A run whose report has gone
 * shows "expired" (`errorReport`), never a 500.
 *
 * The `ingest_runs` row (kind `csv`) is created at upload with status
 * `running` and `received = 0`; starting the run sets `received` to the
 * file's row count, so "has the mapping been confirmed" is readable from
 * the row alone (`received > 0 || status !== "running"`). Counts are
 * bumped per batch with `SET x = x + n`, and `created + updated + skipped
 * + failed` doubles as the resume cursor: `runImport` skips that many rows
 * when invoked again on a run that was cut off (the action hands the run
 * to `ctx.waitUntil`, which Workers caps at ~30 s past the response).
 *
 * Reviews go through `upsertReviews` from @proofql/db — the same function
 * `POST /v1/reviews` calls — with the `truncate` cap policy, in batches of
 * `IMPORT_BATCH_SIZE`, and one `IngestMessage` per inserted or re-indexed
 * review is sent after each batch commits.
 *
 * A refused send never fails the import (#159): the batch is committed with
 * `indexed_at` null and the pipeline's five-minute sweep indexes it later,
 * which the run page's indexing progress already shows. `enqueueOrDefer`
 * (@proofql/core) logs the failure; after the Workers Free plan's daily
 * Queues limit (`quota.exhausted`) the run stops trying to send for the
 * rest of the call, since every send would fail until 00:00 UTC, and
 * counts the messages it skipped as `indexing_deferred`.
 */
import {
  CSV_PROFILE_IDS,
  type CsvDefaults,
  type CsvMapping,
  type CsvRowError,
  type CsvTable,
  csvDefaultsSchema,
  csvMappingSchema,
  csvProfile,
  type DetectedMapping,
  detectMapping,
  enqueueOrDefer,
  type IngestMessage,
  isPastRetention,
  JsonShapeError,
  type Logger,
  normalizeRow,
  parseCsvStream,
  parseJsonTable,
  planFor,
  REVIEW_SOURCES,
  type ReviewInput,
  UPLOAD_RETENTION_DAYS,
  validateRows,
} from "@proofql/core";
import { type Db, schema, upsertReviews } from "@proofql/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";

import { formatBytes } from "./import-labels";
import { indexingTally } from "./indexing.server";

export { formatBytes };

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const PREVIEW_ROWS = 20;
export const IMPORT_BATCH_SIZE = 100;
/** How long one `runImport` call keeps going before yielding for a resume. */
export const DEFAULT_RUN_BUDGET_MS = 25_000;

export const UPLOAD_KINDS = ["csv", "json"] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

export type Environment = (typeof schema.ENVIRONMENTS)[number];
export type IngestRun = typeof schema.ingestRuns.$inferSelect;

/** The slice of `R2Bucket` the import uses; `test/fake-r2.ts` implements it in memory. */
export interface UploadStore {
  put(key: string, value: ArrayBuffer | string): Promise<unknown>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  text(): Promise<string>;
}

/** The slice of `Queue<IngestMessage>` the import uses. */
export interface IndexQueue {
  sendBatch(messages: Iterable<{ body: IngestMessage }>): Promise<void>;
}

export class ImportError extends Error {
  override readonly name = "ImportError";
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 = 400,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Keys and kinds
// ---------------------------------------------------------------------------

export function uploadKey(
  projectId: string,
  runId: string,
  kind: UploadKind,
): string {
  return `uploads/${projectId}/${runId}.${kind}`;
}

export function planKey(artifactKey: string): string {
  return `${stripExtension(artifactKey)}.plan.json`;
}

export function errorsKey(artifactKey: string): string {
  return `${stripExtension(artifactKey)}.errors.json`;
}

function stripExtension(key: string): string {
  return key.replace(/\.(csv|json)$/, "");
}

export function kindOfArtifact(artifactKey: string): UploadKind {
  return artifactKey.endsWith(".json") ? "json" : "csv";
}

/**
 * `.csv` / `.json` by extension first; the declared type decides only for a
 * file with no extension at all (#49). The browser's `Content-Type` is
 * client-controlled, so a `payload.exe` sent as `text/csv` must not pass an
 * extension allowlist — the extension is the allowlist, and a file that
 * declares another one is refused whatever the header says. The server
 * check is the real one: the form's `accept=` is a convenience.
 */
export function uploadKind(
  filename: string,
  contentType: string,
): UploadKind | null {
  const lower = filename.toLowerCase();
  if (
    lower.endsWith(".csv") ||
    lower.endsWith(".tsv") ||
    lower.endsWith(".txt")
  )
    return "csv";
  if (lower.endsWith(".json")) return "json";
  if (hasExtension(lower)) return null;
  if (/json/.test(contentType)) return "json";
  if (/csv|text\/plain|tab-separated/.test(contentType)) return "csv";
  return null;
}

/** `reviews.exe` yes; `reviews`, `.hidden`, `reviews.` no. */
function hasExtension(filename: string): boolean {
  const base = filename.slice(
    Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\")) + 1,
  );
  const dot = base.lastIndexOf(".");
  return dot > 0 && dot < base.length - 1;
}

// ---------------------------------------------------------------------------
// Step 1 — upload
// ---------------------------------------------------------------------------

export interface CreateUploadInput {
  projectId: string;
  environment: Environment;
  filename: string;
  contentType: string;
  bytes: ArrayBuffer;
}

/** Validate, store the file, open the `ingest_runs` row. */
export async function createUpload(
  db: Db,
  store: UploadStore,
  input: CreateUploadInput,
): Promise<{ runId: string; artifactKey: string; kind: UploadKind }> {
  if (input.bytes.byteLength === 0) {
    throw new ImportError("The file is empty.");
  }
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new ImportError(
      `The file is ${formatBytes(input.bytes.byteLength)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}. Split it and import the parts one at a time.`,
      413,
    );
  }
  const kind = uploadKind(input.filename, input.contentType);
  if (kind === null) {
    throw new ImportError(
      "Upload a .csv or a .json file (Google Takeout's Reviews.json works as is).",
    );
  }
  const runId = crypto.randomUUID();
  const artifactKey = uploadKey(input.projectId, runId, kind);
  await store.put(artifactKey, input.bytes);
  await db.insert(schema.ingestRuns).values({
    id: runId,
    projectId: input.projectId,
    environment: input.environment,
    kind: "csv",
    status: "running",
    artifactKey,
  });
  return { runId, artifactKey, kind };
}

// ---------------------------------------------------------------------------
// Step 2 — preview and mapping
// ---------------------------------------------------------------------------

export interface UploadPreview extends CsvTable {
  /** Data rows in the whole file (the preview holds the first `PREVIEW_ROWS`). */
  totalRows: number;
}

/**
 * The header, the first `limit` rows, and the total row count. CSVs stream
 * (a 10 MB file is parsed once, nothing beyond the preview is kept); JSON
 * is parsed whole because it has to be.
 */
export async function loadUploadPreview(
  store: UploadStore,
  artifactKey: string,
  limit = PREVIEW_ROWS,
): Promise<UploadPreview> {
  const object = await store.get(artifactKey);
  if (object === null) {
    throw new ImportError("The uploaded file is no longer available.", 404);
  }
  if (kindOfArtifact(artifactKey) === "json") {
    const table = parseJsonTableOrThrow(await object.text());
    return {
      headers: table.headers,
      rows: table.rows.slice(0, limit),
      totalRows: table.rows.length,
    };
  }
  let headers: string[] = [];
  const rows: string[][] = [];
  let totalRows = 0;
  for await (const event of parseCsvStream(object.body)) {
    if (event.kind === "header") headers = event.headers;
    else {
      totalRows += 1;
      if (rows.length < limit) rows.push(event.row);
    }
  }
  if (headers.length === 0) {
    throw new ImportError("The file has no header row.");
  }
  return { headers, rows, totalRows };
}

function parseJsonTableOrThrow(text: string): CsvTable {
  try {
    return parseJsonTable(text);
  } catch (error) {
    if (error instanceof JsonShapeError) throw new ImportError(error.message);
    throw error;
  }
}

/** The step-1 choices, carried to step 2 in the redirect's query string. */
export const uploadOptionsSchema = z.object({
  profile: z.enum([...CSV_PROFILE_IDS, "auto"]).default("auto"),
  source: z.enum([...REVIEW_SOURCES, "auto"]).default("auto"),
});

export type UploadOptions = z.output<typeof uploadOptionsSchema>;

export interface MappingProposal {
  detected: DetectedMapping;
  defaults: CsvDefaults;
}

/** Auto-detect (or apply the chosen profile) and settle the default source. */
export function proposeMapping(
  preview: UploadPreview,
  options: UploadOptions,
): MappingProposal {
  const detected = detectMapping(
    preview.headers,
    preview.rows,
    options.profile === "auto" ? {} : { profile: options.profile },
  );
  const source =
    options.source === "auto"
      ? csvProfile(detected.profile).source
      : options.source;
  return { detected, defaults: { source } };
}

export interface CapInfo {
  limit: number;
  reviewCount: number;
  /** Inserts the plan still allows. */
  room: number;
  /** Upper bound on rows this file would lose to the cap (updates never count). */
  wouldReject: number;
}

export function capInfo(
  plan: string,
  reviewCount: number,
  totalRows: number,
): CapInfo {
  const limit = planFor(plan).reviewsPerProject;
  const room = Math.max(0, limit - reviewCount);
  return {
    limit,
    reviewCount,
    room,
    wouldReject: Math.max(0, totalRows - room),
  };
}

/** The confirmed mapping, stored beside the upload when the run starts. */
export const importPlanSchema = z.object({
  mapping: csvMappingSchema,
  defaults: csvDefaultsSchema,
  profile: z.string(),
  headers: z.array(z.string()),
  totalRows: z.number().int().nonnegative(),
});

export type ImportPlan = z.output<typeof importPlanSchema>;

/**
 * Parse the step-2 form: `field.<target>=<column>` (empty = ignore) and
 * `metadata.<column>=<key>`. Throws `ImportError` with a readable message
 * rather than a zod tree — the form is ours.
 */
export function mappingFromForm(form: FormData): CsvMapping {
  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== "string") continue;
    if (name.startsWith("field.") && value !== "") {
      fields[name.slice("field.".length)] = value;
    } else if (name.startsWith("metadata.") && value !== "") {
      metadata[name.slice("metadata.".length)] = value;
    }
  }
  const parsed = csvMappingSchema.safeParse({ fields, metadata });
  if (!parsed.success) {
    throw new ImportError(
      "The mapping is not valid: metadata keys may only use lowercase letters, digits and underscores.",
    );
  }
  if (parsed.data.fields.text === undefined) {
    throw new ImportError(
      "Map a column to the review text before running the import.",
    );
  }
  if (parsed.data.fields.occurred_at === undefined) {
    throw new ImportError(
      "Map a column to the date before running the import.",
    );
  }
  return parsed.data;
}

/** Store the plan and mark the run as started (`received = totalRows`). */
export async function startImport(
  db: Db,
  store: UploadStore,
  run: IngestRun,
  plan: ImportPlan,
): Promise<void> {
  if (run.artifactKey === null) {
    throw new ImportError("This run has no uploaded file.", 409);
  }
  if (isStarted(run)) {
    throw new ImportError("This import has already started.", 409);
  }
  await store.put(planKey(run.artifactKey), JSON.stringify(plan));
  await db
    .update(schema.ingestRuns)
    .set({ received: plan.totalRows })
    .where(eq(schema.ingestRuns.id, run.id));
}

export function isStarted(run: IngestRun): boolean {
  return run.status !== "running" || run.received > 0;
}

// ---------------------------------------------------------------------------
// Step 3 — run
// ---------------------------------------------------------------------------

export interface RowFailure {
  /** 1-based data row, header excluded. */
  rowNumber: number;
  reason: string;
}

export interface RunImportDeps {
  db: Db;
  store: UploadStore;
  queue: IndexQueue;
  log?: Logger;
  /** Stop (leaving the run resumable) once this much wall time has passed. */
  budgetMs?: number;
  now?: () => number;
}

export type RunOutcome =
  | { state: "finished"; run: IngestRun }
  | { state: "paused"; run: IngestRun; processed: number }
  | { state: "failed"; run: IngestRun; error: string };

/**
 * Process the file from where the counts say we left off. Safe to call
 * again on a run that is still `running`; a no-op for a finished one.
 */
export async function runImport(
  deps: RunImportDeps,
  runId: string,
): Promise<RunOutcome> {
  const { db, store, queue } = deps;
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? DEFAULT_RUN_BUDGET_MS;
  const startedAt = now();
  const log = deps.log?.child({ ingest_run_id: runId });

  let run = await findRun(db, runId);
  if (run.status !== "running") return { state: "finished", run };
  if (run.artifactKey === null) {
    return fail(db, run, "This run has no uploaded file.", log);
  }
  const planObject = await store.get(planKey(run.artifactKey));
  if (planObject === null) {
    return fail(
      db,
      run,
      "The import was never started: no mapping was confirmed.",
      log,
    );
  }
  const plan = importPlanSchema.parse(JSON.parse(await planObject.text()));
  const file = await store.get(run.artifactKey);
  if (file === null) {
    return fail(db, run, "The uploaded file is no longer available.", log);
  }

  const failures = await loadFailures(store, run.artifactKey);
  const alreadyProcessed = processedRows(run);
  log?.log("import.started", {
    project_id: run.projectId,
    environment: run.environment,
    total_rows: plan.totalRows,
    resume_from: alreadyProcessed,
  });

  const ctx: BatchContext = {
    db,
    queue,
    store,
    run,
    plan,
    failures,
    log,
    queueExhausted: false,
    deferred: 0,
  };
  let batch: { rowNumber: number; review: ReviewInput }[] = [];
  let batchFailures: RowFailure[] = [];
  let processed = alreadyProcessed;
  let paused = false;

  const flush = async () => {
    if (batch.length === 0 && batchFailures.length === 0) return;
    await commitBatch(ctx, batch, batchFailures);
    processed += batch.length + batchFailures.length;
    batch = [];
    batchFailures = [];
  };

  try {
    for await (const { row, rowNumber } of rowsOf(
      file,
      plan,
      run.artifactKey,
    )) {
      if (rowNumber <= alreadyProcessed) continue;
      const result = normalizeRow(
        row,
        plan.headers,
        plan.mapping,
        plan.defaults,
      );
      if (result.ok) batch.push({ rowNumber, review: result.review });
      else
        batchFailures.push({
          rowNumber,
          reason: describeErrors(result.errors),
        });
      if (batch.length + batchFailures.length >= IMPORT_BATCH_SIZE) {
        await flush();
        if (now() - startedAt > budgetMs) {
          paused = true;
          break;
        }
      }
    }
    if (!paused) await flush();
  } catch (error) {
    await flush().catch(() => {});
    const message = error instanceof Error ? error.message : "unhandled error";
    return fail(
      db,
      run,
      `Import stopped at row ${processed + 1}: ${message}`,
      log,
    );
  }

  if (paused) {
    run = await findRun(db, runId);
    log?.log("import.paused", {
      processed,
      total_rows: plan.totalRows,
      indexing_deferred: ctx.deferred,
    });
    return { state: "paused", run, processed };
  }

  if (plan.totalRows === 0) {
    return fail(db, run, "The file has a header but no data rows.", log);
  }

  const [finished] = await db
    .update(schema.ingestRuns)
    .set({ status: "succeeded", finishedAt: new Date() })
    .where(eq(schema.ingestRuns.id, runId))
    .returning();
  if (finished === undefined) throw new Error(`ingest run ${runId} vanished`);
  log?.log("import.finished", {
    created: finished.created,
    updated: finished.updated,
    skipped: finished.skipped,
    failed: finished.failed,
    indexing_deferred: ctx.deferred,
    duration_ms: now() - startedAt,
  });
  return { state: "finished", run: finished };
}

interface BatchContext {
  db: Db;
  queue: IndexQueue;
  store: UploadStore;
  run: IngestRun;
  plan: ImportPlan;
  failures: RowFailure[];
  log: Logger | undefined;
  /** The Queues daily limit was hit during this call: stop trying to send. */
  queueExhausted: boolean;
  /** Index messages not sent during this call; the sweep covers them. */
  deferred: number;
}

/** One batch: upsert, bump the counts, enqueue, persist the failures. */
async function commitBatch(
  ctx: BatchContext,
  batch: { rowNumber: number; review: ReviewInput }[],
  batchFailures: RowFailure[],
): Promise<void> {
  const { db, run } = ctx;
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const failures = [...batchFailures];

  if (batch.length > 0) {
    const result = await upsertReviews(db, {
      projectId: run.projectId,
      environment: run.environment,
      reviews: batch.map((b) => b.review),
      onLimit: "truncate",
    });
    created = result.created;
    updated = result.updated;
    skipped = result.skipped;
    if (result.rejected.length > 0) {
      const rejected = new Set(
        result.rejected.map((r) => `${r.source}\0${r.external_id}`),
      );
      // The last occurrence of a key is the one that was (not) written.
      const seen = new Set<string>();
      for (let i = batch.length - 1; i >= 0; i--) {
        const item = batch[i] as { rowNumber: number; review: ReviewInput };
        const key = `${item.review.source}\0${item.review.external_id}`;
        if (rejected.has(key) && !seen.has(key)) {
          seen.add(key);
          failures.push({
            rowNumber: item.rowNumber,
            reason: `Project review limit reached (${result.limit.toLocaleString("en-US")} on this plan); the review was not imported.`,
          });
        }
      }
      failures.sort((a, b) => a.rowNumber - b.rowNumber);
    }
    if (result.toEnqueue.length > 0) {
      if (ctx.queueExhausted) {
        ctx.deferred += result.toEnqueue.length;
      } else {
        const outcome = await enqueueOrDefer(ctx.queue, result.toEnqueue, {
          log: ctx.log,
          site: "dashboard.csv_import",
        });
        if (!outcome.sent) {
          ctx.deferred += result.toEnqueue.length;
          if (outcome.quota) ctx.queueExhausted = true;
        }
      }
    }
  }

  await db
    .update(schema.ingestRuns)
    .set({
      created: sql`${schema.ingestRuns.created} + ${created}`,
      updated: sql`${schema.ingestRuns.updated} + ${updated}`,
      skipped: sql`${schema.ingestRuns.skipped} + ${skipped}`,
      failed: sql`${schema.ingestRuns.failed} + ${failures.length}`,
    })
    .where(eq(schema.ingestRuns.id, run.id));

  if (failures.length > 0) {
    ctx.failures.push(...failures);
    await ctx.store.put(
      errorsKey(run.artifactKey as string),
      JSON.stringify(ctx.failures),
    );
  }
  ctx.log?.log("import.batch", {
    rows: batch.length + batchFailures.length,
    created,
    updated,
    skipped,
    failed: failures.length,
  });
}

async function* rowsOf(
  file: StoredObject,
  plan: ImportPlan,
  artifactKey: string,
): AsyncGenerator<{ row: string[]; rowNumber: number }> {
  if (kindOfArtifact(artifactKey) === "json") {
    const table = parseJsonTableOrThrow(await file.text());
    // Headers may differ in order from the plan's if the file changed; the
    // plan's headers are what the mapping names, so realign by name.
    const index = plan.headers.map((h: string) => table.headers.indexOf(h));
    let rowNumber = 0;
    for (const row of table.rows) {
      rowNumber += 1;
      yield {
        row: index.map((i: number) => (i === -1 ? "" : (row[i] ?? ""))),
        rowNumber,
      };
    }
    return;
  }
  for await (const event of parseCsvStream(file.body)) {
    if (event.kind === "row")
      yield { row: event.row, rowNumber: event.rowNumber };
  }
}

function describeErrors(errors: CsvRowError[]): string {
  return errors.map((e) => e.message).join(" ");
}

export function processedRows(run: IngestRun): number {
  return run.created + run.updated + run.skipped + run.failed;
}

async function fail(
  db: Db,
  run: IngestRun,
  message: string,
  log: Logger | undefined,
): Promise<RunOutcome> {
  const [failed] = await db
    .update(schema.ingestRuns)
    .set({
      status: "failed",
      error: message.slice(0, 1000),
      finishedAt: new Date(),
    })
    .where(eq(schema.ingestRuns.id, run.id))
    .returning();
  log?.log("import.failed", { level: "warn", error_message: message });
  return { state: "failed", run: failed ?? run, error: message };
}

async function loadFailures(
  store: UploadStore,
  artifactKey: string,
): Promise<RowFailure[]> {
  const object = await store.get(errorsKey(artifactKey));
  if (object === null) return [];
  return parseFailures(await object.text());
}

function parseFailures(text: string): RowFailure[] {
  return z
    .array(z.object({ rowNumber: z.number(), reason: z.string() }))
    .parse(JSON.parse(text));
}

// ---------------------------------------------------------------------------
// Step 4 — progress and the error report
// ---------------------------------------------------------------------------

export async function findRun(db: Db, runId: string): Promise<IngestRun> {
  const run = await db.query.ingestRuns.findFirst({
    where: eq(schema.ingestRuns.id, runId),
  });
  if (run === undefined) throw new ImportError("Import not found.", 404);
  return run;
}

/** The run kinds the import pages show: uploads, and Places bootstraps (#47). */
export const DASHBOARD_RUN_KINDS: readonly IngestRun["kind"][] = [
  "csv",
  "places",
];

/** A project's run of a dashboard kind, or 404 — never another tenant's. */
export async function findProjectRun(
  db: Db,
  projectId: string,
  runId: string,
  kinds: readonly IngestRun["kind"][] = DASHBOARD_RUN_KINDS,
): Promise<IngestRun> {
  if (!z.uuid().safeParse(runId).success) {
    throw new ImportError("Import not found.", 404);
  }
  const run = await findRun(db, runId);
  if (run.projectId !== projectId || !kinds.includes(run.kind)) {
    throw new ImportError("Import not found.", 404);
  }
  return run;
}

export interface RunProgress {
  run: IngestRun;
  processed: number;
  /** Reviews this run wrote that the pipeline has indexed / not yet. */
  indexed: number;
  indexing: number;
  /** Some of them have waited past INDEXING_DEFERRED_AFTER_MS: indexing is delayed (#162). */
  deferred: boolean;
}

/**
 * Counts for the progress view. "This run's reviews" is approximated by
 * `updated_at >= started_at` within the project and environment — a run
 * does not keep its review ids, and a concurrent push-API batch in the
 * same window merely pads both numbers equally.
 */
export async function getRunProgress(
  db: Db,
  run: IngestRun,
): Promise<RunProgress> {
  const scope = and(
    eq(schema.reviews.projectId, run.projectId),
    eq(schema.reviews.environment, run.environment),
    gte(schema.reviews.updatedAt, run.startedAt),
  );
  return {
    run,
    processed: processedRows(run),
    ...(await indexingTally(db, scope)),
  };
}

/**
 * The run's error report (#38, #169):
 *
 *   - `none`    the run had no per-row failures (or no file);
 *   - `expired` it had failures, but the `.errors.json` object is gone —
 *               the bucket's lifecycle rule deletes every upload object
 *               `UPLOAD_RETENTION_DAYS` (7) after it was written, and the
 *               project-delete path removes them at once;
 *   - `ready`   the failures as a CSV (`row,reason`).
 */
export type ErrorReport =
  | { state: "none" }
  | { state: "expired" }
  | { state: "ready"; csv: string };

export async function errorReport(
  store: UploadStore,
  run: IngestRun,
): Promise<ErrorReport> {
  if (run.artifactKey === null) return { state: "none" };
  const object = await store.get(errorsKey(run.artifactKey));
  if (object === null) {
    return run.failed > 0 ? { state: "expired" } : { state: "none" };
  }
  const failures = parseFailures(await object.text());
  if (failures.length === 0) return { state: "none" };
  const quote = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return {
    state: "ready",
    csv: [
      "row,reason",
      ...failures.map((f) => `${f.rowNumber},${quote(f.reason)}`),
    ].join("\r\n"),
  };
}

/** The per-row failures as a CSV (`row,reason`), or null when there is none to serve. */
export async function errorReportCsv(
  store: UploadStore,
  run: IngestRun,
): Promise<string | null> {
  const report = await errorReport(store, run);
  return report.state === "ready" ? report.csv : null;
}

/** Whether a finished run's upload objects are past the lifecycle rule's age. */
export function errorReportExpired(run: IngestRun, now = new Date()): boolean {
  return (
    run.finishedAt !== null &&
    isPastRetention(run.finishedAt, now, UPLOAD_RETENTION_DAYS)
  );
}

/** Validation summary of the preview rows under a mapping (step 2's live numbers, server-side). */
export function previewValidation(
  preview: UploadPreview,
  mapping: CsvMapping,
  defaults: CsvDefaults,
) {
  return validateRows(preview.rows, preview.headers, mapping, defaults);
}
