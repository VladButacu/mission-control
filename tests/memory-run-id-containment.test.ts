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

describe("memory index run containment", () => {
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

  it("does not index artifacts of a run whose id escapes the runs directory", async () => {
    const escapedDir = path.join(root, "data", "x");
    await mkdir(escapedDir, { recursive: true });
    await writeFile(path.join(escapedDir, "secret.md"), "outside the runs directory", "utf8");

    const normalDir = path.join(root, "data", "runs", "run-ok");
    await mkdir(normalDir, { recursive: true });
    await writeFile(path.join(normalDir, "summary.md"), "inside the runs directory", "utf8");

    const base = {
      taskId: "task-1",
      taskTitle: "Run",
      projectId,
      agent: "codex",
      status: "completed" as const,
      startedAt: "2026-05-27T00:00:00.000Z"
    };
    const runs: HarnessRun[] = [
      { ...base, id: "../x", artifacts: ["secret.md"] },
      { ...base, id: "run-ok", artifacts: ["summary.md"] }
    ];
    await writeJsonFile(root, path.join(projectDir(root, projectId), "runs.json"), runs);

    const index = await buildMemoryIndex(root, projectId);
    const contents = index.documents.map((document) => document.content);

    expect(contents).not.toContain("outside the runs directory");
    expect(index.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "run-artifact:run-ok:summary.md", content: "inside the runs directory" })
      ])
    );
  });
});
