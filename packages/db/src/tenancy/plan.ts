/**
 * Account plan changes and the badge mirror (issue #54).
 *
 * The truth for the snippet badge is `planFor(accounts.plan).badge`
 * (@proofql/core PLANS): the api derives `badge` from the account's plan on
 * every request. `projects.show_badge` is only a cached mirror of that —
 * kept so a dashboard list or an ad-hoc query can read one row — and it is
 * refreshed here whenever a plan changes. Nothing reads it to decide
 * anything the customer can see.
 *
 * Today a plan changes only through `setAccountPlan`: the ops script
 * (`pnpm db:set-plan`) calls it, and the billing path (Stripe, M3) must call
 * it too. The Clerk webhook never touches `plan` (it owns name and
 * soft-delete only), so it has nothing to sync.
 *
 * No query-cache bump is needed on a plan change: the api keeps `badge`
 * outside the cached body (workers/api/src/query/cache.ts "What is stored"),
 * so a cached HIT already carries the new plan's badge on the next request.
 */

import { type Plan, planFor } from "@proofql/core";
import { eq } from "drizzle-orm";

import type { Db } from "../client.js";
import { accounts, projects } from "../schema/tenancy.js";

/** Drizzle's transaction client; structurally what the queries below need. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Rewrite `projects.show_badge` for every project of `accountId` from the
 * account's current plan. Resolves to the number of project rows updated
 * (every project of the account, changed or not); `undefined` when the
 * account does not exist.
 */
export async function syncProjectBadges(
  db: Db | Tx,
  accountId: string,
): Promise<number | undefined> {
  const [row] = await db
    .select({ plan: accounts.plan })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (row === undefined) return undefined;
  const updated = await db
    .update(projects)
    .set({ showBadge: planFor(row.plan).badge, updatedAt: new Date() })
    .where(eq(projects.accountId, accountId))
    .returning({ id: projects.id });
  return updated.length;
}

export interface SetAccountPlanResult {
  accountId: string;
  previousPlan: Plan;
  plan: Plan;
  /** Projects whose `show_badge` mirror was rewritten. */
  projectsSynced: number;
}

/**
 * Change an account's plan and refresh its projects' badge mirror in one
 * transaction. Resolves to `undefined` when the account does not exist.
 */
export async function setAccountPlan(
  db: Db,
  accountId: string,
  plan: Plan,
): Promise<SetAccountPlanResult | undefined> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ plan: accounts.plan })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .for("update");
    if (before === undefined) return undefined;
    await tx
      .update(accounts)
      .set({ plan, updatedAt: new Date() })
      .where(eq(accounts.id, accountId));
    const projectsSynced = (await syncProjectBadges(tx, accountId)) ?? 0;
    return { accountId, previousPlan: before.plan, plan, projectsSynced };
  });
}
