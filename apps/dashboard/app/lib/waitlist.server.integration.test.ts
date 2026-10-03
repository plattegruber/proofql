// The waitlist insert against the real schema: a new address creates a row
// with the default source, a repeat is a no-op reported as such (the unique
// constraint, not an error), and the stored row carries what the form sent.
import { schema } from "@proofql/db";
import { setupTestDb } from "@proofql/db/test";
import { describe, expect, it } from "vitest";

import { addToWaitlist } from "./waitlist.server";

const t = setupTestDb();

describe("addToWaitlist", () => {
  it("creates a row with the default source", async () => {
    expect(await addToWaitlist(t.db, { email: "ada@example.com" })).toEqual({
      created: true,
    });
    const rows = await t.db.select().from(schema.waitlist);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: "ada@example.com",
      source: "sign-up",
    });
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("reports a repeat address without inserting or throwing", async () => {
    await addToWaitlist(t.db, { email: "grace@example.com" });
    expect(await addToWaitlist(t.db, { email: "grace@example.com" })).toEqual({
      created: false,
    });
    const rows = await t.db.select().from(schema.waitlist);
    expect(rows.filter((r) => r.email === "grace@example.com")).toHaveLength(1);
  });

  it("records the collecting surface when one is given", async () => {
    await addToWaitlist(t.db, { email: "lin@example.com", source: "landing" });
    const [row] = await t.db.select().from(schema.waitlist);
    expect(
      (await t.db.select().from(schema.waitlist)).find(
        (r) => r.email === "lin@example.com",
      )?.source,
    ).toBe("landing");
    expect(row).toBeDefined();
  });
});
