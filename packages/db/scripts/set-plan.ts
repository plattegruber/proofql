/**
 * Ops: change an account's plan (and refresh its projects' badge mirror).
 * Until billing lands (M3) this is the only way a plan changes.
 *
 *     DATABASE_URL=postgres://... pnpm db:set-plan -- --account <uuid|org_…> --plan paid
 *     DATABASE_URL=postgres://... pnpm db:set-plan -- --account <uuid|org_…> --sync
 *
 * `--account` takes the `accounts.id` or the Clerk organization id
 * (`accounts.clerk_org_id`). `--sync` only rewrites `projects.show_badge`
 * from the current plan, for repairing a mirror after a manual UPDATE.
 */

import { fileURLToPath } from "node:url";
import { isPlan, PLAN_NAMES } from "@proofql/core";
import { eq } from "drizzle-orm";

import { createDb } from "../src/client.js";
import { accounts } from "../src/schema/tenancy.js";
import { setAccountPlan, syncProjectBadges } from "../src/tenancy/plan.js";
import { parseScriptArgs } from "./args.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(message: string): never {
  console.error(`db:set-plan: ${message}`);
  console.error(
    "usage: pnpm db:set-plan -- --account <uuid|clerk org id> (--plan <" +
      `${PLAN_NAMES.join("|")}> | --sync)`,
  );
  process.exit(1);
}

async function main(): Promise<void> {
  // parseScriptArgs drops the `--` pnpm forwards (#128, `scripts/args.ts`).
  const { values } = parseScriptArgs({
    options: {
      account: { type: "string" },
      plan: { type: "string" },
      sync: { type: "boolean", default: false },
    },
  });
  const url = process.env.DATABASE_URL;
  if (!url) usage("DATABASE_URL is not set");
  if (!values.account) usage("--account is required");
  if (values.sync === (values.plan !== undefined)) {
    usage("pass exactly one of --plan <plan> or --sync");
  }
  if (values.plan !== undefined && !isPlan(values.plan)) {
    usage(`unknown plan "${values.plan}"`);
  }

  const { db, sql } = createDb(url, { max: 1 });
  try {
    const [found] = await db
      .select({ id: accounts.id, name: accounts.name, plan: accounts.plan })
      .from(accounts)
      .where(
        UUID.test(values.account)
          ? eq(accounts.id, values.account)
          : eq(accounts.clerkOrgId, values.account),
      )
      .limit(1);
    if (found === undefined) usage(`no account matches "${values.account}"`);

    if (values.sync) {
      const n = await syncProjectBadges(db, found.id);
      console.log(
        `db:set-plan: "${found.name}" stays on ${found.plan}; show_badge refreshed on ${n ?? 0} project(s).`,
      );
      return;
    }
    const result = await setAccountPlan(db, found.id, values.plan as "free");
    if (result === undefined) usage(`account ${found.id} vanished`);
    console.log(
      `db:set-plan: "${found.name}" ${result.previousPlan} → ${result.plan}; show_badge refreshed on ${result.projectsSynced} project(s).`,
    );
    // The api caches the resolved key — plan included — in KV for 60 s on
    // /v1/query (workers/api/src/auth-cache.ts, #108).
    console.log(
      "db:set-plan: /v1/query picks the new plan up within a minute (cached auth context); other routes at once.",
    );
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
