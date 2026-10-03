import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUPPORT_EMAIL,
  PRIVACY_URL,
  supportEmailFrom,
  TERMS_URL,
} from "./contact.js";

describe("contact", () => {
  it("falls back to the default address for empty, blank and undefined", () => {
    expect(supportEmailFrom(undefined)).toBe(DEFAULT_SUPPORT_EMAIL);
    expect(supportEmailFrom("")).toBe(DEFAULT_SUPPORT_EMAIL);
    expect(supportEmailFrom("   ")).toBe(DEFAULT_SUPPORT_EMAIL);
    expect(supportEmailFrom(null)).toBe(DEFAULT_SUPPORT_EMAIL);
  });

  it("trims a configured address", () => {
    expect(supportEmailFrom("  help@example.com ")).toBe("help@example.com");
  });

  it("points the legal pages at the docs site", () => {
    expect(PRIVACY_URL).toBe("https://docs.proofql.com/privacy");
    expect(TERMS_URL).toBe("https://docs.proofql.com/terms");
  });
});
