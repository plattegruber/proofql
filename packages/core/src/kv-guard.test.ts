import { describe, expect, it } from "vitest";

import { generationKey, MemoryKv } from "./cache-generation.js";
import {
  createKvFaultReporter,
  exhaustedKv,
  guardKvRead,
  guardKvWrite,
  isKvLimitError,
  KV_GET_LIMIT_MESSAGE,
  KV_PUT_LIMIT_MESSAGE,
  kvFaultEvent,
  safeBumpProjectGeneration,
} from "./kv-guard.js";
import { createLogger, recordingSink } from "./log.js";

function harness(now = () => 0) {
  const rec = recordingSink();
  const log = createLogger({
    service: "api",
    environment: "test",
    sink: rec.sink,
  });
  const reporter = createKvFaultReporter({ now });
  return { rec, log, reporter };
}

describe("isKvLimitError", () => {
  it("matches Cloudflare's literal get and put limit messages", () => {
    expect(isKvLimitError(new Error(KV_GET_LIMIT_MESSAGE))).toBe(true);
    expect(isKvLimitError(new Error(KV_PUT_LIMIT_MESSAGE))).toBe(true);
    expect(
      isKvLimitError(new Error("KV delete() limit exceeded for the day.")),
    ).toBe(true);
  });

  it("looks through causes, and ignores everything else", () => {
    expect(
      isKvLimitError(
        new Error("wrapped", { cause: new Error(KV_GET_LIMIT_MESSAGE) }),
      ),
    ).toBe(true);
    expect(isKvLimitError(new Error("kv down"))).toBe(false);
    expect(isKvLimitError(null)).toBe(false);
  });

  it("names the event by op and cause", () => {
    expect(kvFaultEvent("get", new Error(KV_GET_LIMIT_MESSAGE))).toBe(
      "kv.limit_exceeded",
    );
    expect(kvFaultEvent("get", new Error("x"))).toBe("kv.read_failed");
    expect(kvFaultEvent("put", new Error("x"))).toBe("kv.write_failed");
  });
});

describe("guards", () => {
  it("a throwing read returns the fallback and logs kv.limit_exceeded at warn", async () => {
    const { rec, log, reporter } = harness();
    const kv = exhaustedKv();
    const value = await guardKvRead(
      { log, site: "test.read", reporter },
      "fallback",
      () => kv.get("k") as Promise<string>,
    );
    expect(value).toBe("fallback");
    expect(rec.only("kv.limit_exceeded")).toMatchObject({
      level: "warn",
      op: "get",
      site: "test.read",
      suppressed: 0,
    });
  });

  it("a throwing write is swallowed (false) and logged as kv.write_failed", async () => {
    const { rec, log, reporter } = harness();
    const ok = await guardKvWrite({ log, site: "test.write", reporter }, () =>
      Promise.reject(new Error("network")),
    );
    expect(ok).toBe(false);
    expect(rec.only("kv.write_failed")).toMatchObject({
      level: "warn",
      op: "put",
    });
  });

  it("logs once per minute per event and op, counting what it suppressed", async () => {
    let clock = 0;
    const { rec, log, reporter } = harness(() => clock);
    const kv = exhaustedKv();
    const ctx = { log, site: "s", reporter };
    for (let i = 0; i < 5; i++) {
      await guardKvWrite(ctx, () => kv.put("k", "v"));
    }
    expect(rec.find("kv.limit_exceeded")).toHaveLength(1);
    clock += 60_000;
    await guardKvWrite(ctx, () => kv.put("k", "v"));
    const lines = rec.find("kv.limit_exceeded");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ suppressed: 4 });
    // A different op is its own throttle bucket.
    await guardKvRead(ctx, null, () => kv.get("k"));
    expect(rec.find("kv.limit_exceeded")).toHaveLength(3);
  });

  it("safeBumpProjectGeneration bumps normally and returns null instead of throwing", async () => {
    const { rec, log, reporter } = harness();
    const ok = new MemoryKv();
    expect(
      await safeBumpProjectGeneration(ok, "p1", { log, site: "s", reporter }),
    ).toBe(1);
    expect(ok.store.get(generationKey("p1"))).toBe("1");

    for (const kv of [exhaustedKv(), exhaustedKv({ reads: false })]) {
      expect(
        await safeBumpProjectGeneration(kv, "p1", { log, site: "s", reporter }),
      ).toBeNull();
    }
    expect(rec.find("kv.limit_exceeded").length).toBeGreaterThan(0);
  });
});
