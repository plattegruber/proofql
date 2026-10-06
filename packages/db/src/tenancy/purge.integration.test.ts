// purgeDeletedAccounts (#169) against the real schema: the 30-day cutoff,
// the full cascade (no orphan row in any tenant table afterwards), the R2
// prefix removal through the in-memory bucket, the per-run bound, the dry
// run, and a cascade audit over the live catalogue so a future table that
// hangs off a tenant without ON DELETE CASCADE fails here.
import {
  createLogger,
  MemoryBucket,
  type PrefixBucket,
  recordingSink,
} from "@proofql/core";
import { eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  account,
  apiKey,
  chunk,
  project,
  review,
  setupTestDb,
} from "../../test/index.js";
import {
  accounts,
  connections,
  ingestRuns,
  projects,
  usage,
} from "../schema/index.js";
import { purgeDeletedAccounts } from "./purge.js";

const t = setupTestDb();

const NOW = new Date("2026-10-05T04:15:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

/**
 * Every table holding tenant data, keyed by the column that ties a row to
 * a project (or to the account, for `projects`). The audit below checks
 * this list against the catalogue, so a new tenant table must be added
 * here — and must cascade — before this file passes.
 */
const TENANT_TABLES = {
  projects: "account_id",
  api_keys: "project_id",
  connections: "project_id",
  ingest_runs: "project_id",
  reviews: "project_id",
  review_chunks: "project_id",
  usage: "project_id",
} as const;

/** Tables that are not tenant data. */
const NON_TENANT_TABLES = ["accounts", "waitlist"];

/** One account with every kind of tenant row, in two projects. */
async function populatedAccount(deletedAt: Date | null) {
  const a = await account(t.db, { deletedAt });
  const projectIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const p = await project(t.db, { accountId: a.id, reviewCount: 2 });
    projectIds.push(p.id);
    await apiKey(t.db, { projectId: p.id });
    await apiKey(t.db, {
      projectId: p.id,
      kind: "publishable",
      revokedAt: daysAgo(40),
    });
    const r = await review(t.db, { projectId: p.id });
    await chunk(t.db, { reviewId: r.id });
    await review(t.db, { projectId: p.id, environment: "test" });
    await t.db.insert(connections).values({ projectId: p.id, kind: "google" });
    await t.db.insert(ingestRuns).values({
      projectId: p.id,
      environment: "live",
      kind: "csv",
      artifactKey: `uploads/${p.id}/run.csv`,
    });
    await t.db
      .insert(usage)
      .values({ projectId: p.id, month: "2026-09-01", queries: 3 });
  }
  return { account: a, projectIds };
}

/** Row counts per tenant table for the given account / project ids. */
async function tenantCounts(accountId: string, projectIds: string[]) {
  const out: Record<string, number> = {};
  for (const [table, column] of Object.entries(TENANT_TABLES)) {
    const ids = column === "account_id" ? [accountId] : projectIds;
    const rows = await t.sql.unsafe(
      `SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = ANY($1::uuid[])`,
      [ids],
    );
    out[table] = (rows[0] as { n: number }).n;
  }
  const [acc] =
    await t.sql`SELECT count(*)::int AS n FROM accounts WHERE id = ${accountId}`;
  out.accounts = (acc as { n: number }).n;
  return out;
}

function uploadsFor(projectIds: string[], bucket = new MemoryBucket()) {
  for (const id of projectIds) {
    bucket.objects.set(`uploads/${id}/run.csv`, "a,b");
    bucket.objects.set(`uploads/${id}/run.plan.json`, "{}");
    bucket.objects.set(`uploads/${id}/run.errors.json`, "[]");
  }
  return bucket;
}

describe("cascade audit", () => {
  it("lists every table, and every tenant foreign key cascades", async () => {
    const tables = await t.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name NOT LIKE '%drizzle%'`;
    expect(tables.map((r) => r.table_name).sort()).toEqual(
      [...Object.keys(TENANT_TABLES), ...NON_TENANT_TABLES].sort(),
    );

    const fks = await t.sql<
      { table_name: string; column_name: string; ref: string; rule: string }[]
    >`
      SELECT kcu.table_name, kcu.column_name, ccu.table_name AS ref,
             rc.delete_rule AS rule
      FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = rc.constraint_name
       AND kcu.constraint_schema = rc.constraint_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = rc.constraint_name
       AND ccu.constraint_schema = rc.constraint_schema
      WHERE rc.constraint_schema = 'public'`;
    for (const fk of fks) {
      expect(`${fk.table_name}.${fk.column_name} → ${fk.ref}: ${fk.rule}`).toBe(
        `${fk.table_name}.${fk.column_name} → ${fk.ref}: CASCADE`,
      );
    }
    // Each tenant table's tie column is a cascading FK to its parent.
    for (const [table, column] of Object.entries(TENANT_TABLES)) {
      expect(
        fks.some((fk) => fk.table_name === table && fk.column_name === column),
        `${table}.${column} has a foreign key`,
      ).toBe(true);
    }
  });
});

describe("purgeDeletedAccounts", () => {
  it("purges accounts marked 31 days ago and keeps those marked 29 days ago", async () => {
    const old = await populatedAccount(daysAgo(31));
    const recent = await populatedAccount(daysAgo(29));
    const live = await populatedAccount(null);
    const bucket = uploadsFor([
      ...old.projectIds,
      ...recent.projectIds,
      ...live.projectIds,
    ]);
    const before = {
      recent: await tenantCounts(recent.account.id, recent.projectIds),
      live: await tenantCounts(live.account.id, live.projectIds),
    };
    expect(await tenantCounts(old.account.id, old.projectIds)).toEqual(
      before.live,
    );

    const lines = recordingSink();
    const result = await purgeDeletedAccounts(
      {
        db: t.db,
        uploads: bucket,
        log: createLogger({
          service: "pipeline",
          environment: "test",
          sink: lines.sink,
        }),
      },
      { now: NOW },
    );

    expect(result.accounts.map((a) => a.accountId)).toEqual([old.account.id]);
    expect(result.accounts[0]).toMatchObject({
      projects: 2,
      reviews: 4,
      uploadObjects: 6,
    });
    expect(result.remaining).toBe(false);

    // Full cascade: nothing of the purged account is left anywhere.
    const after = await tenantCounts(old.account.id, old.projectIds);
    expect(Object.values(after).every((n) => n === 0)).toBe(true);
    // Nothing else was touched.
    expect(await tenantCounts(recent.account.id, recent.projectIds)).toEqual(
      before.recent,
    );
    expect(await tenantCounts(live.account.id, live.projectIds)).toEqual(
      before.live,
    );

    // R2: the purged projects' prefixes are gone, the rest stay.
    for (const id of old.projectIds) {
      expect(bucket.keys(`uploads/${id}/`)).toEqual([]);
    }
    for (const id of [...recent.projectIds, ...live.projectIds]) {
      expect(bucket.keys(`uploads/${id}/`)).toHaveLength(3);
    }

    const events = lines.records.map((r) => r.event);
    expect(events).toEqual(["account.purged", "account.purge.completed"]);
    expect(lines.records[0]).toMatchObject({
      account_id: old.account.id,
      projects: 2,
      reviews: 4,
      upload_objects: 6,
    });
  });

  it("is bounded per run, oldest first, and reports what remains", async () => {
    const marks = [45, 40, 35].map(daysAgo);
    const created = [];
    for (const deletedAt of marks) {
      created.push(await account(t.db, { deletedAt }));
    }
    const first = await purgeDeletedAccounts(
      { db: t.db },
      { now: NOW, limit: 2 },
    );
    expect(first.accounts.map((a) => a.accountId)).toEqual([
      created[0]?.id,
      created[1]?.id,
    ]);
    expect(first.remaining).toBe(true);
    expect(first.accounts[0]?.uploadObjects).toBeNull();

    const second = await purgeDeletedAccounts(
      { db: t.db },
      { now: NOW, limit: 2 },
    );
    expect(second.accounts.map((a) => a.accountId)).toEqual([created[2]?.id]);
    expect(second.remaining).toBe(false);
  });

  it("dry run lists what is due and deletes nothing", async () => {
    const due = await populatedAccount(daysAgo(60));
    const bucket = uploadsFor(due.projectIds);
    const before = await tenantCounts(due.account.id, due.projectIds);

    const result = await purgeDeletedAccounts(
      { db: t.db, uploads: bucket },
      { now: NOW, dryRun: true },
    );
    expect(result.dryRun).toBe(true);
    expect(result.accounts.map((a) => a.accountId)).toContain(due.account.id);
    expect(await tenantCounts(due.account.id, due.projectIds)).toEqual(before);
    expect(bucket.keys()).toHaveLength(6);

    // Clean up so later tests start from no due accounts.
    await purgeDeletedAccounts({ db: t.db }, { now: NOW });
  });

  it("does not purge an account whose mark was cleared (revived)", async () => {
    const a = await account(t.db, { deletedAt: daysAgo(31) });
    // Re-creating the organization in Clerk clears the mark (dashboard
    // upsertAccountByClerkOrgId); purge re-checks it under a row lock.
    await t.db
      .update(accounts)
      .set({ deletedAt: null })
      .where(eq(accounts.id, a.id));
    const result = await purgeDeletedAccounts({ db: t.db }, { now: NOW });
    expect(result.accounts).toEqual([]);
    const [row] = await t.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, a.id));
    expect(row?.deletedAt).toBeNull();
  });

  it("keeps purging when the bucket fails, and logs the failure", async () => {
    const due = await populatedAccount(daysAgo(31));
    const broken: PrefixBucket = {
      list: async () => {
        throw new Error("R2 unavailable");
      },
      delete: async () => {},
    };
    const lines = recordingSink();
    const result = await purgeDeletedAccounts(
      {
        db: t.db,
        uploads: broken,
        log: createLogger({
          service: "pipeline",
          environment: "test",
          sink: lines.sink,
        }),
      },
      { now: NOW },
    );
    expect(result.accounts.map((a) => a.accountId)).toEqual([due.account.id]);
    expect(result.accounts[0]?.uploadObjects).toBe(0);
    const remaining = await t.db
      .select({ id: projects.id })
      .from(projects)
      .where(inArray(projects.id, due.projectIds));
    expect(remaining).toEqual([]);
    expect(
      lines.records.filter((r) => r.event === "uploads.delete_failed"),
    ).toHaveLength(2);
  });

  it("leaves the waitlist alone", async () => {
    await t.db.execute(
      sql`INSERT INTO waitlist (email) VALUES ('someone@example.com')`,
    );
    await purgeDeletedAccounts({ db: t.db }, { now: NOW });
    const [row] = await t.sql`SELECT count(*)::int AS n FROM waitlist`;
    expect((row as { n: number }).n).toBe(1);
  });
});
