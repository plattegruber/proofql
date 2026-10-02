// The onboarding routes end to end against the real schema, in the local
// auth stub pointed at a fresh account through AUTH_STUB_ORG_ID (#53):
// the overview redirects an empty account to /app/onboarding; step 1's
// action creates the project and both live keys in one go and carries the
// plaintexts in the onboarding cookie; finishing sets the completion flag
// and the overview stops redirecting; dismissing does the same.
import { account, setupTestDb } from "@proofql/db/test";
import { beforeAll, describe, expect, it } from "vitest";

import { createLoadContext } from "~/lib/context";
import { readOnboardingSession, sessionKeysFor } from "~/lib/onboarding.server";
import { loader as overviewLoader } from "./app._index";
import { action as startAction, loader as startLoader } from "./app.onboarding";
import { action as finishAction } from "./app.onboarding.$slug.snippet";

const t = setupTestDb();

let orgId: string;
beforeAll(async () => {
  const fresh = await account(t.db, { clerkOrgId: "org_onboarding_fresh" });
  orgId = fresh.clerkOrgId;
});

function testEnv(): Env {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${t.databaseName}`;
  return {
    ENVIRONMENT: "local",
    API_URL: "http://localhost:8797",
    SNIPPET_SRC: "http://localhost:8800/v1.js",
    AUTH_STUB_ORG_ID: orgId,
    CLERK_PUBLISHABLE_KEY: "",
    CLERK_SECRET_KEY: "",
    CLERK_WEBHOOK_SIGNING_SECRET: "",
    SESSION_SECRET: "",
    HYPERDRIVE: { connectionString: url.toString() } as Hyperdrive,
  } as Env;
}

function call<T>(
  fn: (args: never) => Promise<T>,
  request: Request,
  params: Record<string, string> = {},
) {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return fn({
    request,
    params,
    context: createLoadContext({ env: testEnv(), ctx }),
  } as never).finally(() => Promise.all(pending));
}

async function redirected(p: Promise<unknown>): Promise<Response | null> {
  try {
    const r = await p;
    return r instanceof Response ? r : null;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

function cookieFrom(response: Response): string {
  return (response.headers.get("Set-Cookie") ?? "")
    .split(/,(?=\s*__pq_)/)
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
}

describe("onboarding routes", () => {
  it("sends an account with no projects and no completion flag to /app/onboarding", async () => {
    const r = await redirected(
      call(overviewLoader, new Request("https://dash.test/app")),
    );
    expect(r?.status).toBe(302);
    expect(r?.headers.get("Location")).toBe("/app/onboarding");
  });

  it("step 1 creates the project and both live keys in one action and carries the plaintexts in the cookie", async () => {
    // Showing step 1 starts the clock in the cookie.
    const shown = (await call(
      startLoader,
      new Request("https://dash.test/app/onboarding"),
    )) as { init?: ResponseInit };
    const startCookie = cookieFrom(new Response(null, shown.init));
    expect(startCookie).toContain("__pq_onboarding=");

    const body = new URLSearchParams({
      name: "Cedar Ridge Dental",
      slug: "cedar-ridge-dental",
    });
    const r = await redirected(
      call(
        startAction,
        new Request("https://dash.test/app/onboarding", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            Cookie: startCookie,
          },
          body,
        }),
      ),
    );
    expect(r?.status).toBe(302);
    expect(r?.headers.get("Location")).toBe(
      "/app/onboarding/cedar-ridge-dental/reviews",
    );

    const [project] = await t.sql<
      { id: string; allowed_origins: string[] }[]
    >`SELECT id, allowed_origins FROM projects WHERE slug = 'cedar-ridge-dental'`;
    expect(project?.allowed_origins).toEqual(["https://dash.test"]);
    const keys = await t.sql<
      { kind: string; environment: string; key_hash: string }[]
    >`SELECT kind, environment, key_hash FROM api_keys WHERE project_id = ${project?.id ?? ""} ORDER BY kind::text`;
    expect(keys.map((k) => `${k.kind}/${k.environment}`)).toEqual([
      "publishable/live",
      "secret/live",
    ]);

    // The cookie holds the plaintexts for this project; the hashes match them.
    const cookie = cookieFrom(r as Response);
    const session = await readOnboardingSession(
      testEnv(),
      new Request("https://dash.test/", { headers: { Cookie: cookie } }),
    );
    const { publishable, secret } = sessionKeysFor(session, project?.id ?? "");
    expect(publishable?.startsWith("pq_pk_live_")).toBe(true);
    expect(secret?.startsWith("pq_sk_live_")).toBe(true);
    expect(session.get("startedAt")).toBeTruthy();
    for (const k of keys) {
      expect(k.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect([publishable, secret]).not.toContain(k.key_hash);
    }

    // Finishing sets the flag, clears the cookie, opens the playground.
    const done = await redirected(
      call(
        finishAction,
        new Request(
          "https://dash.test/app/onboarding/cedar-ridge-dental/snippet",
          {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              Cookie: cookie,
            },
            body: new URLSearchParams({ intent: "finish" }),
          },
        ),
        { slug: "cedar-ridge-dental" },
      ),
    );
    expect(done?.status).toBe(302);
    expect(done?.headers.get("Location")).toBe(
      "/app/projects/cedar-ridge-dental/playground",
    );
    const setCookie = done?.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("__pq_flash=");
    expect(setCookie).toMatch(/__pq_onboarding=;|__pq_onboarding=.*Max-Age=0/);
    const row = await t.db.query.accounts.findFirst({
      where: (acc, { eq }) => eq(acc.clerkOrgId, orgId),
    });
    expect(row?.onboardingCompletedAt).toBeInstanceOf(Date);

    // With a project the overview renders instead of redirecting.
    const overview = (await call(
      overviewLoader,
      new Request("https://dash.test/app"),
    )) as { projects: unknown[] };
    expect(overview.projects).toHaveLength(1);
  });

  it("dismissing (?skip=1) marks the account done so the overview renders with zero projects", async () => {
    const dismissed = await account(t.db, {
      clerkOrgId: "org_onboarding_skip",
    });
    const env = { ...testEnv(), AUTH_STUB_ORG_ID: dismissed.clerkOrgId } as Env;
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const args = (url: string) =>
      ({
        request: new Request(url),
        params: {},
        context: createLoadContext({ env, ctx }),
      }) as never;

    const skip = await redirected(
      startLoader(args("https://dash.test/app/onboarding?skip=1")),
    );
    expect(skip?.status).toBe(302);
    expect(skip?.headers.get("Location")).toBe("/app");
    expect(skip?.headers.get("Set-Cookie")).toContain("__pq_flash=");

    const overview = (await overviewLoader(args("https://dash.test/app"))) as {
      projects: unknown[];
    };
    expect(overview.projects).toEqual([]);
  });
});
