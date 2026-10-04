/**
 * The usage buffer's own contract (#108): one flush per window however many
 * requests arrive, deltas merged per (project, month), cache hits counted
 * under both columns, a failed write logged with the lost totals and never
 * retried. The real upsert is covered by quota.integration.test.ts.
 */

import { type Logger, recordingSink } from "@proofql/core";
import { type Context, Hono } from "hono";
import { describe, expect, it } from "vitest";

import { fakeCtx, testEnv } from "../test/helpers.js";
import type { AppEnv } from "./bindings.js";
import { requestContext } from "./request-id.js";
import { UsageBuffer, type UsageDelta } from "./usage-buffer.js";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

/**
 * Drive `record` through a real Hono context so `c.env`, `c.get("log")` and
 * `waitUntil` behave as in the app; the route body is the test's callback.
 */
async function drive(body: (c: Context<AppEnv>) => void) {
  const out = recordingSink();
  const app = new Hono<AppEnv>();
  app.use(requestContext({ sink: out.sink }));
  app.get("/", (c) => {
    body(c);
    return c.text("ok");
  });
  const ctx = fakeCtx();
  await app.request("/", {}, testEnv(), ctx.asExecutionContext());
  return { ctx, out };
}

function sleepControl() {
  const wakers: (() => void)[] = [];
  return {
    sleep: () =>
      new Promise<void>((resolve) => {
        wakers.push(resolve);
      }),
    /** Let every pending sleep return. */
    wake: () => {
      for (const w of wakers.splice(0)) w();
    },
    get sleeping() {
      return wakers.length;
    },
  };
}

describe("UsageBuffer", () => {
  it("merges requests into one delta per (project, month) and writes once per window", async () => {
    const writes: UsageDelta[][] = [];
    const clock = sleepControl();
    const buffer = new UsageBuffer({
      write: async (_env, deltas) => void writes.push(deltas),
      flushMs: 5_000,
      sleep: clock.sleep,
    });

    const { ctx } = await drive((c) => {
      buffer.record(c, P1, "2026-10-01", false);
      buffer.record(c, P1, "2026-10-01", true);
      buffer.record(c, P1, "2026-10-01", true);
      buffer.record(c, P2, "2026-10-01", false);
      buffer.record(c, P1, "2026-09-01", false);
    });

    // One flush scheduled, nothing written while it sleeps.
    expect(ctx.pending).toHaveLength(1);
    expect(clock.sleeping).toBe(1);
    expect(writes).toEqual([]);
    expect(buffer.pending).toHaveLength(3);

    clock.wake();
    await ctx.flush();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(
      expect.arrayContaining([
        { projectId: P1, month: "2026-10-01", queries: 3, cacheHits: 2 },
        { projectId: P2, month: "2026-10-01", queries: 1, cacheHits: 0 },
        { projectId: P1, month: "2026-09-01", queries: 1, cacheHits: 0 },
      ]),
    );
    expect(buffer.pending).toEqual([]);
    expect(buffer.flushes).toBe(1);
  });

  it("schedules a new flush for the next window after writing", async () => {
    const writes: UsageDelta[][] = [];
    const buffer = new UsageBuffer({
      write: async (_env, deltas) => void writes.push(deltas),
      flushMs: 0,
    });

    const first = await drive((c) => buffer.record(c, P1, "2026-10-01", false));
    await first.ctx.flush();
    const second = await drive((c) => buffer.record(c, P1, "2026-10-01", true));
    await second.ctx.flush();

    expect(writes).toEqual([
      [{ projectId: P1, month: "2026-10-01", queries: 1, cacheHits: 0 }],
      [{ projectId: P1, month: "2026-10-01", queries: 1, cacheHits: 1 }],
    ]);
  });

  it("logs usage.flush_failed with the lost totals and drops them", async () => {
    const buffer = new UsageBuffer({
      write: async () => {
        throw new Error("sorry, too many clients already");
      },
      flushMs: 0,
    });

    const { ctx, out } = await drive((c) => {
      buffer.record(c, P1, "2026-10-01", true);
      buffer.record(c, P2, "2026-10-01", false);
    });
    await ctx.flush();

    const failed = out.find("usage.flush_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      level: "error",
      projects: 2,
      queries: 2,
      cache_hits: 1,
    });
    expect(buffer.pending).toEqual([]);
  });

  it("flush() with nothing pending is a no-op that opens nothing", async () => {
    let writes = 0;
    const buffer = new UsageBuffer({
      write: async () => void writes++,
      flushMs: 0,
    });
    const log = { log: () => {} } as unknown as Logger;
    await buffer.flush(testEnv(), log);
    expect(writes).toBe(0);
    expect(buffer.flushes).toBe(0);
  });
});
