import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { normalizeSlug } from "../src/memory/store.ts";

const SEED = 20260521;
const NUM_RUNS = 200;
const REFUSAL = "Memory slug must be a safe relative path.";

// Pieces that mix traversal, separators, NUL, percent-encoded dots and long segments.
const HOSTILE_PIECES = [
  "..",
  ".",
  "/",
  "/",
  "\\",
  "\0",
  "%2e",
  "%2E%2e",
  "%2f",
  "%5c",
  "a".repeat(300),
  "x",
  "-",
  " "
];

const hostileSlug = fc
  .array(fc.constantFrom(...HOSTILE_PIECES), { maxLength: 16 })
  .map((parts) => parts.join(""));

const slug = fc.oneof(fc.string({ unit: "grapheme" }), hostileSlug);

/**
 * normalizeSlug refuses empty and traversal slugs by throwing. A refusal is a valid outcome;
 * any other error is a real failure and is rethrown.
 */
function normalizeOrUndefined(input: string): string | undefined {
  try {
    return normalizeSlug(input);
  } catch (error) {
    if (error instanceof Error && error.message === REFUSAL) return undefined;
    throw error;
  }
}

describe("normalizeSlug properties", () => {
  it("never returns a slug with '..' or a leading or trailing slash", () => {
    fc.assert(
      fc.property(slug, (input) => {
        const result = normalizeOrUndefined(input);
        return (
          result === undefined ||
          (!result.includes("..") && !result.startsWith("/") && !result.endsWith("/"))
        );
      }),
      { seed: SEED, numRuns: NUM_RUNS }
    );
  });

  it("normalizes a long slash run in linear time", () => {
    // A trailing-slash regex is quadratic on this input. The bound is generous on purpose:
    // it catches a quadratic blow-up, not normal scheduler jitter.
    const slashes = "/".repeat(200_000);
    const started = performance.now();
    expect(normalizeSlug(`a${slashes}!b`)).toBe(`a${slashes}-b`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
