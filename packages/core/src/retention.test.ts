import { describe, expect, it } from "vitest";

import {
  ACCOUNT_PURGE_AFTER_DAYS,
  ACCOUNT_PURGE_BATCH,
  deletePrefix,
  isPastRetention,
  MemoryBucket,
  projectUploadsPrefix,
  retentionCutoff,
  UPLOAD_RETENTION_DAYS,
} from "./retention.js";

const DAY = 24 * 60 * 60 * 1000;

describe("retention constants", () => {
  it("keeps uploads 7 days and deleted workspaces 30 (privacy policy, #169)", () => {
    expect(UPLOAD_RETENTION_DAYS).toBe(7);
    expect(ACCOUNT_PURGE_AFTER_DAYS).toBe(30);
    expect(ACCOUNT_PURGE_BATCH).toBe(50);
  });
});

describe("retentionCutoff / isPastRetention", () => {
  const now = new Date("2026-10-05T04:15:00Z");

  it("subtracts whole days", () => {
    expect(retentionCutoff(now, 30).toISOString()).toBe(
      "2026-09-05T04:15:00.000Z",
    );
    expect(retentionCutoff(now, 0)).toEqual(now);
  });

  it("is past retention only strictly before the cutoff", () => {
    expect(isPastRetention(new Date(now.getTime() - 31 * DAY), now, 30)).toBe(
      true,
    );
    expect(isPastRetention(new Date(now.getTime() - 29 * DAY), now, 30)).toBe(
      false,
    );
    expect(isPastRetention(new Date(now.getTime() - 30 * DAY), now, 30)).toBe(
      false,
    );
    expect(
      isPastRetention(new Date(now.getTime() - 30 * DAY - 1), now, 30),
    ).toBe(true);
  });

  it("rejects negative or fractional days", () => {
    expect(() => retentionCutoff(now, -1)).toThrow();
    expect(() => retentionCutoff(now, 1.5)).toThrow();
  });
});

describe("projectUploadsPrefix", () => {
  it("ends in a slash so one id never prefixes another", () => {
    expect(projectUploadsPrefix("abc")).toBe("uploads/abc/");
  });

  it("refuses ids that would widen the prefix", () => {
    expect(() => projectUploadsPrefix("")).toThrow();
    expect(() => projectUploadsPrefix("a/b")).toThrow();
  });
});

describe("deletePrefix", () => {
  it("deletes only keys under the prefix, page by page", async () => {
    const keys = Array.from(
      { length: 25 },
      (_, i) => `uploads/p1/run-${String(i).padStart(2, "0")}.csv`,
    );
    const bucket = new MemoryBucket([
      ...keys,
      "uploads/p10/run.csv",
      "uploads/p2/run.csv",
    ]);
    const n = await deletePrefix(bucket, projectUploadsPrefix("p1"), {
      batchSize: 10,
    });
    expect(n).toBe(25);
    expect(bucket.deleteCalls.map((c) => c.length)).toEqual([10, 10, 5]);
    expect(bucket.keys()).toEqual(["uploads/p10/run.csv", "uploads/p2/run.csv"]);
  });

  it("returns 0 and makes no delete call for an empty prefix listing", async () => {
    const bucket = new MemoryBucket(["uploads/other/x.csv"]);
    expect(await deletePrefix(bucket, "uploads/none/")).toBe(0);
    expect(bucket.deleteCalls).toEqual([]);
  });

  it("refuses the empty prefix", async () => {
    await expect(deletePrefix(new MemoryBucket(), "")).rejects.toThrow();
  });

  it("caps the page size at R2's 1,000", async () => {
    const bucket = new MemoryBucket(
      Array.from({ length: 1001 }, (_, i) => `uploads/p/${i}`),
    );
    expect(await deletePrefix(bucket, "uploads/p/", { batchSize: 5000 })).toBe(
      1001,
    );
    expect(bucket.deleteCalls.map((c) => c.length)).toEqual([1000, 1]);
  });
});
