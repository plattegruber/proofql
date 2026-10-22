import { describe, expect, it } from "vitest";

import type { Db } from "./client.js";
import { pingDatabase } from "./health.js";

const fakeDb = (execute: () => Promise<unknown>) =>
  ({ execute }) as unknown as Db;

describe("pingDatabase", () => {
  it("ok when the statement answers", async () => {
    const ping = await pingDatabase(fakeDb(async () => [{ ok: 1 }]));
    expect(ping).toMatchObject({ ok: true });
  });

  it("failed (with the cause, for the log) when the statement throws", async () => {
    const error = new Error("Your project has exceeded the compute time quota");
    const ping = await pingDatabase(
      fakeDb(async () => {
        throw error;
      }),
    );
    expect(ping).toMatchObject({ ok: false, error: "failed", cause: error });
  });

  it("timeout when Postgres does not answer in time (a hung connect)", async () => {
    const ping = await pingDatabase(
      fakeDb(() => new Promise(() => {})),
      { timeoutMs: 20 },
    );
    expect(ping).toMatchObject({ ok: false, error: "timeout" });
    expect(ping.ms).toBeGreaterThanOrEqual(15);
  });
});
