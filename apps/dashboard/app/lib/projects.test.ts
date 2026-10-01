// Pure project rules: slug derivation, origin normalization, and the form
// schemas the actions parse with. No DB — the constraints those rules feed
// are exercised in projects.server.integration.test.ts.
import { describe, expect, it } from "vitest";

import {
  createProjectSchema,
  normalizeOrigin,
  originSchema,
  projectSettingsSchema,
  slugify,
} from "./projects";

describe("slugify", () => {
  it("lowercases, hyphenates, trims and strips diacritics", () => {
    expect(slugify("Cedar Ridge Dental")).toBe("cedar-ridge-dental");
    expect(slugify("  Café   Müller & Sons! ")).toBe("cafe-muller-sons");
    expect(slugify("---")).toBe("");
    expect(slugify("Already-a-slug")).toBe("already-a-slug");
  });

  it("caps the length without leaving a trailing hyphen", () => {
    const long = slugify(`${"word ".repeat(20)}end`);
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith("-")).toBe(false);
  });
});

describe("createProjectSchema", () => {
  it("accepts a name and a well-formed slug", () => {
    const parsed = createProjectSchema.safeParse({
      name: "  Cedar Ridge Dental ",
      slug: "cedar-ridge-dental",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.name).toBe("Cedar Ridge Dental");
  });

  it("rejects bad slugs with a message per field", () => {
    for (const slug of [
      "Has Caps",
      "-leading",
      "trailing-",
      "a--b",
      "new",
      "",
    ]) {
      const parsed = createProjectSchema.safeParse({ name: "x", slug });
      expect(parsed.success, slug).toBe(false);
    }
    const reserved = createProjectSchema.safeParse({ name: "x", slug: "new" });
    expect(reserved.success).toBe(false);
    if (!reserved.success) {
      expect(reserved.error.issues[0]?.message).toBe("That slug is reserved.");
    }
  });
});

describe("projectSettingsSchema", () => {
  const base = { name: "Cedar", slug: "cedar" };

  it("coerces form strings and rounds the floor to two decimals", () => {
    const parsed = projectSettingsSchema.safeParse({
      ...base,
      min_rating: "3",
      similarity_floor: "0.60000001",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.min_rating).toBe(3);
      expect(parsed.data.similarity_floor).toBe(0.6);
    }
  });

  it("rejects out-of-range values with per-field messages", () => {
    const parsed = projectSettingsSchema.safeParse({
      ...base,
      min_rating: "6",
      similarity_floor: "0.95",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const byField = Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join("."), i.message]),
      );
      expect(byField.min_rating).toBe("Pick a rating between 1 and 5.");
      expect(byField.similarity_floor).toBe(
        "Enter a value between 0.3 and 0.9.",
      );
    }
  });

  it("rejects non-numeric input", () => {
    const parsed = projectSettingsSchema.safeParse({
      ...base,
      min_rating: "4",
      similarity_floor: "high",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("normalizeOrigin", () => {
  it("accepts scheme://host[:port], tolerating whitespace and one trailing slash", () => {
    expect(normalizeOrigin("https://www.example.com")).toEqual({
      ok: true,
      origin: "https://www.example.com",
    });
    expect(normalizeOrigin("  http://localhost:3000/ ")).toEqual({
      ok: true,
      origin: "http://localhost:3000",
    });
    // Default ports collapse into the origin exactly as browsers send them.
    expect(normalizeOrigin("https://example.com:443")).toEqual({
      ok: true,
      origin: "https://example.com",
    });
    expect(normalizeOrigin("http://example.com:8080")).toEqual({
      ok: true,
      origin: "http://example.com:8080",
    });
    expect(normalizeOrigin("HTTPS://Example.COM")).toEqual({
      ok: true,
      origin: "https://example.com",
    });
  });

  it("rejects paths, queries, credentials, bare hosts and other schemes", () => {
    for (const input of [
      "https://example.com/reviews",
      "https://example.com/?x=1",
      "https://user:pw@example.com",
      "example.com",
      "ftp://example.com",
      "",
      "https://",
    ]) {
      expect(normalizeOrigin(input).ok, input).toBe(false);
    }
  });

  it("originSchema carries the normalization into form parsing", () => {
    const ok = originSchema.safeParse({ origin: "https://a.example/" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.origin).toBe("https://a.example");
    const bad = originSchema.safeParse({ origin: "a.example" });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0]?.message).toMatch(/full origin/);
    }
  });
});
