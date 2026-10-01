import { describe, expect, it } from "vitest";

import { authMode } from "./auth-mode";

describe("authMode", () => {
  it("stubs only when the secret is unset AND the environment is local", () => {
    expect(authMode({ ENVIRONMENT: "local" })).toBe("stub");
    expect(authMode({ ENVIRONMENT: "local", CLERK_SECRET_KEY: "" })).toBe(
      "stub",
    );
  });

  it("uses Clerk whenever a secret key is present, local included", () => {
    expect(
      authMode({ ENVIRONMENT: "local", CLERK_SECRET_KEY: "sk_test_x" }),
    ).toBe("clerk");
    expect(
      authMode({ ENVIRONMENT: "preview", CLERK_SECRET_KEY: "sk_test_x" }),
    ).toBe("clerk");
    expect(
      authMode({ ENVIRONMENT: "prod", CLERK_SECRET_KEY: "sk_live_x" }),
    ).toBe("clerk");
  });

  it("never stubs outside local — a missing key is a misconfiguration", () => {
    expect(authMode({ ENVIRONMENT: "preview" })).toBe("unconfigured");
    expect(authMode({ ENVIRONMENT: "prod", CLERK_SECRET_KEY: "" })).toBe(
      "unconfigured",
    );
  });
});
