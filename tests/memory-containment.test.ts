import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { onboardProject, projectDir } from "../src/core/projects/registry.ts";
import { createRun } from "../src/core/tasks/runs.ts";
import { buildMemoryIndex, removeMemoryDocument } from "../src/memory/index.ts";
import {
  captureMemoryPage,
  deleteMemoryPage,
  getMemoryPage,
  normalizeSlug
} from "../src/memory/store.ts";

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

describe("memory page containment", () => {
  let root: string;
  let projectId: string;
  let projectRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-memory-containment-"));
    execSync("git init", { cwd: root });
    await ensureHarnessRepository(root);
    execSync("git init alpha", { cwd: root });
    projectId = (await onboardProject(root, { repoPath: path.join(root, "alpha"), name: "alpha" })).id;
    projectRoot = projectDir(root, projectId);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps a traversal slug's page inside the project's memory pages", async () => {
    const page = await captureMemoryPage(root, projectId, {
      slug: "../escape",
      type: "note",
      title: "Escape attempt",
      content: "stays inside"
    });

    expect(existsSync(path.join(projectRoot, "memory", "escape.md"))).toBe(false);
    expect((await getMemoryPage(root, projectId, page.slug)).content).toBe("stays inside");
  });

  it("does not read or delete a page that sits outside the memory pages dir", async () => {
    const outside = path.join(projectRoot, "memory", "secret.md");
    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, "---\nslug: secret\ntitle: Secret\n---\n\nhidden\n", "utf8");

    await expect(getMemoryPage(root, projectId, "../secret")).rejects.toThrow("Memory page not found");
    expect(await deleteMemoryPage(root, projectId, "../secret")).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });

  it("refuses to touch the memory index for a project id that escapes the projects dir", async () => {
    await expect(removeMemoryDocument(root, "../../outside", "any")).rejects.toThrow();
  });

  it("does not index a run artifact whose name escapes the run directory", async () => {
    const run = await createRun(root, {
      taskId: "task-1",
      taskTitle: "Traversal run",
      projectId,
      agent: "codex",
      status: "completed",
      startedAt: "2026-05-27T00:00:00.000Z",
      artifacts: ["../../secret.md", "summary.md"]
    });
    const runDir = path.join(root, "data", "runs", run.id);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(root, "data", "secret.md"), "outside the run directory", "utf8");
    await writeFile(path.join(runDir, "summary.md"), "inside the run directory", "utf8");

    const index = await buildMemoryIndex(root, projectId);

    expect(index.documents.map((document) => document.content)).not.toContain("outside the run directory");
    expect(index.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `run-artifact:${run.id}:summary.md`, content: "inside the run directory" })
      ])
    );
  });
});
