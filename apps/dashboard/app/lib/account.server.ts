/**
 * THE auth seam for data-backed loaders and actions.
 *
 * `requireAccount(args)` resolves the acting account for a request and is
 * the only function that knows how. Callers treat its result as "the
 * authenticated context" and never look at Clerk themselves, so the two
 * modes below are a one-function swap (the pattern Well-Regarded's
 * `requirePracticeContext()` established):
 *
 *   - clerk (CLERK_SECRET_KEY set): the Clerk session from `clerkMiddleware`
 *     (app/lib/clerk.server.ts). No user ⇒ redirect to /sign-in (with
 *     `redirect_url` back). No active Organization ⇒ redirect to
 *     /app/workspace, which shows Clerk's create/select UI. Otherwise the
 *     `accounts` row for `clerk_org_id` is loaded, or created on the first
 *     authenticated load with the organization's name and creator from
 *     Clerk's Backend API (the webhook keeps the name fresh afterwards).
 *   - stub (no key, ENVIRONMENT "local"): the seeded demo account
 *     (`org_demo_proofql`, `pnpm seed`) with a fixed fake user id. Deliberately
 *     DB-backed rather than a constant so every query scopes to a real row.
 *
 * Dependencies are injectable (`deps`) so the decision logic is unit-tested
 * without Clerk or Postgres (account.server.test.ts).
 */
import { createClerkClient, getAuth } from "@clerk/react-router/server";
import { DEMO_ACCOUNT_CLERK_ORG_ID } from "@proofql/db/seed";
import {
  data,
  type LoaderFunctionArgs,
  type RouterContextProvider,
  redirect,
} from "react-router";

import {
  type Account,
  findAccountByClerkOrgId,
  upsertAccountByClerkOrgId,
} from "./accounts";
import { type AuthMode, authMode } from "./auth-mode";
import { getCloudflare } from "./context";
import { type WithDb, withRequestDb } from "./db.server";
import { SIGN_IN_PATH, WORKSPACE_PATH } from "./paths";

export interface AccountContext {
  account: Account;
  /** The Clerk Organization id (`accounts.clerk_org_id`). */
  orgId: string;
  /** The Clerk user id; a fixed fake in the stub. */
  userId: string;
  mode: Exclude<AuthMode, "unconfigured">;
}

/** The subset of Clerk's auth object `requireAccount` reads. */
export interface SessionAuth {
  userId: string | null;
  orgId?: string | null;
  orgSlug?: string | null;
}

export interface RequireAccountDeps {
  getAuth: (args: RequireAccountArgs) => Promise<SessionAuth>;
  withDb: WithDb;
  /** Organization name and creator from Clerk; null when unavailable. */
  fetchOrganization: (
    env: Env,
    orgId: string,
  ) => Promise<OrganizationInfo | null>;
}

export interface OrganizationInfo {
  name: string;
  /** The Clerk user id that created the Organization, when Clerk says. */
  createdBy: string | null;
}

export type RequireAccountArgs = Pick<LoaderFunctionArgs, "request"> & {
  context: Readonly<RouterContextProvider>;
};

export const STUB_USER_ID = "user_local_stub";

const defaultDeps: RequireAccountDeps = {
  getAuth: async (args) => {
    const auth = await getAuth(args as LoaderFunctionArgs);
    return { userId: auth.userId, orgId: auth.orgId, orgSlug: auth.orgSlug };
  },
  withDb: withRequestDb,
  fetchOrganization: async (env, orgId) => {
    try {
      const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
      const org = await clerk.organizations.getOrganization({
        organizationId: orgId,
      });
      return { name: org.name, createdBy: org.createdBy ?? null };
    } catch {
      return null;
    }
  },
};

export async function requireAccount(
  args: RequireAccountArgs,
  deps: RequireAccountDeps = defaultDeps,
): Promise<AccountContext> {
  const { env } = getCloudflare(args.context);
  const mode = authMode(env);

  if (mode === "unconfigured") {
    throw data(
      'Clerk is not configured: set CLERK_SECRET_KEY (docs/secrets.md). The local auth stub only runs when ENVIRONMENT is "local".',
      { status: 503 },
    );
  }

  if (mode === "stub") {
    // AUTH_STUB_ORG_ID (.dev.vars) points the stub at another account — an
    // empty one is created on first load — so the guided onboarding (#53)
    // can be walked through from a fresh account without Clerk.
    const override = env.AUTH_STUB_ORG_ID?.trim() || undefined;
    const orgId = override ?? DEMO_ACCOUNT_CLERK_ORG_ID;
    const account = await deps.withDb(args.context, async (db) => {
      const existing = await findAccountByClerkOrgId(db, orgId);
      if (existing || override === undefined) return existing;
      return upsertAccountByClerkOrgId(db, {
        clerkOrgId: orgId,
        name: "Local stub account",
      });
    });
    if (!account) {
      // Local dev without seed data: say so plainly instead of a blank page.
      throw data("Demo account not found — run `pnpm seed` first.", {
        status: 503,
      });
    }
    return { account, orgId, userId: STUB_USER_ID, mode };
  }

  const auth = await deps.getAuth(args);
  if (!auth.userId) {
    const url = new URL(args.request.url);
    const params = new URLSearchParams({
      redirect_url: url.pathname + url.search,
    });
    throw redirect(`${SIGN_IN_PATH}?${params}`);
  }
  if (!auth.orgId) throw redirect(WORKSPACE_PATH);
  const orgId = auth.orgId;

  const account = await deps.withDb(args.context, async (db) => {
    const existing = await findAccountByClerkOrgId(db, orgId);
    if (existing && !existing.deletedAt) return existing;
    // Soft-deleted (Clerk `organization.deleted`) and still within the
    // 30-day grace: the upsert clears the mark. Once the pipeline's daily
    // purge has hard-deleted it (#169) there is no row, and the upsert
    // creates a new, empty account for the organization — by design.
    const org = await deps.fetchOrganization(env, orgId);
    const name = org?.name ?? auth.orgSlug ?? "Workspace";
    // The creator, for the per-person free allowance (projects.server.ts).
    // Without Clerk's answer, the first signed-in loader of a new workspace
    // is its creator: Clerk's create flow lands them here.
    const createdByUserId = org?.createdBy ?? auth.userId;
    return upsertAccountByClerkOrgId(db, {
      clerkOrgId: orgId,
      name,
      createdByUserId,
    });
  });

  return { account, orgId, userId: auth.userId, mode };
}

/**
 * Signed-in user without the account requirement — for /app/workspace,
 * where the point is that no Organization is active yet.
 */
export async function requireUser(
  args: RequireAccountArgs,
  deps: Pick<RequireAccountDeps, "getAuth"> = defaultDeps,
): Promise<{ userId: string; orgId: string | null }> {
  const auth = await deps.getAuth(args);
  if (!auth.userId) {
    const url = new URL(args.request.url);
    const params = new URLSearchParams({ redirect_url: url.pathname });
    throw redirect(`${SIGN_IN_PATH}?${params}`);
  }
  return { userId: auth.userId, orgId: auth.orgId ?? null };
}
