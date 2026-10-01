/** Calendar math for the monthly quota; the enforcement is integration-tested. */

import { describe, expect, it } from "vitest";

import { monthStart, secondsToMonthEnd } from "./quota.js";

describe("monthStart", () => {
  it("is the first day of the UTC month as a `date` string", () => {
    expect(monthStart(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10-01");
    expect(monthStart(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10-01");
    expect(monthStart(new Date("2026-01-05T12:00:00Z"))).toBe("2026-01-01");
  });

  it("uses UTC, not local time, at the month boundary", () => {
    // 2026-10-31 23:30 in UTC-5 is already November UTC.
    expect(monthStart(new Date("2026-11-01T04:30:00Z"))).toBe("2026-11-01");
    expect(monthStart(new Date("2026-10-31T23:30:00-05:00"))).toBe(
      "2026-11-01",
    );
  });
});

describe("secondsToMonthEnd", () => {
  it("counts to the first instant of next month, rounding up, never 0", () => {
    expect(secondsToMonthEnd(new Date("2026-10-31T23:59:59Z"))).toBe(1);
    expect(secondsToMonthEnd(new Date("2026-10-31T23:59:59.400Z"))).toBe(1);
    expect(secondsToMonthEnd(new Date("2026-10-31T23:59:00Z"))).toBe(60);
    // Whole of October (31 days) ahead.
    expect(secondsToMonthEnd(new Date("2026-10-01T00:00:00Z"))).toBe(
      31 * 86_400,
    );
    // December rolls into next year.
    expect(secondsToMonthEnd(new Date("2026-12-31T00:00:00Z"))).toBe(86_400);
    expect(secondsToMonthEnd(new Date("2026-11-01T00:00:00Z"))).toBe(
      30 * 86_400,
    );
  });
});
