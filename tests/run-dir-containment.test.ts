import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { writeJsonFile } from "../src/core/infra/fs.ts";
import { EntityNotFoundError } from "../src/core/tasks/errors.ts";
import { cleanRuns } from "../src/core/tasks/runs.ts";
import { isRunId, parseRunId } from "../src/core/tasks/run-id.ts";
import type { HarnessRun } from "../src/core/types.ts";
import { callTool } from "../src/mcp/tool-registry.ts";
import type { McpToolContext } from "../src/mcp/types.ts";

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

describe("read_run run id boundary", () => {
  let root: string;
  let ctx: McpToolContext;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-read-run-"));
    await ensureHarnessRepository(root);
    ctx = { root, runId: "test-run" };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads the artifact of a valid run", async () => {
    const runId = randomUUID();
    const dir = path.join(root, "data", "runs", runId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "summary.md"), "valid summary", "utf8");

    const result = (await callTool(ctx, "read_run", { runId })) as { content: { text: string }[] };

    expect(result.content[0]?.text).toContain("valid summary");
  });

  it.each(["../x", "", ".", "run-ok"])("returns not-found for the non-UUID run id %j", async (runId) => {
    const outside = path.join(root, "data", "x");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "summary.md"), "outside the runs directory", "utf8");

    const thrown = await callTool(ctx, "read_run", { runId }).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(EntityNotFoundError);
    expect((thrown as Error).message).toBe(`Run not found: ${runId}`);
  });
});

describe("cleanRuns run id boundary", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-clean-runs-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("deletes nothing outside data/runs for stored non-UUID ids and removes a valid UUID run", async () => {
    // Sentinels a traversal or an empty id would reach if the id were joined unchecked.
    const outside = path.join(root, "data", "x", "sentinel.txt");
    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, "outside", "utf8");
    const otherRun = path.join(root, "data", "runs", "other-run", "keep.txt");
    await mkdir(path.dirname(otherRun), { recursive: true });
    await writeFile(otherRun, "other run", "utf8");

    const validId = randomUUID();
    const validDir = path.join(root, "data", "runs", validId);
    await mkdir(validDir, { recursive: true });
    await writeFile(path.join(validDir, "summary.md"), "valid", "utf8");

    const base = { taskId: "task-1", taskTitle: "Run", agent: "codex", startedAt: "2026-05-27T00:00:00.000Z", artifacts: [] };
    const runs: HarnessRun[] = [
      { ...base, id: "../x", status: "completed" },
      { ...base, id: "", status: "completed" },
      { ...base, id: ".", status: "completed" },
      { ...base, id: validId, status: "completed" }
    ];
    await writeJsonFile(root, path.join(root, "data", "state", "runs.json"), runs);

    const result = await cleanRuns(root);

    expect(result).toEqual({ deleted: 4 });
    expect(await readFile(outside, "utf8")).toBe("outside");
    expect(await readFile(otherRun, "utf8")).toBe("other run");
    await expect(readFile(path.join(validDir, "summary.md"), "utf8")).rejects.toThrow();
  });
});
