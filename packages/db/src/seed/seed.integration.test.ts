/**
 * Integration coverage for the demo seed (#20) against a real Postgres via
 * the template-database harness: counts match the fixtures, the seed is
 * idempotent and scoped, every chunk is a verbatim slice with an embedding,
 * window chunks exist, sentiment follows the rating rule, and the keys the
 * summary returns are the ones in the database.
 */

import { hashApiKey, parseApiKey, sentimentFromRating } from "@proofql/core";
import { and, count, sql as dsql, eq, isNotNull, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { account, project, review } from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { isVerbatimSlice } from "../chunks.js";
import { apiKeys } from "../schema/apiKeys.js";
import { reviewChunks } from "../schema/reviewChunks.js";
import { reviews } from "../schema/reviews.js";
import { accounts, projects } from "../schema/tenancy.js";
import {
  DEMO_ACCOUNT_CLERK_ORG_ID,
  DEMO_ACCOUNT_ID,
  DEMO_ALLOWED_ORIGINS,
  DEMO_PROJECT_ID,
  DEMO_PROJECT_SLUG,
  SEED_VERSION,
} from "./constants.js";
import {
  DEMO_LIVE_REVIEWS,
  DEMO_REVIEW_FIXTURES,
  DEMO_TEST_REVIEWS,
  demoExternalId,
} from "./fixtures/reviews.js";
import { demoAccountName, runSeed, type SeedSummary } from "./run.js";

const t = setupTestDb();

async function one(query: Promise<{ n: number }[]>): Promise<number> {
  const [row] = await query;
  return row?.n ?? -1;
}

async function demoCounts() {
  return {
    accounts: await one(
      t.db
        .select({ n: count() })
        .from(accounts)
        .where(eq(accounts.clerkOrgId, DEMO_ACCOUNT_CLERK_ORG_ID)),
    ),
    projects: await one(
      t.db
        .select({ n: count() })
        .from(projects)
        .where(eq(projects.accountId, DEMO_ACCOUNT_ID)),
    ),
    keys: await one(
      t.db
        .select({ n: count() })
        .from(apiKeys)
        .where(eq(apiKeys.projectId, DEMO_PROJECT_ID)),
    ),
    reviews: await one(
      t.db
        .select({ n: count() })
        .from(reviews)
        .where(eq(reviews.projectId, DEMO_PROJECT_ID)),
    ),
    chunks: await one(
      t.db
        .select({ n: count() })
        .from(reviewChunks)
        .where(eq(reviewChunks.projectId, DEMO_PROJECT_ID)),
    ),
  };
}

describe("runSeed", () => {
  let first: SeedSummary;
  let second: SeedSummary;

  it("creates the demo account, project, keys, reviews and chunks", async () => {
    // A bystander tenant that must survive the seed untouched.
    const other = await account(t.db, { clerkOrgId: "org_bystander" });
    const otherProject = await project(t.db, {
      accountId: other.id,
      slug: DEMO_PROJECT_SLUG, // same slug, different account — allowed (#63)
    });
    await review(t.db, { projectId: otherProject.id });

    first = await runSeed(t.db);
    expect(first.seedVersion).toBe(SEED_VERSION);
    expect(first.accountId).toBe(DEMO_ACCOUNT_ID);
    expect(first.projectId).toBe(DEMO_PROJECT_ID);
    expect(first.reviews).toEqual({
      live: DEMO_LIVE_REVIEWS.length,
      test: DEMO_TEST_REVIEWS.length,
    });

    const counts = await demoCounts();
    expect(counts).toEqual({
      accounts: 1,
      projects: 1,
      keys: 4,
      reviews: DEMO_REVIEW_FIXTURES.length,
      chunks: first.chunks.full + first.chunks.window,
    });
    expect(first.chunks.full).toBe(DEMO_REVIEW_FIXTURES.length);
    expect(first.chunks.window).toBeGreaterThan(0);

    const [acct] = await t.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, DEMO_ACCOUNT_ID));
    expect(acct?.name).toBe(demoAccountName());
    expect(acct?.name).toContain(`seed v${SEED_VERSION}`);
    expect(acct?.plan).toBe("free");

    const [proj] = await t.db
      .select()
      .from(projects)
      .where(eq(projects.id, DEMO_PROJECT_ID));
    expect(proj?.slug).toBe(DEMO_PROJECT_SLUG);
    expect(proj?.allowedOrigins).toEqual([...DEMO_ALLOWED_ORIGINS]);
    expect(proj?.reviewCount).toBe(DEMO_LIVE_REVIEWS.length);
    expect(proj?.minRating).toBe(4);
  });

  it("is idempotent: a second run yields the same counts and no duplicates", async () => {
    const before = await demoCounts();
    second = await runSeed(t.db);
    expect(await demoCounts()).toEqual(before);
    expect(second.reviews).toEqual(first.reviews);
    expect(second.chunks).toEqual(first.chunks);

    const dupes = await t.db
      .select({ externalId: reviews.externalId, n: count() })
      .from(reviews)
      .where(eq(reviews.projectId, DEMO_PROJECT_ID))
      .groupBy(reviews.environment, reviews.source, reviews.externalId)
      .having(dsql`count(*) > 1`);
    expect(dupes).toEqual([]);

    // Only the demo account was touched: the bystander still has its rows.
    const bystanders = await t.db
      .select({ n: count() })
      .from(reviews)
      .innerJoin(projects, eq(reviews.projectId, projects.id))
      .innerJoin(accounts, eq(projects.accountId, accounts.id))
      .where(eq(accounts.clerkOrgId, "org_bystander"));
    expect(bystanders[0]?.n).toBe(1);
  });

  it("mints fresh keys each run and stores only their hashes", async () => {
    expect(second.keys.map((k) => `${k.environment}:${k.kind}`).sort()).toEqual(
      ["live:publishable", "live:secret", "test:publishable", "test:secret"],
    );
    // New plaintexts every run...
    expect(second.keys.map((k) => k.plaintext)).not.toEqual(
      first.keys.map((k) => k.plaintext),
    );
    // ...and the rows match the second run's keys exactly.
    const rows = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.projectId, DEMO_PROJECT_ID));
    const hashes = new Set(rows.map((r) => r.keyHash));
    for (const key of second.keys) {
      expect(parseApiKey(key.plaintext)).toEqual({
        kind: key.kind,
        environment: key.environment,
      });
      expect(hashes.has(await hashApiKey(key.plaintext))).toBe(true);
      expect(rows.some((r) => r.prefix === key.prefix)).toBe(true);
    }
    for (const key of first.keys) {
      expect(hashes.has(await hashApiKey(key.plaintext))).toBe(false);
    }
  });

  it("stores every review with its fixture's fields and rating-derived sentiment", async () => {
    const rows = await t.db
      .select()
      .from(reviews)
      .where(eq(reviews.projectId, DEMO_PROJECT_ID));
    const byKey = new Map(
      rows.map((r) => [`${r.environment}:${r.externalId}`, r]),
    );
    for (const fixture of DEMO_REVIEW_FIXTURES) {
      const row = byKey.get(
        `${fixture.environment}:${demoExternalId(fixture)}`,
      );
      expect(row, fixture.key).toBeDefined();
      if (!row) continue;
      expect(row.text).toBe(fixture.text);
      expect(row.source).toBe(fixture.source);
      expect(row.rating).toBe(fixture.rating);
      expect(row.authorName).toBe(fixture.authorName);
      expect(row.metadata).toEqual({ location: fixture.location });
      expect(row.indexedAt).not.toBeNull();
      expect(row.hiddenAt).toBeNull();
      expect(row.occurredAt).not.toBeNull();
      if (fixture.rating !== null) {
        expect(row.sentiment).toBe(sentimentFromRating(fixture.rating));
        expect(row.sentimentSource).toBe("rating");
      } else {
        expect(row.sentiment).toBe(fixture.sentiment);
        expect(row.sentimentSource).toBe("model");
      }
    }
  });

  it("gives the policy gate something to exclude in the live environment", async () => {
    const low = await one(
      t.db
        .select({ n: count() })
        .from(reviews)
        .where(
          and(
            eq(reviews.projectId, DEMO_PROJECT_ID),
            eq(reviews.environment, "live"),
            dsql`${reviews.rating} <= 3`,
          ),
        ),
    );
    expect(low).toBeGreaterThanOrEqual(8);
    const unratedNegative = await one(
      t.db
        .select({ n: count() })
        .from(reviews)
        .where(
          and(
            eq(reviews.projectId, DEMO_PROJECT_ID),
            eq(reviews.environment, "live"),
            isNull(reviews.rating),
            eq(reviews.sentiment, "negative"),
          ),
        ),
    );
    expect(unratedNegative).toBe(2);
  });

  it("writes only verbatim chunks, one full per review plus windows for long ones", async () => {
    const rows = await t.db
      .select({
        kind: reviewChunks.kind,
        text: reviewChunks.text,
        startOffset: reviewChunks.startOffset,
        environment: reviewChunks.environment,
        reviewEnvironment: reviews.environment,
        reviewText: reviews.text,
        reviewId: reviews.id,
      })
      .from(reviewChunks)
      .innerJoin(reviews, eq(reviewChunks.reviewId, reviews.id))
      .where(eq(reviewChunks.projectId, DEMO_PROJECT_ID));

    expect(rows.length).toBe(second.chunks.full + second.chunks.window);
    for (const row of rows) {
      expect(isVerbatimSlice({ text: row.reviewText }, row)).toBe(true);
      expect(row.environment).toBe(row.reviewEnvironment);
    }

    const fullPerReview = new Map<string, number>();
    for (const row of rows.filter((r) => r.kind === "full")) {
      expect(row.startOffset).toBe(0);
      expect(row.text).toBe(row.reviewText);
      fullPerReview.set(
        row.reviewId,
        (fullPerReview.get(row.reviewId) ?? 0) + 1,
      );
    }
    expect(fullPerReview.size).toBe(DEMO_REVIEW_FIXTURES.length);
    expect([...fullPerReview.values()].every((n) => n === 1)).toBe(true);

    const windows = rows.filter((r) => r.kind === "window");
    expect(windows.length).toBeGreaterThan(0);
    expect(new Set(windows.map((w) => w.reviewId)).size).toBeGreaterThanOrEqual(
      1,
    );
    for (const w of windows) {
      expect(w.text.length).toBeLessThan(w.reviewText.length);
    }
  });

  it("embeds every chunk with a 1024-dim unit vector", async () => {
    const missing = await one(
      t.db
        .select({ n: count() })
        .from(reviewChunks)
        .where(
          and(
            eq(reviewChunks.projectId, DEMO_PROJECT_ID),
            isNull(reviewChunks.embedding),
          ),
        ),
    );
    expect(missing).toBe(0);

    const live = await one(
      t.db
        .select({ n: count() })
        .from(reviewChunks)
        .where(
          and(
            eq(reviewChunks.projectId, DEMO_PROJECT_ID),
            eq(reviewChunks.environment, "live"),
            isNotNull(reviewChunks.embedding),
          ),
        ),
    );
    expect(live).toBeGreaterThanOrEqual(DEMO_LIVE_REVIEWS.length);

    const [sample] = await t.db
      .select({ embedding: reviewChunks.embedding })
      .from(reviewChunks)
      .where(eq(reviewChunks.projectId, DEMO_PROJECT_ID))
      .limit(1);
    expect(sample?.embedding).toHaveLength(1024);
    const norm = Math.sqrt(
      (sample?.embedding ?? []).reduce((acc, v) => acc + v * v, 0),
    );
    expect(norm).toBeCloseTo(1, 2);
  });
});
