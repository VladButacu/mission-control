import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { onboardProject, projectDir } from "../src/core/projects/registry.ts";
import { removeMemoryDocument } from "../src/memory/index.ts";
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
});
