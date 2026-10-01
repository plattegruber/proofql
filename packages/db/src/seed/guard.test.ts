import { describe, expect, it } from "vitest";

import { assertSeedTargetAllowed, SeedGuardError } from "./guard.js";

describe("assertSeedTargetAllowed", () => {
  it.each([
    "postgres://proofql:proofql@localhost:54323/proofql",
    "postgres://proofql:proofql@127.0.0.1:5432/proofql",
    "postgresql://u:p@[::1]:5432/db",
  ])("allows loopback target %s", (databaseUrl) => {
    expect(() =>
      assertSeedTargetAllowed({ databaseUrl, force: false }),
    ).not.toThrow();
  });

  it("refuses a non-loopback host without --force", () => {
    expect(() =>
      assertSeedTargetAllowed({
        databaseUrl: "postgres://u:p@ep-cool-name.us-east-2.aws.neon.tech/db",
        force: false,
      }),
    ).toThrow(SeedGuardError);
  });

  it("names the refused host in the message", () => {
    expect(() =>
      assertSeedTargetAllowed({
        databaseUrl: "postgres://u:p@db.internal:5432/db",
        force: false,
      }),
    ).toThrow(/"db.internal"/);
  });

  it("allows a non-loopback host with --force", () => {
    expect(() =>
      assertSeedTargetAllowed({
        databaseUrl: "postgres://u:p@db.internal:5432/db",
        force: true,
      }),
    ).not.toThrow();
  });

  it("refuses an unparseable URL even with --force", () => {
    expect(() =>
      assertSeedTargetAllowed({ databaseUrl: "not a url", force: true }),
    ).toThrow(SeedGuardError);
  });
});
