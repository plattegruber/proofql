// The dashboard's own side of the Places bootstrap (#47): the search-box
// validation and the route path. The shapes, mapper, keys and client are
// tested where they live, in packages/google (places.test.ts).
import { describe, expect, it } from "vitest";

import { placesActionPath, placesSearchQuerySchema } from "./places";

describe("placesSearchQuerySchema", () => {
  it("trims and bounds the search query", () => {
    expect(placesSearchQuerySchema.safeParse("ab").success).toBe(false);
    expect(placesSearchQuerySchema.safeParse("  Cedar ").data).toBe("Cedar");
    expect(placesSearchQuerySchema.safeParse("x".repeat(201)).success).toBe(
      false,
    );
  });
});

describe("placesActionPath", () => {
  it("builds the resource route path", () => {
    expect(placesActionPath("cedar")).toBe("/app/projects/cedar/places");
  });
});
