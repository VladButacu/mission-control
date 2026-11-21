import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveCommandBinary } from "../src/core/agents/resolver.ts";

describe("resolveCommandBinary", () => {
  it.skipIf(process.platform === "win32")("passes the binary name as data, never as shell syntax", () => {
    const marker = path.join(tmpdir(), `resolver-injection-${process.pid}-${Date.now()}`);
    try {
      expect(() => resolveCommandBinary(`x; touch ${marker}`)).toThrow(/Failed to resolve/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(marker, { force: true });
    }
  });
});
