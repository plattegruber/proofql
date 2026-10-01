import { describe, expect, it } from "vitest";

import { DEFAULT_API, findScript, readScriptConfig } from "./config.js";

function script(attrs: Record<string, string>): HTMLScriptElement {
  const el = document.createElement("script");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

describe("readScriptConfig", () => {
  it("reads data-key and defaults the API origin", () => {
    expect(readScriptConfig(script({ "data-key": "pq_pk_test_abc" }))).toEqual({
      key: "pq_pk_test_abc",
      api: DEFAULT_API,
    });
  });

  it("honours data-api and strips a trailing slash", () => {
    expect(
      readScriptConfig(
        script({
          "data-key": " pq_pk_test_abc ",
          "data-api": "http://localhost:8797/",
        }),
      ),
    ).toEqual({ key: "pq_pk_test_abc", api: "http://localhost:8797" });
  });

  it("is null without a script or without a key", () => {
    expect(readScriptConfig(null)).toBeNull();
    expect(readScriptConfig(script({}))).toBeNull();
    expect(readScriptConfig(script({ "data-key": "  " }))).toBeNull();
  });
});

describe("findScript", () => {
  it("prefers document.currentScript", () => {
    const current = script({ "data-key": "current" });
    const other = script({ "data-key": "other" });
    document.body.append(other);
    Object.defineProperty(document, "currentScript", {
      value: current,
      configurable: true,
    });
    try {
      expect(findScript(document)).toBe(current);
    } finally {
      Object.defineProperty(document, "currentScript", {
        value: null,
        configurable: true,
      });
      other.remove();
    }
  });

  it("falls back to the last script[data-key] (async loading)", () => {
    const first = script({ "data-key": "first" });
    const last = script({ "data-key": "last" });
    document.body.append(first, last);
    try {
      expect(findScript(document)).toBe(last);
    } finally {
      first.remove();
      last.remove();
    }
  });

  it("is null when no script carries a key", () => {
    expect(findScript(document)).toBeNull();
  });
});
