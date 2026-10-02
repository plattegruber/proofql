// The overview loader end to end against the real schema in the local auth
// stub: the plan's limits from PLANS and this month's `usage` row — the
// same row the api's quota middleware increments — per project.
import { PLANS, usageMonthStart } from "@proofql/core";
import { schema, setAccountPlan } from "@proofql/db";
import { DEMO_ACCOUNT_CLERK_ORG_ID } from "@proofql/db/seed";
import { account, project, setupTestDb } from "@proofql/db/test";
import { beforeAll, describe, expect, it } from "vitest";

import { createLoadContext } from "~/lib/context";
import { loader } from "./app._index";

const t = setupTestDb();

/** The stub's account (`requireAccount` resolves it by clerk_org_id). */
let demo: Awaited<ReturnType<typeof account>>;
beforeAll(async () => {
  demo = await account(t.db, { clerkOrgId: DEMO_ACCOUNT_CLERK_ORG_ID });
});

function testEnv(): Env {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${t.databaseName}`;
  return {
    ENVIRONMENT: "local",
    API_URL: "http://localhost:8797",
    CLERK_PUBLISHABLE_KEY: "",
    CLERK_SECRET_KEY: "",
    CLERK_WEBHOOK_SIGNING_SECRET: "",
    SESSION_SECRET: "",
    HYPERDRIVE: { connectionString: url.toString() } as Hyperdrive,
  } as Env;
}

async function load() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const result = await loader({
    request: new Request("https://dash.test/app"),
    params: {},
    context: createLoadContext({ env: testEnv(), ctx }),
  } as never);
  await Promise.all(pending);
  return result;
}

describe("overview loader", () => {
  it("reads this month's usage row per project and the plan's limits", async () => {
    const month = usageMonthStart();
    const p = await project(t.db, {
      accountId: demo.id,
      slug: "cedar",
      name: "Cedar Ridge Dental",
      reviewCount: 80,
    });
    const quiet = await project(t.db, { accountId: demo.id, slug: "quiet" });
    // The api's counters: 1,240 answered, 1,000 of them from KV.
    await t.db
      .insert(schema.usage)
      .values({ projectId: p.id, month, queries: 1_240, cacheHits: 1_000 });
    // Last month's row must not leak into this month's panel.
    const last = new Date(`${month}T00:00:00Z`);
    last.setUTCMonth(last.getUTCMonth() - 1);
    await t.db.insert(schema.usage).values({
      projectId: p.id,
      month: usageMonthStart(last),
      queries: 99_999,
      cacheHits: 0,
    });

    const data = await load();

    expect(data.month).toBe(month);
    expect(data.plan).toEqual({
      label: "Free",
      badge: true,
      projects: PLANS.free.projects,
      reviewsPerProject: PLANS.free.reviewsPerProject,
      queriesPerMonth: PLANS.free.queriesPerMonth,
      pricingUrl: "https://proofql.com/pricing",
    });
    expect(data.projects).toEqual([
      expect.objectContaining({
        slug: "cedar",
        reviewCount: 80,
        usage: { queries: 1_240, cacheHits: 1_000, uncached: 240 },
      }),
      expect.objectContaining({
        slug: quiet.slug,
        usage: { queries: 0, cacheHits: 0, uncached: 0 },
      }),
    ]);
  });

  it("follows the account's plan", async () => {
    await setAccountPlan(t.db, demo.id, "paid");
    try {
      const data = await load();
      expect(data.account.plan).toBe("paid");
      expect(data.plan.badge).toBe(false);
      expect(data.plan.reviewsPerProject).toBe(PLANS.paid.reviewsPerProject);
    } finally {
      await setAccountPlan(t.db, demo.id, "free");
    }
  });
});
