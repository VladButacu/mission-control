import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { writeJsonFile } from "../src/core/infra/fs.ts";
import { onboardProject, projectDir } from "../src/core/projects/registry.ts";
import type { HarnessRun } from "../src/core/types.ts";
import { buildMemoryIndex } from "../src/memory/index.ts";

const base = {
  taskId: "task-1",
  taskTitle: "Run",
  agent: "codex",
  status: "completed" as const,
  startedAt: "2026-05-27T00:00:00.000Z"
};

describe("memory index run id validation", () => {
  let root: string;
  let projectId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-memory-run-id-"));
    execSync("git init", { cwd: root });
    await ensureHarnessRepository(root);
    execSync("git init alpha", { cwd: root });
    projectId = (await onboardProject(root, { repoPath: path.join(root, "alpha"), name: "alpha" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("indexes no run or run-artifact document for a stored run whose id is not a UUID", async () => {
    // Sentinels that a traversal or an empty id would reach if the id were joined unchecked.
    await mkdir(path.join(root, "data", "x"), { recursive: true });
    await writeFile(path.join(root, "data", "x", "secret.md"), "outside the runs directory", "utf8");
    await mkdir(path.join(root, "data", "runs"), { recursive: true });
    await writeFile(path.join(root, "data", "runs", "summary.md"), "root of the runs directory", "utf8");

    const runs: HarnessRun[] = ["../x", "", ".", "run-ok"].map((id) => ({
      ...base,
      id,
      projectId,
      artifacts: ["secret.md", "summary.md"]
    }));
    await writeJsonFile(root, path.join(projectDir(root, projectId), "runs.json"), runs);

    const index = await buildMemoryIndex(root, projectId);
    const runDocumentIds = index.documents
      .map((document) => document.id)
      .filter((id) => id.startsWith("run:") || id.startsWith("run-artifact:"));
    const contents = index.documents.map((document) => document.content);

    expect(runDocumentIds).toEqual([]);
    expect(contents).not.toContain("outside the runs directory");
    expect(contents).not.toContain("root of the runs directory");
  });

  it("still indexes the run document and artifacts of a valid UUID run", async () => {
    const runId = randomUUID();
    const dir = path.join(root, "data", "runs", runId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "summary.md"), "inside the runs directory", "utf8");

    const runs: HarnessRun[] = [{ ...base, id: runId, projectId, artifacts: ["summary.md"] }];
    await writeJsonFile(root, path.join(projectDir(root, projectId), "runs.json"), runs);

    const index = await buildMemoryIndex(root, projectId);

    expect(index.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `run:${runId}`, sourceType: "run" }),
        expect.objectContaining({
          id: `run-artifact:${runId}:summary.md`,
          content: "inside the runs directory"
        })
      ])
    );
  });
});
