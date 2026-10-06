import { describe, expect, it } from "vitest";

import { jobsDueAt, tickAt } from "./schedule.js";

const at = (hhmm: string) => new Date(`2026-10-05T${hhmm}:00.000Z`);

describe("jobsDueAt (#174: one cron, jobs picked by time of day)", () => {
  it("00:00 runs the sweep and the Google poll", () => {
    expect(jobsDueAt(at("00:00"))).toEqual(["sweep", "google_poll"]);
  });

  it("06:00, 12:00 and 18:00 run the Google poll too", () => {
    for (const t of ["06:00", "12:00", "18:00"]) {
      expect(jobsDueAt(at(t)), t).toEqual(["sweep", "google_poll"]);
    }
    expect(jobsDueAt(at("03:00"))).toEqual(["sweep"]);
  });

  it("03:30 runs the sweep and the Places refresh", () => {
    expect(jobsDueAt(at("03:30"))).toEqual(["sweep", "places_refresh"]);
  });

  it("04:15 runs the sweep and the account purge", () => {
    expect(jobsDueAt(at("04:15"))).toEqual(["sweep", "account_purge"]);
  });

  it("rounds a late tick down to the five-minute boundary", () => {
    expect(jobsDueAt(at("04:16"))).toEqual(["sweep", "account_purge"]);
    expect(jobsDueAt(at("04:17"))).toEqual(["sweep", "account_purge"]);
    expect(jobsDueAt(new Date("2026-10-05T04:19:59.999Z"))).toEqual([
      "sweep",
      "account_purge",
    ]);
    expect(jobsDueAt(at("04:20"))).toEqual(["sweep"]);
    expect(jobsDueAt(at("00:04"))).toEqual(["sweep", "google_poll"]);
  });

  it("12:05 runs the sweep only", () => {
    expect(jobsDueAt(at("12:05"))).toEqual(["sweep"]);
  });

  it("accepts epoch ms (controller.scheduledTime)", () => {
    expect(jobsDueAt(at("03:32").getTime())).toEqual([
      "sweep",
      "places_refresh",
    ]);
    expect(tickAt(at("03:32").getTime()).toISOString()).toBe(
      "2026-10-05T03:30:00.000Z",
    );
  });
});
