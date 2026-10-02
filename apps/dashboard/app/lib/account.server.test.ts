// requireAccount's stub / Clerk decision, with Clerk and Postgres replaced
// by injected fakes. The DB-backed paths are covered by
// accounts.integration.test.ts.
import { DEMO_ACCOUNT_CLERK_ORG_ID } from "@proofql/db/seed";
import { describe, expect, it, vi } from "vitest";

import {
  type RequireAccountDeps,
  requireAccount,
  requireUser,
  type SessionAuth,
  STUB_USER_ID,
} from "./account.server";
import type { Account } from "./accounts";
import { createLoadContext } from "./context";

const demoAccount: Account = {
  id: "de300000-0000-4000-8000-000000000001",
  clerkOrgId: DEMO_ACCOUNT_CLERK_ORG_ID,
  name: "ProofQL Demo",
  plan: "free",
  stripeCustomerId: null,
  deletedAt: null,
  onboardingCompletedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function env(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "local",
    API_URL: "http://localhost:8797",
    CLERK_PUBLISHABLE_KEY: "",
    CLERK_SECRET_KEY: "",
    CLERK_WEBHOOK_SIGNING_SECRET: "",
    CACHE: {} as KVNamespace,
    HYPERDRIVE: { connectionString: "postgres://unused" } as Hyperdrive,
    ...overrides,
  } as Env;
}

function args(e: Env, url = "https://dash.test/app/projects/x?tab=keys") {
  return {
    request: new Request(url),
    context: createLoadContext({ env: e, ctx: {} as ExecutionContext }),
  };
}

/** An in-memory `accounts` table keyed by clerk_org_id. */
function fakeDeps(
  auth: SessionAuth,
  rows: Account[] = [],
  orgName: string | null = "Acme Co",
) {
  const table = new Map(rows.map((r) => [r.clerkOrgId, r]));
  const db = {
    query: {
      accounts: {
        findFirst: async ({ where }: { where: unknown }) => {
          // drizzle's eq() is opaque; the fake matches on the queried value.
          const value = (where as { queryChunks?: unknown[] }).queryChunks
            ?.map((c) => (c as { value?: unknown }).value)
            .find((v) => typeof v === "string");
          return table.get(value as string);
        },
      },
    },
    insert: () => ({
      values: (v: { clerkOrgId: string; name: string }) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            const existing = table.get(v.clerkOrgId);
            const row: Account = existing
              ? { ...existing, name: v.name, deletedAt: null }
              : { ...demoAccount, id: `acct_${v.clerkOrgId}`, ...v };
            table.set(v.clerkOrgId, row);
            return [row];
          },
        }),
      }),
    }),
  };
  const deps: RequireAccountDeps = {
    getAuth: vi.fn(async () => auth),
    withDb: vi.fn(async (_context, fn) =>
      fn(db as unknown as Parameters<typeof fn>[0]),
    ),
    fetchOrganizationName: vi.fn(async () => orgName),
  };
  return { deps, table };
}

/**
 * Normalize what the seam throws — a `redirect()` Response, or a `data()`
 * envelope (DataWithResponseInit) — into one `{ status, location, text }`.
 */
async function thrown(
  p: Promise<unknown>,
): Promise<{ status: number; location: string | null; text: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Response) {
      return {
        status: e.status,
        location: e.headers.get("location"),
        text: await e.text(),
      };
    }
    const d = e as { type?: string; data?: unknown; init?: ResponseInit };
    if (d?.type === "DataWithResponseInit") {
      return {
        status: d.init?.status ?? 200,
        location: null,
        text: String(d.data ?? ""),
      };
    }
    throw e;
  }
  throw new Error("expected requireAccount to throw");
}

describe("requireAccount — local auth stub", () => {
  it("returns the seeded demo account without touching Clerk", async () => {
    const { deps } = fakeDeps({ userId: null }, [demoAccount]);
    const ctx = await requireAccount(args(env()), deps);
    expect(ctx).toEqual({
      account: demoAccount,
      orgId: DEMO_ACCOUNT_CLERK_ORG_ID,
      userId: STUB_USER_ID,
      mode: "stub",
    });
    expect(deps.getAuth).not.toHaveBeenCalled();
    expect(deps.fetchOrganizationName).not.toHaveBeenCalled();
  });

  it("explains the missing seed instead of a blank page", async () => {
    const { deps } = fakeDeps({ userId: null }, []);
    const res = await thrown(requireAccount(args(env()), deps));
    expect(res.status).toBe(503);
    expect(res.text).toContain("pnpm seed");
  });

  it("AUTH_STUB_ORG_ID points the stub at another account, created empty on first load", async () => {
    const { deps, table } = fakeDeps({ userId: null }, [demoAccount]);
    const e = env({ AUTH_STUB_ORG_ID: "org_fresh" } as Partial<Env>);
    const ctx = await requireAccount(args(e), deps);
    expect(ctx.orgId).toBe("org_fresh");
    expect(ctx.account.clerkOrgId).toBe("org_fresh");
    expect(ctx.account.name).toBe("Local stub account");
    expect(ctx.mode).toBe("stub");
    expect(table.get(DEMO_ACCOUNT_CLERK_ORG_ID)).toEqual(demoAccount);
    // Second load finds the row instead of upserting again.
    const again = await requireAccount(args(e), deps);
    expect(again.account).toEqual(ctx.account);
  });
});

describe("requireAccount — misconfigured", () => {
  it("refuses to stub outside local when the secret is missing", async () => {
    const { deps } = fakeDeps({ userId: null }, [demoAccount]);
    const res = await thrown(
      requireAccount(args(env({ ENVIRONMENT: "preview" })), deps),
    );
    expect(res.status).toBe(503);
    expect(res.text).toContain("CLERK_SECRET_KEY");
    expect(deps.withDb).not.toHaveBeenCalled();
  });
});

describe("requireAccount — Clerk", () => {
  const clerkEnv = env({ CLERK_SECRET_KEY: "sk_test_fake" });

  it("redirects a signed-out request to /sign-in with the way back", async () => {
    const { deps } = fakeDeps({ userId: null });
    const res = await thrown(requireAccount(args(clerkEnv), deps));
    expect(res.status).toBe(302);
    expect(res.location).toBe(
      "/sign-in?redirect_url=%2Fapp%2Fprojects%2Fx%3Ftab%3Dkeys",
    );
  });

  it("sends a user with no active organization to the workspace step", async () => {
    const { deps } = fakeDeps({ userId: "user_1", orgId: null });
    const res = await thrown(requireAccount(args(clerkEnv), deps));
    expect(res.status).toBe(302);
    expect(res.location).toBe("/app/workspace");
    expect(deps.withDb).not.toHaveBeenCalled();
  });

  it("creates the account on first load, named after the organization", async () => {
    const { deps, table } = fakeDeps({
      userId: "user_1",
      orgId: "org_acme",
      orgSlug: "acme",
    });
    const ctx = await requireAccount(args(clerkEnv), deps);
    expect(ctx.mode).toBe("clerk");
    expect(ctx.orgId).toBe("org_acme");
    expect(ctx.userId).toBe("user_1");
    expect(ctx.account.name).toBe("Acme Co");
    expect(table.get("org_acme")?.name).toBe("Acme Co");
    expect(deps.fetchOrganizationName).toHaveBeenCalledWith(
      clerkEnv,
      "org_acme",
    );
  });

  it("falls back to the slug when Clerk's API is unavailable", async () => {
    const { deps } = fakeDeps(
      { userId: "user_1", orgId: "org_acme", orgSlug: "acme" },
      [],
      null,
    );
    const ctx = await requireAccount(args(clerkEnv), deps);
    expect(ctx.account.name).toBe("acme");
  });

  it("reuses an existing account without calling Clerk's API", async () => {
    const existing: Account = {
      ...demoAccount,
      id: "acct_existing",
      clerkOrgId: "org_acme",
      name: "Acme (stored)",
    };
    const { deps } = fakeDeps({ userId: "user_1", orgId: "org_acme" }, [
      existing,
    ]);
    const ctx = await requireAccount(args(clerkEnv), deps);
    expect(ctx.account).toBe(existing);
    expect(deps.fetchOrganizationName).not.toHaveBeenCalled();
  });

  it("revives a soft-deleted account when its organization is active again", async () => {
    const deleted: Account = {
      ...demoAccount,
      clerkOrgId: "org_acme",
      name: "Old name",
      deletedAt: new Date(1),
    };
    const { deps, table } = fakeDeps({ userId: "user_1", orgId: "org_acme" }, [
      deleted,
    ]);
    const ctx = await requireAccount(args(clerkEnv), deps);
    expect(ctx.account.deletedAt).toBeNull();
    expect(table.get("org_acme")?.name).toBe("Acme Co");
  });
});

describe("requireUser", () => {
  it("redirects signed-out users and passes signed-in ones through", async () => {
    const out = await thrown(
      requireUser(args(env(), "https://dash.test/app/workspace"), {
        getAuth: async () => ({ userId: null }),
      }),
    );
    expect(out.location).toBe("/sign-in?redirect_url=%2Fapp%2Fworkspace");
    await expect(
      requireUser(args(env()), { getAuth: async () => ({ userId: "u" }) }),
    ).resolves.toEqual({ userId: "u", orgId: null });
  });
});
