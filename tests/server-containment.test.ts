import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/server/app.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";

describe("server route path containment", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-server-containment-"));
    await ensureHarnessRepository(root);
    await mkdir(path.join(root, "data", "runs", "run-1"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves a run's own log", async () => {
    await writeFile(path.join(root, "data", "runs", "run-1", "log.txt"), "hello", "utf8");
    const app = createServer({ root, testMode: true });

    const tail = await request(app).get("/api/runs/run-1/tail?since=0").expect(200);
    expect(tail.body.chunk).toBe("hello");
  });

  it("does not tail a log file outside the runs directory", async () => {
    // runId "../.." joins to <root>/log.txt, which sits outside data/runs.
    await writeFile(path.join(root, "log.txt"), "leaked-log", "utf8");
    const app = createServer({ root, testMode: true });

    const res = await request(app).get("/api/runs/..%2F../tail?since=0").expect(400);
    expect(res.text).not.toContain("leaked-log");
  });

  it("does not send an artifact file outside the runs directory", async () => {
    // From data/runs/run-1, "../../../secret.txt" resolves to <root>/secret.txt.
    await writeFile(path.join(root, "secret.txt"), "leaked-artifact", "utf8");
    const app = createServer({ root, testMode: true });

    const res = await request(app).get("/api/runs/run-1/artifacts/..%2F..%2F..%2Fsecret.txt").expect(400);
    expect(res.text).not.toContain("leaked-artifact");
  });

  it("does not read kernel sections outside the kernel directory", async () => {
    await writeFile(path.join(root, "secret.md"), "leaked-kernel", "utf8");
    const app = createServer({ root, testMode: true });

    const res = await request(app).get("/api/kernel/..%2F..%2Fsecret").expect(404);
    expect(res.text).not.toContain("leaked-kernel");
  });
});
