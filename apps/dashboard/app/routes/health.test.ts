import { createLogger, recordingSink } from "@proofql/core";
import { describe, expect, it, vi } from "vitest";

import { healthResponse } from "./health";

function logger() {
  const out = recordingSink();
  return {
    out,
    log: createLogger({
      service: "dashboard",
      environment: "test",
      sink: out.sink,
    }),
  };
}

describe("dashboard /health", () => {
  it("plain /health never probes the database", async () => {
    const probe = vi.fn();
    const res = await healthResponse(
      new Request("https://app.test/health"),
      probe,
      logger().log,
    );
    expect(await res.json()).toEqual({ ok: true, worker: "dashboard" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("?deep=1 probes once: 200 when Postgres answers", async () => {
    const probe = vi.fn(async () => ({ ok: true as const, ms: 7 }));
    const res = await healthResponse(
      new Request("https://app.test/health?deep=1"),
      probe,
      logger().log,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ok: true,
      worker: "dashboard",
      db: { ok: true, ms: 7 },
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("?deep=1 is 503 and logs the cause (not in the body) when Postgres fails", async () => {
    const { log, out } = logger();
    const res = await healthResponse(
      new Request("https://app.test/health?deep=1"),
      async () => ({
        ok: false,
        error: "failed",
        ms: 30,
        cause: new Error("compute time quota exceeded"),
      }),
      log,
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({
      ok: false,
      worker: "dashboard",
      db: { ok: false, error: "failed", ms: 30 },
    });
    expect(out.only("health.db_failed")).toMatchObject({
      level: "error",
      reason: "failed",
    });
  });
});
