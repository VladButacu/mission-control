import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { containedPath } from "../src/core/paths/contained.ts";
import { extractTargets } from "../src/core/paths/targets.ts";

const TIME_BOUND_MS = 1_000;

describe("containedPath", () => {
  const root = path.resolve("harness-root");

  it("accepts the root itself and paths under it", () => {
    expect(containedPath(root, root)).toBe(root);
    expect(containedPath(root, path.join("app", "index.html"))).toBe(path.join(root, "app", "index.html"));
  });

  it("rejects paths outside the root, including a sibling that shares its prefix", () => {
    expect(containedPath(root, `${root}-evil`)).toBeUndefined();
    expect(containedPath(root, path.join("..", "secret"))).toBeUndefined();
    expect(containedPath(root, path.parse(root).root + "etc")).toBeUndefined();
  });

  it("resolves dot segments before checking containment", () => {
    expect(containedPath(root, path.join("app", "..", "index.html"))).toBe(path.join(root, "index.html"));
    expect(containedPath(path.parse(root).root, "etc")).toBe(path.join(path.parse(root).root, "etc"));
  });
});

describe("containedPath follows symlinks", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-contained-"));
    outside = await mkdtemp(path.join(tmpdir(), "harness-outside-"));
    await ensureHarnessRepository(root);
    await symlink(outside, path.join(root, "escape"), "dir");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("refuses a symlink inside the root that points outside it", () => {
    expect(containedPath(root, "escape")).toBeUndefined();
  });

  it("refuses a file that does not exist yet under a symlinked directory pointing outside", () => {
    expect(containedPath(root, path.join("escape", "new.txt"))).toBeUndefined();
  });

  it("returns the lexical path for a nested file that does not exist yet under the root", () => {
    expect(containedPath(root, path.join("a", "b", "c.txt"))).toBe(path.join(root, "a", "b", "c.txt"));
  });

  it("still contains the children of a root that sits behind a symlinked prefix", () => {
    // On macOS, tmpdir() is under /var, which is a symlink to /private/var.
    expect(containedPath(root, root)).toBe(root);
    expect(containedPath(root, "child.txt")).toBe(path.join(root, "child.txt"));
  });
});

describe("path target parsing stays linear on adversarial input", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-core-paths-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("returns quickly for many escaped backticks inside an unclosed backtick path", async () => {
    // Shape that made the old backtick pattern quadratic: each "`/" restarts a scan through every "\`".
    const adversarial = "`/" + "\\`/".repeat(20_000);

    const started = performance.now();
    await extractTargets(adversarial, { homeRoot: root });

    expect(performance.now() - started).toBeLessThan(TIME_BOUND_MS);
  });

  it("returns quickly for a long run of trailing punctuation", async () => {
    const adversarial = `@x${"!".repeat(50_000)}`;

    const started = performance.now();
    const targets = await extractTargets(adversarial, { homeRoot: root });

    expect(targets).toEqual([]);
    expect(performance.now() - started).toBeLessThan(TIME_BOUND_MS);
  });
});
