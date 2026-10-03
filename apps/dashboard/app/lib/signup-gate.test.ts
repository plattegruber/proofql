import { describe, expect, it } from "vitest";

import { signupOpen } from "./signup-gate";

describe("signupOpen", () => {
  it("reads the truthy spellings of SIGNUP_OPEN, case-insensitively", () => {
    for (const value of ["true", "TRUE", " True ", "1", "yes", "on"]) {
      expect(signupOpen({ ENVIRONMENT: "prod", SIGNUP_OPEN: value })).toBe(
        true,
      );
    }
  });

  it("treats anything else as closed", () => {
    for (const value of ["false", "0", "no", "off", "soon", "TBD"]) {
      expect(signupOpen({ ENVIRONMENT: "local", SIGNUP_OPEN: value })).toBe(
        false,
      );
    }
  });

  it("defaults open locally and closed everywhere else when unset or blank", () => {
    expect(signupOpen({ ENVIRONMENT: "local" })).toBe(true);
    expect(signupOpen({ ENVIRONMENT: "local", SIGNUP_OPEN: "" })).toBe(true);
    expect(signupOpen({ ENVIRONMENT: "preview" })).toBe(false);
    expect(signupOpen({ ENVIRONMENT: "prod" })).toBe(false);
    expect(signupOpen({ ENVIRONMENT: "prod", SIGNUP_OPEN: "  " })).toBe(false);
    expect(signupOpen({})).toBe(false);
  });
});
