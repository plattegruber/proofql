// The Settings action end to end against the real schema with a fake KV:
// a policy change writes the row and bumps `gen:<projectId>`; a rename
// alone does not bump; validation failures return 422 field errors and
// touch neither. Runs in the local auth stub (the demo account is created
// in this file's database), with HYPERDRIVE pointed at the harness db.
import {
  createLogger,
  generationKey,
  MemoryBucket,
  MemoryKv,
  recordingSink,
} from "@proofql/core";
import { DEMO_ACCOUNT_CLERK_ORG_ID } from "@proofql/db/seed";
import { account, project, setupTestDb } from "@proofql/db/test";
import { beforeAll, describe, expect, it } from "vitest";

import { createLoadContext } from "~/lib/context";
import { action } from "./app.projects.$slug.settings";

const t = setupTestDb();

/** The stub's account (`requireAccount` resolves it by clerk_org_id). */
let demo: Awaited<ReturnType<typeof account>>;
beforeAll(async () => {
  demo = await account(t.db, { clerkOrgId: DEMO_ACCOUNT_CLERK_ORG_ID });
});

function testEnv(kv: MemoryKv, uploads = new MemoryBucket()): Env {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${t.databaseName}`;
  return {
    ENVIRONMENT: "local",
    API_URL: "http://localhost:8797",
    CLERK_PUBLISHABLE_KEY: "",
    CLERK_SECRET_KEY: "",
    CLERK_WEBHOOK_SIGNING_SECRET: "",
    SESSION_SECRET: "",
    CACHE: kv as unknown as KVNamespace,
    UPLOADS: uploads as unknown as R2Bucket,
    HYPERDRIVE: { connectionString: url.toString() } as Hyperdrive,
  } as Env;
}

async function submit(
  slug: string,
  fields: Record<string, string>,
  kv: MemoryKv,
  extra: {
    uploads?: MemoryBucket;
    lines?: ReturnType<typeof recordingSink>;
  } = {},
) {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const body = new URLSearchParams(fields);
  const request = new Request(
    `https://dash.test/app/projects/${slug}/settings`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  const result = await action({
    request,
    params: { slug },
    context: createLoadContext({
      env: testEnv(kv, extra.uploads),
      ctx,
      ...(extra.lines
        ? {
            log: createLogger({
              service: "dashboard",
              environment: "test",
              sink: extra.lines.sink,
            }),
          }
        : {}),
    }),
  } as never);
  await Promise.all(pending);
  return result;
}

describe("settings action", () => {
  it("saves the policy, bumps the generation, and redirects with a flash", async () => {
    const p = await project(t.db, { accountId: demo.id, slug: "cedar" });
    const kv = new MemoryKv();

    const result = await submit(
      "cedar",
      {
        intent: "save",
        name: "Cedar Ridge Dental",
        slug: "cedar",
        min_rating: "3",
        similarity_floor: "0.62",
      },
      kv,
    );

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/app/projects/cedar/settings",
    );
    expect(response.headers.get("Set-Cookie")).toContain("__pq_flash=");

    const [row] = await t.sql<
      { min_rating: number; similarity_floor: number; name: string }[]
    >`SELECT min_rating, similarity_floor, name FROM projects WHERE id = ${p.id}`;
    expect(row).toEqual({
      min_rating: 3,
      similarity_floor: 0.62,
      name: "Cedar Ridge Dental",
    });
    expect(kv.puts).toEqual([{ key: generationKey(p.id), value: "1" }]);

    // Rename only: the row changes, the generation does not.
    const renamed = await submit(
      "cedar",
      {
        intent: "save",
        name: "Cedar Ridge",
        slug: "cedar-ridge",
        min_rating: "3",
        similarity_floor: "0.62",
      },
      kv,
    );
    expect((renamed as Response).headers.get("Location")).toBe(
      "/app/projects/cedar-ridge/settings",
    );
    expect(kv.puts).toHaveLength(1);
  });

  it("returns 422 field errors and writes nothing for invalid input", async () => {
    const p = await project(t.db, { accountId: demo.id, slug: "shop" });
    const kv = new MemoryKv();

    const result = (await submit(
      "shop",
      {
        intent: "save",
        name: "",
        slug: "shop",
        min_rating: "7",
        similarity_floor: "0.95",
      },
      kv,
    )) as {
      init?: { status?: number };
      data: { fieldErrors: Record<string, string[]> };
    };

    expect(result.init?.status).toBe(422);
    expect(result.data.fieldErrors).toMatchObject({
      name: ["Give the project a name."],
      min_rating: ["Pick a rating between 1 and 5."],
      similarity_floor: ["Enter a value between 0.3 and 0.9."],
    });
    const [row] = await t.sql<
      { min_rating: number }[]
    >`SELECT min_rating FROM projects WHERE id = ${p.id}`;
    expect(row?.min_rating).toBe(4);
    expect(kv.puts).toEqual([]);
  });

  it("deletes only when the typed slug matches, then redirects to the overview", async () => {
    const p = await project(t.db, { accountId: demo.id, slug: "gone" });
    const kv = new MemoryKv();

    const refused = (await submit(
      "gone",
      { intent: "delete", confirm: "wrong" },
      kv,
    )) as {
      init?: { status?: number };
      data: { fieldErrors: Record<string, string[]> };
    };
    expect(refused.init?.status).toBe(422);
    expect(refused.data.fieldErrors.confirm?.[0]).toBe(
      "Type gone exactly to confirm.",
    );

    const deleted = (await submit(
      "gone",
      { intent: "delete", confirm: "gone" },
      kv,
    )) as Response;
    expect(deleted.status).toBe(302);
    expect(deleted.headers.get("Location")).toBe("/app");
    const [row] = await t.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM projects WHERE id = ${p.id}`;
    expect(row?.n).toBe(0);
  });

  it("deletes the project's upload files past the response and logs the count", async () => {
    const p = await project(t.db, { accountId: demo.id, slug: "uploads-gone" });
    const other = await project(t.db, { accountId: demo.id, slug: "kept" });
    const uploads = new MemoryBucket([
      `uploads/${p.id}/r1.csv`,
      `uploads/${p.id}/r1.plan.json`,
      `uploads/${p.id}/r1.errors.json`,
      `uploads/${other.id}/r2.csv`,
    ]);
    const lines = recordingSink();

    const deleted = (await submit(
      "uploads-gone",
      { intent: "delete", confirm: "uploads-gone" },
      new MemoryKv(),
      { uploads, lines },
    )) as Response;

    expect(deleted.status).toBe(302);
    expect(uploads.keys()).toEqual([`uploads/${other.id}/r2.csv`]);
    expect(lines.only("uploads.deleted")).toMatchObject({
      project_id: p.id,
      count: 3,
    });
  });
});
