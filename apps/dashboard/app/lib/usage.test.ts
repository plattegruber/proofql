import { PLANS } from "@proofql/core";
import { describe, expect, it } from "vitest";

import { meteredLimits, usagePercent, usageTone } from "./usage";

describe("usagePercent", () => {
  it("rounds to whole percents and clamps to 0–100", () => {
    expect(usagePercent(0, 5_000)).toBe(0);
    expect(usagePercent(80, 5_000)).toBe(2);
    expect(usagePercent(2_500, 5_000)).toBe(50);
    expect(usagePercent(4_999, 5_000)).toBe(100);
    expect(usagePercent(6_000, 5_000)).toBe(100);
    expect(usagePercent(-1, 5_000)).toBe(0);
    expect(usagePercent(1, 0)).toBe(100);
  });
});

describe("usageTone", () => {
  it("is normal below 80 %, caution from 80 %, full at the limit", () => {
    expect(usageTone(0, 100)).toBe("normal");
    expect(usageTone(79, 100)).toBe("normal");
    expect(usageTone(80, 100)).toBe("caution");
    expect(usageTone(99, 100)).toBe("caution");
    expect(usageTone(100, 100)).toBe("full");
    expect(usageTone(101, 100)).toBe("full");
  });
});

describe("meteredLimits", () => {
  it("reads PLANS, free for unknown plans", () => {
    expect(meteredLimits("free")).toEqual({
      reviewsPerProject: PLANS.free.reviewsPerProject,
      queriesPerMonth: PLANS.free.queriesPerMonth,
    });
    expect(meteredLimits("paid").queriesPerMonth).toBe(
      PLANS.paid.queriesPerMonth,
    );
    expect(meteredLimits("gold")).toEqual(meteredLimits("free"));
  });
});
