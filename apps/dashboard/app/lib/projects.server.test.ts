import {
  createLogger,
  MemoryBucket,
  type PrefixBucket,
  recordingSink,
} from "@proofql/core";
import { describe, expect, it } from "vitest";

import { deleteProjectUploads } from "./projects.server";

function logger() {
  const lines = recordingSink();
  const log = createLogger({
    service: "dashboard",
    environment: "test",
    sink: lines.sink,
  });
  return { lines, log };
}

describe("deleteProjectUploads", () => {
  it("deletes only that project's prefix and logs uploads.deleted", async () => {
    const bucket = new MemoryBucket([
      "uploads/p1/a.csv",
      "uploads/p1/a.errors.json",
      "uploads/p10/b.csv",
    ]);
    const { lines, log } = logger();
    expect(await deleteProjectUploads(bucket, "p1", log)).toBe(2);
    expect(bucket.keys()).toEqual(["uploads/p10/b.csv"]);
    expect(lines.only("uploads.deleted")).toMatchObject({
      project_id: "p1",
      count: 2,
    });
  });

  it("never rejects: a failing bucket is logged as uploads.delete_failed", async () => {
    const broken: PrefixBucket = {
      list: async () => {
        throw new Error("R2 unavailable");
      },
      delete: async () => {},
    };
    const { lines, log } = logger();
    expect(await deleteProjectUploads(broken, "p1", log)).toBeNull();
    expect(lines.only("uploads.delete_failed")).toMatchObject({
      level: "warn",
      project_id: "p1",
    });
  });
});
