import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { EntityNotFoundError } from "../src/core/tasks/errors.ts";
import { isRunId, parseRunId } from "../src/core/tasks/run-id.ts";

describe("run id validation", () => {
  it("accepts a UUID as produced by crypto.randomUUID()", () => {
    const id = randomUUID();

    expect(isRunId(id)).toBe(true);
    expect(parseRunId(id)).toBe(id);
  });

  it.each(["../x", "", ".", "run-ok", "/etc/passwd", "0F0F0F0F-0F0F-0F0F-0F0F-0F0F0F0F0F0F"])(
    "rejects %j as not-found",
    (runId) => {
      expect(isRunId(runId)).toBe(false);
      expect(() => parseRunId(runId)).toThrow(EntityNotFoundError);
      expect(() => parseRunId(runId)).toThrow(`Run not found: ${runId}`);
    }
  );

  it("rejects non-string input", () => {
    expect(isRunId(undefined)).toBe(false);
    expect(() => parseRunId(undefined)).toThrow(EntityNotFoundError);
  });
});
