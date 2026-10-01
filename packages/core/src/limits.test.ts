import { describe, expect, it } from "vitest";

import {
  PLAN_QUERY_LIMITS,
  PLAN_REVIEW_LIMITS,
  queryLimitForPlan,
  reviewLimitForPlan,
} from "./limits.js";

describe("plan limits", () => {
  it("reviewLimitForPlan: known plans, free fallback for unknown", () => {
    expect(reviewLimitForPlan("free")).toBe(PLAN_REVIEW_LIMITS.free);
    expect(reviewLimitForPlan("paid")).toBe(PLAN_REVIEW_LIMITS.paid);
    expect(reviewLimitForPlan("enterprise")).toBe(PLAN_REVIEW_LIMITS.free);
  });

  it("queryLimitForPlan: scope.md §2 numbers, free fallback for unknown", () => {
    expect(queryLimitForPlan("free")).toBe(50_000);
    expect(queryLimitForPlan("paid")).toBe(PLAN_QUERY_LIMITS.paid);
    expect(queryLimitForPlan("")).toBe(50_000);
    expect(queryLimitForPlan("toString")).toBe(50_000);
  });
});
