import { describe, expect, it } from "vitest";

import {
  PLAN_PROJECT_LIMITS,
  PLAN_QUERY_LIMITS,
  PLAN_REVIEW_LIMITS,
  projectLimitForPlan,
  queryLimitForPlan,
  reviewLimitForPlan,
} from "./limits.js";
import {
  isPlan,
  normalizePlan,
  PLAN_NAMES,
  PLANS,
  PRICING_URL,
  planFor,
  planLabel,
  planTableJson,
  planTableMarkdown,
  planTableRows,
} from "./plans.js";

describe("PLANS", () => {
  it("carries the scope.md §2 free-tier numbers", () => {
    expect(PLANS.free).toEqual({
      projects: 1,
      reviewsPerProject: 5_000,
      queriesPerMonth: 50_000,
      badge: true,
      rateLimits: { secret: 300, publishable: 120 },
    });
  });

  it("paid raises every limit and removes the badge", () => {
    expect(PLANS.paid.badge).toBe(false);
    expect(PLANS.paid.projects).toBeGreaterThan(PLANS.free.projects);
    expect(PLANS.paid.reviewsPerProject).toBeGreaterThan(
      PLANS.free.reviewsPerProject,
    );
    expect(PLANS.paid.queriesPerMonth).toBeGreaterThan(
      PLANS.free.queriesPerMonth,
    );
    expect(PLANS.paid.rateLimits.secret).toBeGreaterThan(
      PLANS.free.rateLimits.secret,
    );
    expect(PLANS.paid.rateLimits.publishable).toBeGreaterThan(
      PLANS.free.rateLimits.publishable,
    );
  });

  it("names exactly the plans the database enum knows", () => {
    expect(PLAN_NAMES).toEqual(["free", "paid"]);
    expect(Object.keys(PLANS)).toEqual([...PLAN_NAMES]);
  });

  it("the pricing placeholder is an absolute https URL", () => {
    expect(PRICING_URL).toMatch(/^https:\/\/proofql\.com\//);
  });
});

describe("planFor", () => {
  it("resolves known plans and falls back to free for anything else", () => {
    expect(planFor("free")).toBe(PLANS.free);
    expect(planFor("paid")).toBe(PLANS.paid);
    expect(planFor("enterprise")).toBe(PLANS.free);
    expect(planFor("")).toBe(PLANS.free);
    // An inherited property name must not leak through as a plan.
    expect(planFor("toString")).toBe(PLANS.free);
    expect(planFor("constructor")).toBe(PLANS.free);
  });

  it("isPlan / normalizePlan / planLabel agree with it", () => {
    expect(isPlan("paid")).toBe(true);
    expect(isPlan("hasOwnProperty")).toBe(false);
    expect(normalizePlan("paid")).toBe("paid");
    expect(normalizePlan("gold")).toBe("free");
    expect(planLabel("free")).toBe("Free");
    expect(planLabel("paid")).toBe("Paid");
    expect(planLabel("gold")).toBe("gold");
  });
});

describe("plan table for the docs site", () => {
  it("renders every limit for both plans from PLANS", () => {
    const rows = planTableRows();
    expect(rows.map((r) => r.limit)).toEqual([
      "Projects",
      "Reviews per project",
      "Queries per month (cached hits are free)",
      "Rate limit, secret key",
      "Rate limit, publishable key",
      "Snippet badge",
    ]);
    expect(rows[1]).toEqual({
      limit: "Reviews per project",
      free: "5,000",
      paid: "100,000",
    });
    expect(rows[5]).toEqual({
      limit: "Snippet badge",
      free: "Shown",
      paid: "Removable",
    });
  });

  it("markdown is a GFM table with one row per limit", () => {
    const md = planTableMarkdown().split("\n");
    expect(md[0]).toBe("| Limit | Free | Paid |");
    expect(md[1]).toBe("|---|---|---|");
    expect(md).toHaveLength(2 + planTableRows().length);
    expect(md).toContain(
      "| Queries per month (cached hits are free) | 50,000 | 2,000,000 |",
    );
  });

  it("json round-trips to PLANS", () => {
    expect(JSON.parse(planTableJson())).toEqual(PLANS);
  });
});

describe("deprecated limits.ts wrappers mirror PLANS", () => {
  it("tables", () => {
    expect(PLAN_REVIEW_LIMITS).toEqual({ free: 5_000, paid: 100_000 });
    expect(PLAN_QUERY_LIMITS).toEqual({ free: 50_000, paid: 2_000_000 });
    expect(PLAN_PROJECT_LIMITS).toEqual({ free: 1, paid: 50 });
  });

  it("functions, including the free fallback", () => {
    expect(reviewLimitForPlan("paid")).toBe(PLANS.paid.reviewsPerProject);
    expect(reviewLimitForPlan("enterprise")).toBe(PLANS.free.reviewsPerProject);
    expect(queryLimitForPlan("free")).toBe(PLANS.free.queriesPerMonth);
    expect(queryLimitForPlan("toString")).toBe(PLANS.free.queriesPerMonth);
    expect(projectLimitForPlan("paid")).toBe(PLANS.paid.projects);
    expect(projectLimitForPlan("")).toBe(PLANS.free.projects);
  });
});
