// Onboarding writes against the real schema (#53): one transaction creates
// the project and both live keys and stores only hashes; the suggested
// query comes from the project's full chunks; the completion flag is set
// once; the cookie session round-trips and expires the plaintexts.
import { API_KEY_PATTERN, hashApiKey } from "@proofql/core";
import { account, chunk, project, review, setupTestDb } from "@proofql/db/test";
import { describe, expect, it } from "vitest";

import { MIN_REVIEWS_FOR_SUGGESTION } from "./onboarding";
import {
  commitOnboardingSession,
  markOnboardingCompleted,
  projectIndexing,
  readOnboardingSession,
  sessionKeysFor,
  startOnboardingProject,
  suggestQuery,
} from "./onboarding.server";

const t = setupTestDb();

describe("startOnboardingProject", () => {
  it("creates the project, allows the origin, and mints both live keys — hashes only", async () => {
    const a = await account(t.db);
    const result = await startOnboardingProject(t.db, {
      account: a,
      name: "Cedar Ridge Dental",
      slug: "cedar-ridge-dental",
      origin: "http://localhost:8799",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.project).toMatchObject({
      accountId: a.id,
      slug: "cedar-ridge-dental",
      allowedOrigins: ["http://localhost:8799"],
      reviewCount: 0,
    });
    expect(result.publishable.plaintext).toMatch(API_KEY_PATTERN);
    expect(result.publishable.plaintext.startsWith("pq_pk_live_")).toBe(true);
    expect(result.secret.plaintext.startsWith("pq_sk_live_")).toBe(true);

    const rows = await t.sql<
      { kind: string; environment: string; key_hash: string; prefix: string }[]
    >`SELECT kind, environment, key_hash, prefix FROM api_keys WHERE project_id = ${result.project.id} ORDER BY kind::text`;
    expect(rows.map((r) => [r.kind, r.environment])).toEqual([
      ["publishable", "live"],
      ["secret", "live"],
    ]);
    // Only the SHA-256 of each plaintext is stored; the plaintext never is.
    expect(rows[0]?.key_hash).toBe(
      await hashApiKey(result.publishable.plaintext),
    );
    expect(rows[1]?.key_hash).toBe(await hashApiKey(result.secret.plaintext));
    for (const row of rows) {
      expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.key_hash).not.toContain(result.secret.plaintext);
      expect(
        result.secret.plaintext.startsWith(row.prefix) ||
          result.publishable.plaintext.startsWith(row.prefix),
      ).toBe(true);
    }
    const everywhere = await t.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM api_keys WHERE key_hash IN (${result.secret.plaintext}, ${result.publishable.plaintext}) OR prefix IN (${result.secret.plaintext}, ${result.publishable.plaintext})`;
    expect(everywhere[0]?.n).toBe(0);
  });

  it("is all or nothing: a slug conflict leaves no project and no keys", async () => {
    const a = await account(t.db, { plan: "paid" }); // room for a second project
    await project(t.db, { accountId: a.id, slug: "taken" });
    const before = await t.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM api_keys`;
    const result = await startOnboardingProject(t.db, {
      account: a,
      name: "Taken",
      slug: "taken",
    });
    expect(result).toEqual({ ok: false, reason: "slug_taken" });
    const after = await t.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM api_keys`;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("reports the plan limit without writing", async () => {
    const a = await account(t.db); // free: one project
    await project(t.db, { accountId: a.id });
    const result = await startOnboardingProject(t.db, {
      account: a,
      name: "Second",
      slug: "second",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("plan_limit");
  });
});

describe("suggestQuery", () => {
  it("derives a two-word query from the project's live full chunks once enough are indexed", async () => {
    const p = await project(t.db);
    const texts = [
      ...Array.from({ length: MIN_REVIEWS_FOR_SUGGESTION - 1 }, (_, i) =>
        i % 2 === 0
          ? `Dr. Patel did my implant and parking was easy (${i}).`
          : `The implant consult with Dr. Patel was thorough; parking was easy (${i}).`,
      ),
      "Whitening was quick.",
    ];
    for (const [i, text] of texts.entries()) {
      const r = await review(t.db, {
        projectId: p.id,
        text,
        externalId: `s-${i}`,
      });
      await chunk(t.db, { reviewId: r.id, kind: "full" });
      // Window chunks must not double-count a review.
      await chunk(t.db, {
        reviewId: r.id,
        kind: "window",
        text: text.slice(0, 10),
        startOffset: 0,
      });
    }
    // A test-environment review is not the live corpus.
    const test = await review(t.db, {
      projectId: p.id,
      environment: "test",
      text: "zzz zzz zzz",
      externalId: "t-1",
    });
    await chunk(t.db, { reviewId: test.id, kind: "full" });

    expect(await suggestQuery(t.db, p.id)).toBe("implant parking");
    const empty = await project(t.db);
    expect(await suggestQuery(t.db, empty.id)).toBeNull();
  });

  it("suggests nothing below MIN_REVIEWS_FOR_SUGGESTION indexed reviews (#106)", async () => {
    const p = await project(t.db);
    const texts = [
      "Dr. Patel did my implant and parking was easy.",
      "The implant consult with Dr. Patel was thorough; parking was easy.",
      "Implant healed fast. Parking behind the building.",
      "Whitening was quick.",
    ];
    for (const [i, text] of texts.entries()) {
      const r = await review(t.db, {
        projectId: p.id,
        text,
        externalId: `s-${i}`,
      });
      await chunk(t.db, { reviewId: r.id, kind: "full" });
    }
    expect(await suggestQuery(t.db, p.id)).toBeNull();
  });
});

describe("projectIndexing", () => {
  it("counts live reviews by indexed_at", async () => {
    const p = await project(t.db);
    await review(t.db, {
      projectId: p.id,
      externalId: "a",
      indexedAt: new Date(),
    });
    await review(t.db, {
      projectId: p.id,
      externalId: "b",
      indexedAt: new Date(),
    });
    await review(t.db, { projectId: p.id, externalId: "c" });
    await review(t.db, {
      projectId: p.id,
      externalId: "d",
      environment: "test",
    });
    expect(await projectIndexing(t.db, p.id)).toEqual({
      reviews: 3,
      indexed: 2,
      indexing: 1,
    });
  });
});

describe("markOnboardingCompleted", () => {
  it("sets the flag once and keeps the first time", async () => {
    const a = await account(t.db);
    expect(a.onboardingCompletedAt).toBeNull();
    await markOnboardingCompleted(t.db, a.id);
    // Read through drizzle so the column comes back typed.
    const first = await t.db.query.accounts.findFirst({
      where: (acc, { eq }) => eq(acc.id, a.id),
    });
    expect(first?.onboardingCompletedAt).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 5));
    await markOnboardingCompleted(t.db, a.id);
    const second = await t.db.query.accounts.findFirst({
      where: (acc, { eq }) => eq(acc.id, a.id),
    });
    expect(second?.onboardingCompletedAt?.getTime()).toBe(
      first?.onboardingCompletedAt?.getTime(),
    );
  });
});

describe("the onboarding cookie", () => {
  const env = { ENVIRONMENT: "local" };

  it("round-trips the keys for its project only, as a signed one-hour cookie", async () => {
    const session = await readOnboardingSession(
      env,
      new Request("https://dash.test/"),
    );
    session.set("projectId", "p1");
    session.set("publishable", "pq_pk_live_a");
    session.set("secret", "pq_sk_live_b");
    const headers = await commitOnboardingSession(env, session);
    const cookie = headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("__pq_onboarding=");
    expect(cookie).toContain("Max-Age=3600");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("pq_pk_live_a"); // encoded and signed, not plain

    const back = await readOnboardingSession(
      env,
      new Request("https://dash.test/", {
        headers: { Cookie: cookie.split(";")[0] ?? "" },
      }),
    );
    expect(sessionKeysFor(back, "p1")).toEqual({
      publishable: "pq_pk_live_a",
      secret: "pq_sk_live_b",
    });
    expect(sessionKeysFor(back, "other")).toEqual({
      publishable: null,
      secret: null,
    });
  });
});
