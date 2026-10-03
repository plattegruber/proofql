import { describe, expect, it } from "vitest";

import { WAITLIST_EMAIL_MAX_LENGTH, waitlistFormSchema } from "./waitlist";

describe("waitlistFormSchema", () => {
  it("normalizes the address before validating it", () => {
    const result = waitlistFormSchema.safeParse({
      email: "  Ada@Example.COM ",
    });
    expect(result.success && result.data.email).toBe("ada@example.com");
  });

  it("rejects a missing, malformed or oversized address with one message", () => {
    expect(waitlistFormSchema.safeParse({}).success).toBe(false);
    const bad = waitlistFormSchema.safeParse({ email: "not an address" });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0]?.message).toBe("Enter a valid email address.");
    }
    const long = waitlistFormSchema.safeParse({
      email: `${"a".repeat(WAITLIST_EMAIL_MAX_LENGTH)}@example.com`,
    });
    expect(long.success).toBe(false);
  });

  it("carries the honeypot through untouched", () => {
    const result = waitlistFormSchema.safeParse({
      email: "ada@example.com",
      website: "https://spam.example",
    });
    expect(result.success && result.data.website).toBe("https://spam.example");
  });
});
