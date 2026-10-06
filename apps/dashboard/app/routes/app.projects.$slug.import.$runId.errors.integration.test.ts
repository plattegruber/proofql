// The error-report download (#38) once the R2 lifecycle rule has deleted
// the report (#169): 410 with a plain message, never a 500; 200 with the
// CSV while it exists; 404 when the run had no failures. Runs in the local
// auth stub against the harness database with an in-memory bucket.

import { schema } from "@proofql/db";
import { DEMO_ACCOUNT_CLERK_ORG_ID } from "@proofql/db/seed";
import { account, project, setupTestDb } from "@proofql/db/test";
import { beforeAll, describe, expect, it } from "vitest";

import { createLoadContext } from "~/lib/context";
import { errorsKey } from "~/lib/csv.server";
import { fakeBucket } from "../../test/fake-r2";
import { loader } from "./app.projects.$slug.import.$runId.errors";

const t = setupTestDb();

let demo: Awaited<ReturnType<typeof account>>;
beforeAll(async () => {
  demo = await account(t.db, { clerkOrgId: DEMO_ACCOUNT_CLERK_ORG_ID });
});

function testEnv(uploads: ReturnType<typeof fakeBucket>): Env {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${t.databaseName}`;
  return {
    ENVIRONMENT: "local",
    API_URL: "http://localhost:8797",
    CLERK_PUBLISHABLE_KEY: "",
    CLERK_SECRET_KEY: "",
    CLERK_WEBHOOK_SIGNING_SECRET: "",
    SESSION_SECRET: "",
    UPLOADS: uploads as unknown as R2Bucket,
    HYPERDRIVE: { connectionString: url.toString() } as Hyperdrive,
  } as Env;
}

async function csvRun(projectId: string, failed: number) {
  const [run] = await t.db
    .insert(schema.ingestRuns)
    .values({
      projectId,
      environment: "live",
      kind: "csv",
      status: "succeeded",
      received: 10,
      created: 10 - failed,
      failed,
      artifactKey: `uploads/${projectId}/run.csv`,
      finishedAt: new Date(),
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

async function download(
  slug: string,
  runId: string,
  uploads: ReturnType<typeof fakeBucket>,
): Promise<{ status: number; body: unknown }> {
  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  try {
    const response = (await loader({
      request: new Request(
        `https://dash.test/app/projects/${slug}/import/${runId}/errors`,
      ),
      params: { slug, runId },
      context: createLoadContext({ env: testEnv(uploads), ctx }),
    } as never)) as Response;
    return { status: response.status, body: await response.text() };
  } catch (thrown) {
    // react-router `data()` throws a DataWithResponseInit.
    const d = thrown as { init?: { status?: number }; data?: unknown };
    if (d?.init?.status) return { status: d.init.status, body: d.data };
    throw thrown;
  }
}

describe("error report download", () => {
  it("serves the CSV while the report exists", async () => {
    const p = await project(t.db, { accountId: demo.id, slug: "report-live" });
    const run = await csvRun(p.id, 1);
    const uploads = fakeBucket();
    await uploads.put(
      errorsKey(run.artifactKey as string),
      JSON.stringify([{ rowNumber: 4, reason: "Text is empty" }]),
    );
    const res = await download("report-live", run.id, uploads);
    expect(res.status).toBe(200);
    expect(res.body).toBe('row,reason\r\n4,"Text is empty"');
  });

  it("answers 410 with a message once the lifecycle rule has deleted it", async () => {
    const p = await project(t.db, { accountId: demo.id, slug: "report-gone" });
    const run = await csvRun(p.id, 3);
    const res = await download("report-gone", run.id, fakeBucket());
    expect(res.status).toBe(410);
    expect(String(res.body)).toMatch(/expired.*7 days/);
  });

  it("answers 404 when the run had no failures", async () => {
    const p = await project(t.db, { accountId: demo.id, slug: "report-none" });
    const run = await csvRun(p.id, 0);
    const res = await download("report-none", run.id, fakeBucket());
    expect(res.status).toBe(404);
  });
});
