import { PLANS } from "@proofql/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { account, project, setupTestDb } from "../../test/index.js";
import { accounts, projects } from "../schema/tenancy.js";
import { setAccountPlan, syncProjectBadges } from "./plan.js";

const t = setupTestDb();

async function badges(accountId: string) {
  const rows = await t.db
    .select({ showBadge: projects.showBadge })
    .from(projects)
    .where(eq(projects.accountId, accountId));
  return rows.map((r) => r.showBadge);
}

describe("syncProjectBadges", () => {
  it("rewrites show_badge from the account's plan for every project", async () => {
    const a = await account(t.db, { plan: "paid" });
    // Stale mirrors, as a project created before an upgrade would carry.
    await project(t.db, { accountId: a.id, showBadge: true });
    await project(t.db, { accountId: a.id, showBadge: true });
    const other = await project(t.db, { showBadge: true });

    expect(await syncProjectBadges(t.db, a.id)).toBe(2);
    expect(await badges(a.id)).toEqual([false, false]);
    // Another account's project is untouched.
    expect(await badges(other.accountId)).toEqual([true]);
  });

  it("is undefined for an unknown account", async () => {
    expect(
      await syncProjectBadges(t.db, "00000000-0000-0000-0000-000000000000"),
    ).toBeUndefined();
  });
});

describe("setAccountPlan", () => {
  it("changes the plan and the mirror together, both ways", async () => {
    const a = await account(t.db);
    await project(t.db, { accountId: a.id });
    expect(await badges(a.id)).toEqual([PLANS.free.badge]);

    const up = await setAccountPlan(t.db, a.id, "paid");
    expect(up).toEqual({
      accountId: a.id,
      previousPlan: "free",
      plan: "paid",
      projectsSynced: 1,
    });
    const [afterUp] = await t.db
      .select({ plan: accounts.plan })
      .from(accounts)
      .where(eq(accounts.id, a.id));
    expect(afterUp?.plan).toBe("paid");
    expect(await badges(a.id)).toEqual([PLANS.paid.badge]);

    const down = await setAccountPlan(t.db, a.id, "free");
    expect(down?.previousPlan).toBe("paid");
    expect(await badges(a.id)).toEqual([PLANS.free.badge]);
  });

  it("is undefined for an unknown account and writes nothing", async () => {
    expect(
      await setAccountPlan(
        t.db,
        "00000000-0000-0000-0000-000000000000",
        "paid",
      ),
    ).toBeUndefined();
  });
});
