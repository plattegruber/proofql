// Project writes against the real schema: the per-account slug constraint,
// the plan's project allowance, policy updates reporting whether the policy
// changed, the origins list, and the cascade on delete. The Settings
// action's cache bump is covered end to end in
// app.projects.$slug.settings.integration.test.ts.
import { PLAN_PROJECT_LIMITS } from "@proofql/core";
import {
  account,
  apiKey,
  project,
  review,
  setupTestDb,
} from "@proofql/db/test";
import { describe, expect, it } from "vitest";

import {
  createProject,
  deleteProject,
  projectQuota,
  setAllowedOrigins,
  updateProjectSettings,
} from "./projects.server";

const t = setupTestDb();

describe("createProject", () => {
  it("creates with policy defaults and the badge derived from the plan", async () => {
    const a = await account(t.db, { plan: "paid" });
    const result = await createProject(t.db, {
      account: a,
      name: "Website",
      slug: "website",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project).toMatchObject({
      accountId: a.id,
      slug: "website",
      minRating: 4,
      similarityFloor: 0.55,
      allowedOrigins: [],
      showBadge: false,
      reviewCount: 0,
    });

    const free = await account(t.db);
    const onFree = await createProject(t.db, {
      account: free,
      name: "Shop",
      slug: "shop",
    });
    expect(onFree.ok && onFree.project.showBadge).toBe(true);
  });

  it("enforces slug uniqueness per account, not globally", async () => {
    const a = await account(t.db, { plan: "paid" });
    const b = await account(t.db, { plan: "paid" });
    expect(
      (await createProject(t.db, { account: a, name: "x", slug: "website" }))
        .ok,
    ).toBe(true);
    expect(
      await createProject(t.db, { account: a, name: "y", slug: "website" }),
    ).toEqual({ ok: false, reason: "slug_taken" });
    // The same slug in another account is fine.
    expect(
      (await createProject(t.db, { account: b, name: "z", slug: "website" }))
        .ok,
    ).toBe(true);
  });

  it("stops at the free plan's one project and reports the quota", async () => {
    const free = await account(t.db);
    expect(PLAN_PROJECT_LIMITS.free).toBe(1);
    expect(await projectQuota(t.db, free)).toEqual({
      used: 0,
      limit: 1,
      atLimit: false,
    });

    const first = await createProject(t.db, {
      account: free,
      name: "One",
      slug: "one",
    });
    expect(first.ok).toBe(true);

    const second = await createProject(t.db, {
      account: free,
      name: "Two",
      slug: "two",
    });
    expect(second).toEqual({
      ok: false,
      reason: "plan_limit",
      quota: { used: 1, limit: 1, atLimit: true },
    });
    expect(await projectQuota(t.db, free)).toMatchObject({ atLimit: true });

    // Paid accounts are not capped at one.
    const paid = await account(t.db, { plan: "paid" });
    for (const slug of ["a", "b", "c"]) {
      expect(
        (await createProject(t.db, { account: paid, name: slug, slug })).ok,
      ).toBe(true);
    }
  });
});

describe("updateProjectSettings", () => {
  it("saves name/slug/policy and reports whether the policy changed", async () => {
    const p = await project(t.db, { slug: "before" });
    const ids = { projectId: p.id, accountId: p.accountId };

    const renamed = await updateProjectSettings(t.db, ids, {
      name: "Renamed",
      slug: "after",
      minRating: p.minRating,
      similarityFloor: p.similarityFloor,
    });
    expect(renamed.ok && renamed.policyChanged).toBe(false);
    expect(renamed.ok && renamed.project.slug).toBe("after");

    const policy = await updateProjectSettings(t.db, ids, {
      name: "Renamed",
      slug: "after",
      minRating: 3,
      similarityFloor: 0.6,
    });
    expect(policy.ok && policy.policyChanged).toBe(true);
    expect(policy.ok && policy.project).toMatchObject({
      minRating: 3,
      similarityFloor: 0.6,
    });
  });

  it("reports a taken slug and refuses another account's project", async () => {
    const a = await account(t.db, { plan: "paid" });
    const p1 = await project(t.db, { accountId: a.id, slug: "one" });
    await project(t.db, { accountId: a.id, slug: "two" });
    const settings = {
      name: "One",
      minRating: 4,
      similarityFloor: 0.55,
    };
    expect(
      await updateProjectSettings(
        t.db,
        { projectId: p1.id, accountId: a.id },
        { ...settings, slug: "two" },
      ),
    ).toEqual({ ok: false, reason: "slug_taken" });

    const stranger = await account(t.db);
    expect(
      await updateProjectSettings(
        t.db,
        { projectId: p1.id, accountId: stranger.id },
        { ...settings, slug: "stolen" },
      ),
    ).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("setAllowedOrigins / deleteProject", () => {
  it("replaces the origins list, scoped to the account", async () => {
    const p = await project(t.db);
    const ids = { projectId: p.id, accountId: p.accountId };
    const updated = await setAllowedOrigins(t.db, ids, [
      "https://a.example",
      "http://localhost:3000",
    ]);
    expect(updated?.allowedOrigins).toEqual([
      "https://a.example",
      "http://localhost:3000",
    ]);
    const stranger = await account(t.db);
    expect(
      await setAllowedOrigins(
        t.db,
        { projectId: p.id, accountId: stranger.id },
        [],
      ),
    ).toBeUndefined();
  });

  it("deletes the project and cascades to its keys and reviews", async () => {
    const p = await project(t.db);
    await apiKey(t.db, { projectId: p.id });
    await review(t.db, { projectId: p.id });
    const ids = { projectId: p.id, accountId: p.accountId };

    const stranger = await account(t.db);
    expect(
      await deleteProject(t.db, { projectId: p.id, accountId: stranger.id }),
    ).toBeUndefined();

    const deleted = await deleteProject(t.db, ids);
    expect(deleted?.id).toBe(p.id);
    const [keys] = await t.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM api_keys WHERE project_id = ${p.id}`;
    const [reviews] = await t.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM reviews WHERE project_id = ${p.id}`;
    expect(keys?.n).toBe(0);
    expect(reviews?.n).toBe(0);
    expect(await deleteProject(t.db, ids)).toBeUndefined();
  });
});
