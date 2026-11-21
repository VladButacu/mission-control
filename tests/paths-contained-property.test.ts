import path from "node:path";
import fc from "fast-check";
import { describe, it } from "vitest";

import { containedPath } from "../src/core/paths/contained.ts";

const BASE = path.resolve("property-root", "pages");
const SEED = 20260521;
const NUM_RUNS = 200;

// Pieces that try to climb out of the base or hide a traversal from a naive check.
const HOSTILE_PIECES = [
  "..",
  ".",
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
  "_"
];

const hostileCandidate = fc
  .array(fc.constantFrom(...HOSTILE_PIECES), { maxLength: 12 })
  .map((parts) => parts.join(""));

const candidate = fc.oneof(fc.string({ unit: "grapheme" }), hostileCandidate);

// Plain segments: the only shape that must always resolve inside the base.
const plainSegment = fc.stringMatching(/^[a-z0-9_-]{1,64}$/);

/** True when `target` is the base itself or lies under it, judged by path segments. */
function staysInside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

describe("containedPath properties", () => {
  it("returns undefined or a path that stays inside the base for any input", () => {
    fc.assert(
      fc.property(candidate, (input) => {
        const result = containedPath(BASE, input);
        return result === undefined || staysInside(BASE, result);
      }),
      { seed: SEED, numRuns: NUM_RUNS }
    );
  });

  it("resolves a plain segment to path.join(base, segment) inside the base", () => {
    fc.assert(
      fc.property(plainSegment, (segment) => {
        const result = containedPath(BASE, segment);
        return result === path.join(BASE, segment) && staysInside(BASE, result);
      }),
      { seed: SEED, numRuns: NUM_RUNS }
    );
  });
});
