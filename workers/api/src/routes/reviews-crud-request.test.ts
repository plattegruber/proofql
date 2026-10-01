/**
 * The pure parts of the review CRUD routes: cursor encoding, the list
 * query-string schema, and the PATCH body schema. No database.
 */

import { describe, expect, it } from "vitest";

import {
  cursorFor,
  decodeCursor,
  encodeCursor,
  listQuerySchema,
  patchBodySchema,
} from "./reviews-crud-request.js";

const ID = "0f5b7c2e-6d3a-4e8f-9a1b-2c3d4e5f6a7b";

describe("pagination cursor", () => {
  it("round-trips a dated keyset", () => {
    const cursor = cursorFor({
      id: ID,
      occurredAt: new Date("2026-03-14T18:20:00.123Z"),
    });
    const encoded = encodeCursor(cursor);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual({
      o: "2026-03-14T18:20:00.123Z",
      i: ID,
    });
  });

  it("round-trips a null occurred_at", () => {
    const encoded = encodeCursor(cursorFor({ id: ID, occurredAt: null }));
    expect(decodeCursor(encoded)).toEqual({ o: null, i: ID });
  });

  it("rejects tampered, truncated, and foreign cursors", () => {
    const good = encodeCursor({ o: "2026-03-14T18:20:00.000Z", i: ID });

    expect(decodeCursor(good.slice(0, -4))).toBeNull();
    expect(decodeCursor(`${good}!!`)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not base64url at all")).toBeNull();
    // Valid base64url of the wrong things.
    const enc = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    expect(decodeCursor(enc("a string"))).toBeNull();
    expect(decodeCursor(enc({ o: null }))).toBeNull();
    expect(decodeCursor(enc({ o: null, i: "not-a-uuid" }))).toBeNull();
    expect(decodeCursor(enc({ o: "yesterday", i: ID }))).toBeNull();
    expect(decodeCursor(enc({ o: null, i: ID, extra: 1 }))).toBeNull();
    expect(decodeCursor(enc({ o: null, i: `${ID}' OR 1=1` }))).toBeNull();
  });
});

describe("listQuerySchema", () => {
  it("applies defaults to an empty query string", () => {
    expect(listQuerySchema.parse({})).toEqual({ limit: 20, hidden: "all" });
  });

  it("coerces and bounds limit and min_rating", () => {
    expect(listQuerySchema.parse({ limit: "100", min_rating: "4" })).toEqual({
      limit: 100,
      min_rating: 4,
      hidden: "all",
    });
    for (const limit of ["0", "101", "ten", "2.5", ""]) {
      expect(listQuerySchema.safeParse({ limit }).success).toBe(false);
    }
    for (const min_rating of ["0", "6", "high"]) {
      expect(listQuerySchema.safeParse({ min_rating }).success).toBe(false);
    }
  });

  it("accepts the documented filters and refuses unknown ones", () => {
    expect(
      listQuerySchema.parse({
        source: "google",
        hidden: "false",
        since: "2025-01-01",
        indexed: "true",
      }),
    ).toEqual({
      limit: 20,
      source: "google",
      hidden: "false",
      since: "2025-01-01",
      indexed: "true",
    });
    expect(
      listQuerySchema.safeParse({ since: "2025-01-01T00:00:00+02:00" }).success,
    ).toBe(true);

    expect(listQuerySchema.safeParse({ source: "tripadvisor" }).success).toBe(
      false,
    );
    expect(listQuerySchema.safeParse({ hidden: "maybe" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ indexed: "all" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ since: "last week" }).success).toBe(
      false,
    );
    expect(listQuerySchema.safeParse({ min_ratng: "4" }).success).toBe(false);
  });
});

describe("patchBodySchema", () => {
  it("requires at least one field", () => {
    const result = patchBodySchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at least one/);
    }
  });

  it("accepts hidden alone, metadata alone, or both", () => {
    expect(patchBodySchema.parse({ hidden: true })).toEqual({ hidden: true });
    expect(patchBodySchema.parse({ metadata: {} })).toEqual({ metadata: {} });
    expect(
      patchBodySchema.parse({ hidden: false, metadata: { location: "north" } }),
    ).toEqual({ hidden: false, metadata: { location: "north" } });
  });

  it("rejects non-flat metadata, non-boolean hidden, and unknown keys", () => {
    const bad = [
      { metadata: { nested: { a: "b" } } },
      { metadata: { list: ["a"] } },
      { metadata: { n: 1 } },
      { metadata: { flag: true } },
      { metadata: { nul: null } },
      { metadata: "north" },
      { hidden: "true" },
      { hidden: 1 },
      { hidden: true, text: "rewritten" },
      { hidden: null },
    ];
    for (const body of bad) {
      expect(
        patchBodySchema.safeParse(body).success,
        JSON.stringify(body),
      ).toBe(false);
    }
  });

  it("applies the ingest metadata caps", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(patchBodySchema.safeParse({ metadata: tooMany }).success).toBe(
      false,
    );
    expect(
      patchBodySchema.safeParse({ metadata: { "": "empty key" } }).success,
    ).toBe(false);
    expect(
      patchBodySchema.safeParse({ metadata: { k: "v".repeat(513) } }).success,
    ).toBe(false);
  });
});
