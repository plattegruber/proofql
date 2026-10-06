// The pure parts of the Places refresh (#116): the candidate query's inputs
// (cutoffs, limit), the reconcile plan over stored vs returned review names,
// the run note, and the "did anything change" rule. No services.
import { describe, expect, it } from "vitest";

import {
  PLACES_REFRESH_AFTER_DAYS,
  PLACES_REFRESH_LIMIT,
  PLACES_REFRESH_RETRY_FAILED_AFTER_DAYS,
  planReconcile,
  refreshChanged,
  refreshNote,
  refreshWindow,
} from "./places-refresh.js";

const NOW = new Date("2026-10-03T03:30:00.000Z");
const DAY_MS = 86_400_000;

describe("refreshWindow (candidate selection inputs)", () => {
  it("is 25 days for a good run, a day for a failed one, 200 per tick", () => {
    expect(PLACES_REFRESH_AFTER_DAYS).toBe(25);
    expect(PLACES_REFRESH_RETRY_FAILED_AFTER_DAYS).toBe(1);
    expect(PLACES_REFRESH_LIMIT).toBe(200);

    const w = refreshWindow(NOW);
    expect(w.succeededBefore.toISOString()).toBe("2026-09-08T03:30:00.000Z");
    expect(NOW.getTime() - w.succeededBefore.getTime()).toBe(25 * DAY_MS);
    expect(NOW.getTime() - w.failedBefore.getTime()).toBe(DAY_MS);
    expect(w.limit).toBe(200);
  });

  it("takes overrides and floors the limit at a whole non-negative number", () => {
    const w = refreshWindow(NOW, {
      afterDays: 10,
      retryFailedAfterDays: 2,
      limit: 7.9,
    });
    expect(NOW.getTime() - w.succeededBefore.getTime()).toBe(10 * DAY_MS);
    expect(NOW.getTime() - w.failedBefore.getTime()).toBe(2 * DAY_MS);
    expect(w.limit).toBe(7);
    expect(refreshWindow(NOW, { limit: -3 }).limit).toBe(0);
    expect(refreshWindow(NOW, { limit: undefined }).limit).toBe(200);
  });

  it("places a 26-day-old run inside the window and a 10-day-old one outside", () => {
    const w = refreshWindow(NOW);
    const ranAt = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
    expect(ranAt(26) < w.succeededBefore).toBe(true);
    expect(ranAt(10) < w.succeededBefore).toBe(false);
    expect(ranAt(25) < w.succeededBefore).toBe(false); // strictly more than
    // A failed run yesterday-and-a-bit is due; one from an hour ago is not.
    expect(ranAt(1.1) < w.failedBefore).toBe(true);
    expect(ranAt(1 / 24) < w.failedBefore).toBe(false);
  });
});

describe("planReconcile (reconcile math)", () => {
  const stored = [
    "places/P/reviews/a",
    "places/P/reviews/b",
    "places/P/reviews/c",
  ];

  it("keeps what Google still returns, removes what it dropped, lists what is new", () => {
    expect(
      planReconcile(stored, [
        "places/P/reviews/a",
        "places/P/reviews/c",
        "places/P/reviews/d",
      ]),
    ).toEqual({
      keep: ["places/P/reviews/a", "places/P/reviews/c"],
      remove: ["places/P/reviews/b"],
      added: ["places/P/reviews/d"],
    });
  });

  it("removes everything when Google returns nothing, and nothing when nothing is stored", () => {
    expect(planReconcile(stored, [])).toEqual({
      keep: [],
      remove: stored,
      added: [],
    });
    expect(planReconcile([], ["places/P/reviews/a"])).toEqual({
      keep: [],
      remove: [],
      added: ["places/P/reviews/a"],
    });
  });

  it("never touches a row whose external_id is not a Places name, and collapses duplicates", () => {
    const plan = planReconcile(
      [
        "accounts/1/locations/2/reviews/3",
        "places/P/reviews/a",
        "places/P/reviews/a",
      ],
      ["places/P/reviews/a", "places/P/reviews/a"],
    );
    expect(plan).toEqual({
      keep: ["places/P/reviews/a"],
      remove: [],
      added: [],
    });
  });
});

describe("refreshNote and refreshChanged", () => {
  it("writes the human note only when something was removed or refused", () => {
    expect(refreshNote({ deleted: 0, rejected: 0, limit: 100 })).toBeNull();
    expect(refreshNote({ deleted: 1, rejected: 0, limit: 100 })).toBe(
      "1 review Google no longer returns was removed.",
    );
    expect(refreshNote({ deleted: 2, rejected: 0, limit: 100 })).toBe(
      "2 reviews Google no longer returns were removed.",
    );
    expect(refreshNote({ deleted: 0, rejected: 1, limit: 1000 })).toBe(
      "1 review was not imported: the project is at its review limit (1,000 on this plan).",
    );
    expect(refreshNote({ deleted: 1, rejected: 3, limit: 1000 })).toBe(
      "1 review Google no longer returns was removed. 3 reviews were not imported: the project is at its review limit (1,000 on this plan).",
    );
  });

  it("counts a creation, a deletion or a re-index as a change; a no-op update is not one", () => {
    expect(refreshChanged({ created: 0, deleted: 0, enqueued: 0 })).toBe(false);
    expect(refreshChanged({ created: 1, deleted: 0, enqueued: 0 })).toBe(true);
    expect(refreshChanged({ created: 0, deleted: 1, enqueued: 0 })).toBe(true);
    expect(refreshChanged({ created: 0, deleted: 0, enqueued: 1 })).toBe(true);
  });
});
