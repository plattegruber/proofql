import { describe, expect, it, vi } from "vitest";

import {
  createLogger,
  errorFields,
  levelFor,
  REDACTED,
  REDACTED_FIELDS,
  recordingSink,
  redactFields,
} from "./log.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");

function harness(environment = "test") {
  const out = recordingSink();
  const logger = createLogger({
    service: "api",
    environment,
    sink: out.sink,
    now: () => NOW,
  });
  return { logger, out };
}

describe("createLogger", () => {
  it("emits one JSON line per call: ts, service, environment, event, level, then fields", () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: "pipeline",
      environment: "prod",
      sink: (line) => lines.push(line),
      now: () => NOW,
    });

    logger.log("review.indexed", { review_id: "r1", chunks: 3 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(JSON.parse(lines[0] as string)).toEqual({
      ts: "2026-10-01T12:00:00.000Z",
      service: "pipeline",
      environment: "prod",
      event: "review.indexed",
      level: "info",
      review_id: "r1",
      chunks: 3,
    });
    // Key order is part of the contract: the fixed envelope comes first so
    // a raw tail is readable before the fields.
    expect(Object.keys(JSON.parse(lines[0] as string))).toEqual([
      "ts",
      "service",
      "environment",
      "event",
      "level",
      "review_id",
      "chunks",
    ]);
  });

  it("writes to console.log when no sink is given", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      createLogger({ service: "api", environment: "test" }).log("x.y");
      expect(spy).toHaveBeenCalledOnce();
      expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toMatchObject({
        event: "x.y",
        level: "info",
      });
    } finally {
      spy.mockRestore();
    }
  });

  describe("levels", () => {
    it("defaults to info", () => {
      const { logger, out } = harness();
      logger.log("query.completed", { took_ms: 3 });
      expect(out.only("query.completed").level).toBe("info");
    });

    it("an error field makes the line an error", () => {
      const { logger, out } = harness();
      logger.log("query.embedding_failed", { error: new Error("down") });
      expect(out.only("query.embedding_failed")).toMatchObject({
        level: "error",
        error: { name: "Error", message: "down" },
      });
    });

    it("an explicit level wins over inference and is not duplicated as a field", () => {
      const { logger, out } = harness();
      logger.log("query.cache_error", { level: "warn", error: "KV timeout" });
      logger.log("sweep.exhausted", { level: "warn", count: 2 });
      logger.log("nonsense", { level: "verbose" });

      expect(out.only("query.cache_error").level).toBe("warn");
      expect(out.only("sweep.exhausted")).toEqual(
        expect.objectContaining({ level: "warn", count: 2 }),
      );
      expect(out.only("nonsense").level).toBe("info");
      expect(Object.keys(out.only("sweep.exhausted"))).toEqual([
        "ts",
        "service",
        "environment",
        "event",
        "level",
        "count",
      ]);
    });

    it("levelFor: null error counts as no error", () => {
      expect(levelFor(undefined, { error: null })).toBe("info");
      expect(levelFor(undefined, { error: "x" })).toBe("error");
      expect(levelFor("warn", { error: "x" })).toBe("warn");
    });
  });

  describe("redaction", () => {
    it("replaces review text, excerpts, author names, keys and plaintext at any depth", () => {
      const { logger, out } = harness();
      logger.log("review.indexed", {
        text: "My implant feels like my own tooth.",
        excerpt: "like my own tooth",
        author_name: "Marcus T.",
        key: "pq_sk_live_abc",
        plaintext: "pq_pk_live_def",
        authorization: "Bearer pq_sk_live_abc",
        review_id: "r1",
        nested: { text: "inner", items: [{ excerpt: "deep" }, "plain"] },
      });

      const line = out.only("review.indexed");
      expect(line).toMatchObject({
        text: REDACTED,
        excerpt: REDACTED,
        author_name: REDACTED,
        key: REDACTED,
        plaintext: REDACTED,
        authorization: REDACTED,
        review_id: "r1",
        nested: { text: REDACTED, items: [{ excerpt: REDACTED }, "plain"] },
      });
      const raw = JSON.stringify(line);
      for (const leak of [
        "implant",
        "own tooth",
        "Marcus",
        "pq_sk_live",
        "pq_pk_live",
        "inner",
        "deep",
      ]) {
        expect(raw).not.toContain(leak);
      }
    });

    it("redacts bound fields too, and honours a custom list", () => {
      const out = recordingSink();
      const logger = createLogger({
        service: "api",
        environment: "test",
        sink: out.sink,
        redact: ["secret"],
      }).child({ secret: "s3", text: "kept by this config" });

      logger.log("x", { secret: "s4" });

      expect(out.only("x")).toMatchObject({
        secret: REDACTED,
        text: "kept by this config",
      });
    });

    it("redactFields is a deep copy that never mutates its input", () => {
      const input = { text: "t", inner: { key: "k", n: 1 }, when: NOW };
      const redacted = redactFields(input);
      expect(redacted).toEqual({
        text: REDACTED,
        inner: { key: REDACTED, n: 1 },
        when: NOW.toISOString(),
      });
      expect(input.text).toBe("t");
      expect(input.inner.key).toBe("k");
    });

    it("the default list is the documented one", () => {
      expect([...REDACTED_FIELDS].sort()).toEqual([
        "author_name",
        "authorization",
        "excerpt",
        "key",
        "plaintext",
        "text",
      ]);
    });
  });

  describe("child", () => {
    it("carries its bindings on every line and merges with the parent's", () => {
      const { logger, out } = harness();
      const request = logger.child({ request_id: "req-1", method: "GET" });
      const deeper = request.child({ project_id: "p1", method: "POST" });

      request.log("a");
      deeper.log("b", { took_ms: 1 });
      logger.log("c");

      expect(out.only("a")).toMatchObject({
        request_id: "req-1",
        method: "GET",
      });
      expect(out.only("b")).toMatchObject({
        request_id: "req-1",
        method: "POST",
        project_id: "p1",
        took_ms: 1,
      });
      expect(out.only("c")).not.toHaveProperty("request_id");
      expect(deeper.bindings).toEqual({
        request_id: "req-1",
        method: "POST",
        project_id: "p1",
      });
    });

    it("call-site fields win over bindings", () => {
      const { logger, out } = harness();
      logger.child({ attempt: 1 }).log("x", { attempt: 2 });
      expect(out.only("x").attempt).toBe(2);
    });
  });

  it("flattens Errors to name/message/cause and drops undefined fields", () => {
    const { logger, out } = harness();
    const cause = new TypeError("root");
    logger.log("x", {
      error: new Error("outer", { cause }),
      missing: undefined,
    });

    const line = out.only("x");
    expect(line.error).toEqual({
      name: "Error",
      message: "outer",
      cause: "TypeError: root",
    });
    expect(line).not.toHaveProperty("missing");
    expect(JSON.stringify(line)).not.toContain("at ");
  });
});

describe("errorFields", () => {
  it("handles non-Error throwables", () => {
    expect(errorFields("boom")).toEqual({ name: "NonError", message: "boom" });
    expect(errorFields(undefined)).toEqual({
      name: "NonError",
      message: "undefined",
    });
  });
});

describe("recordingSink", () => {
  it("find/only/clear", () => {
    const { logger, out } = harness();
    logger.log("a");
    logger.log("a");
    expect(out.find("a")).toHaveLength(2);
    expect(() => out.only("a")).toThrow(/exactly one "a" line, found 2/);
    expect(() => out.only("b")).toThrow(/found 0/);
    out.clear();
    expect(out.records).toEqual([]);
  });
});
