import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "./index.js";

describe("@proofql/dashboard", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@proofql/dashboard");
  });
});
