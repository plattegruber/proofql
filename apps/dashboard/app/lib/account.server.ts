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
 *     authenticated load with the organization's name from Clerk's Backend
 *     API (the webhook keeps it fresh afterwards).
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
  /** Organization display name from Clerk; null when unavailable. */
  fetchOrganizationName: (env: Env, orgId: string) => Promise<string | null>;
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
  fetchOrganizationName: async (env, orgId) => {
    try {
      const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
      const org = await clerk.organizations.getOrganization({
        organizationId: orgId,
      });
      return org.name;
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
    const account = await deps.withDb(args.context, (db) =>
      findAccountByClerkOrgId(db, DEMO_ACCOUNT_CLERK_ORG_ID),
    );
    if (!account) {
      // Local dev without seed data: say so plainly instead of a blank page.
      throw data("Demo account not found — run `pnpm seed` first.", {
        status: 503,
      });
    }
    return {
      account,
      orgId: DEMO_ACCOUNT_CLERK_ORG_ID,
      userId: STUB_USER_ID,
      mode,
    };
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
    const name =
      (await deps.fetchOrganizationName(env, orgId)) ??
      auth.orgSlug ??
      "Workspace";
    return upsertAccountByClerkOrgId(db, { clerkOrgId: orgId, name });
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
