import { describe, expect, it } from "vitest";

import { PACKAGE_NAME, WORKSPACE_DEPENDENCIES } from "./index.js";

describe("@proofql/pipeline", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@proofql/pipeline");
  });

  it("resolves workspace dependencies through turbo's build graph", () => {
    expect(WORKSPACE_DEPENDENCIES).toEqual(["@proofql/core"]);
  });
});
