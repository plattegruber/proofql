/**
 * The daily account purge (#169) as the cron runs it: a workspace marked
 * deleted 31 days ago goes, with its projects' R2 prefixes (the in-memory
 * bucket standing in for `UPLOADS`); one marked 29 days ago stays. The
 * cutoff, cascade and bound are covered in depth by
 * packages/db/src/tenancy/purge.integration.test.ts.
 */

import { MemoryBucket } from "@proofql/core";
import { schema } from "@proofql/db";
import { account, project, review, setupTestDb } from "@proofql/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { testLogger } from "../test/log.js";
import { runAccountPurge } from "./account-purge.js";

const t = setupTestDb();
const NOW = new Date("2026-10-05T04:15:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("runAccountPurge", () => {
  it("purges 31-day-old deletions with their uploads and keeps 29-day-old ones", async () => {
    const old = await account(t.db, {
      deletedAt: new Date(NOW.getTime() - 31 * DAY),
    });
    const recent = await account(t.db, {
      deletedAt: new Date(NOW.getTime() - 29 * DAY),
    });
    const oldProject = await project(t.db, { accountId: old.id });
    const recentProject = await project(t.db, { accountId: recent.id });
    await review(t.db, { projectId: oldProject.id });
    const uploads = new MemoryBucket([
      `uploads/${oldProject.id}/r1.csv`,
      `uploads/${oldProject.id}/r1.errors.json`,
      `uploads/${recentProject.id}/r2.csv`,
    ]);
    const { log, out } = testLogger();

    const result = await runAccountPurge(
      { db: t.db, uploads, log },
      { now: NOW },
    );

    expect(result.accounts.map((a) => a.accountId)).toEqual([old.id]);
    expect(uploads.keys()).toEqual([`uploads/${recentProject.id}/r2.csv`]);
    expect(
      await t.db
        .select()
        .from(schema.reviews)
        .where(eq(schema.reviews.projectId, oldProject.id)),
    ).toEqual([]);
    expect(
      await t.db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, recent.id)),
    ).toHaveLength(1);
    expect(out.only("account.purged")).toMatchObject({
      service: "pipeline",
      account_id: old.id,
      projects: 1,
      upload_objects: 2,
    });
    expect(out.only("account.purge.completed")).toMatchObject({
      accounts: 1,
      remaining: false,
    });
  });

  it("purges the rows without a bucket and says R2 was not touched", async () => {
    const old = await account(t.db, {
      deletedAt: new Date(NOW.getTime() - 40 * DAY),
    });
    const { log, out } = testLogger();
    const result = await runAccountPurge({ db: t.db, log }, { now: NOW });
    expect(result.accounts.map((a) => a.accountId)).toEqual([old.id]);
    expect(out.only("account.purge.completed").upload_objects).toBeNull();
  });
});
