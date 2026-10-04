import { describe, expect, it } from "vitest";

import {
  formatBytes,
  REQUEST_BODY_LIMITS,
  requestBodyLimitRows,
} from "./limits.js";

describe("REQUEST_BODY_LIMITS", () => {
  it("are the documented ceilings", () => {
    expect(REQUEST_BODY_LIMITS).toEqual({
      reviews: 1024 * 1024,
      reviewPatch: 64 * 1024,
      query: 16 * 1024,
    });
  });

  it("render as whole binary units", () => {
    expect(formatBytes(1024 * 1024)).toBe("1 MiB");
    expect(formatBytes(64 * 1024)).toBe("64 KiB");
    expect(formatBytes(16 * 1024)).toBe("16 KiB");
    expect(formatBytes(1500)).toBe("1500 bytes");
  });

  it("list every limit once, in route order", () => {
    const rows = requestBodyLimitRows();
    expect(rows.map((r) => r.key)).toEqual(Object.keys(REQUEST_BODY_LIMITS));
    expect(rows.map((r) => r.limit)).toEqual(["1 MiB", "64 KiB", "16 KiB"]);
  });
});
