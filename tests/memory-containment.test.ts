import { describe, expect, it } from "vitest";

import { normalizeSlug } from "../src/memory/store.ts";

describe("memory slug normalization", () => {
  it("trims leading and trailing slashes", () => {
    expect(normalizeSlug("//notes/page//")).toBe("notes/page");
  });

  it("normalizes a long run of interior slashes in linear time", () => {
    // A trailing-slash regex is quadratic on this input and times out the test.
    const slashes = "/".repeat(200_000);
    expect(normalizeSlug(`a${slashes}!b`)).toBe(`a${slashes}-b`);
  });
});
