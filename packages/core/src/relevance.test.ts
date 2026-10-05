import { describe, expect, it } from "vitest";

import {
  DEFAULT_SIMILARITY_FLOOR,
  LEXICAL_FLOOR_OFFSET,
  lexicalFloorFor,
} from "./relevance.js";

describe("relevance floors", () => {
  it("defaults to the measured 0.66 with a 0.53 lexical tier", () => {
    expect(DEFAULT_SIMILARITY_FLOOR).toBe(0.66);
    expect(LEXICAL_FLOOR_OFFSET).toBe(0.13);
    expect(lexicalFloorFor(DEFAULT_SIMILARITY_FLOOR)).toBe(0.53);
  });

  it("follows the project's floor without float noise and never goes negative", () => {
    expect(lexicalFloorFor(0.7)).toBe(0.57);
    expect(lexicalFloorFor(0.3)).toBe(0.17);
    expect(lexicalFloorFor(0.1)).toBe(0);
  });
});
