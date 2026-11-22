import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { once } from "node:events";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../src/server/app.ts";
import type { DaemonHandle } from "../src/daemon/loop.ts";
import {
  type ShutdownTarget,
  gracefulShutdown,
  resetShutdownState,
  setShutdownTarget
} from "../src/server/lifecycle.ts";
import {
  isMissionControlCommand,
  isPidAlive,
  readServerInfo,
  serverInfoPath,
  stopRunningServer,
  writeServerInfo
} from "../src/server/control.ts";
import {
  abortAllInflightTurns,
  listInflightTaskIds,
  registerInflightTurn
} from "../src/runtime/sessions.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import type { AgentRunner } from "../src/runners/types.ts";

class MockRunner implements AgentRunner {
  agent = "codex" as const;
  aborted = false;

  abort(): void {
    this.aborted = true;
  }

  runTurn(): Promise<never> {
    return new Promise(() => {});
  }
}

/** Minimal shutdown target pieces with spied methods and a no-op exit. */
function fakeTarget(): ShutdownTarget {
  return {
    exit: vi.fn(),
    server: { close: vi.fn() } as unknown as Server,
    daemon: { stop: vi.fn().mockResolvedValue(undefined) } as unknown as DaemonHandle,
    onShutdown: vi.fn().mockResolvedValue(undefined)
  };
}

/**
 * Start a long-lived node process whose command line ends in `dist/server.js`,
 * the shape of a Mission Control server, so the ps check accepts it.
 */
async function spawnFakeServer(dir: string): Promise<{ child: ChildProcess; pid: number }> {
  const entry = path.join(dir, "dist", "server.js");
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [entry], { stdio: "ignore" });
  if (child.pid === undefined) throw new Error("fake server failed to start");
  return { child, pid: child.pid };
}

describe("graceful shutdown orchestration", () => {
  beforeEach(() => {
    resetShutdownState();
    abortAllInflightTurns();
  });

  afterEach(() => {
    resetShutdownState();
    abortAllInflightTurns();
  });

  it("terminates every running agent process, stops the daemon, and closes the server", async () => {
    const t = fakeTarget();
    const a = new MockRunner();
    const b = new MockRunner();
    registerInflightTurn("task-a", a);
    registerInflightTurn("task-b", b);
    setShutdownTarget(t);

    const result = await gracefulShutdown("test");

    expect(result.terminated).toBe(2);
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(true);
    expect(listInflightTaskIds()).toEqual([]);
    expect(t.daemon?.stop).toHaveBeenCalled();
    expect(t.server?.close).toHaveBeenCalled();
    expect(t.onShutdown).toHaveBeenCalled();
  });

  it("still closes the server and runs cleanup when nothing is running", async () => {
    const t = fakeTarget();
    setShutdownTarget(t);

    const result = await gracefulShutdown("idle");

    expect(result.terminated).toBe(0);
    expect(t.server?.close).toHaveBeenCalled();
    expect(t.onShutdown).toHaveBeenCalled();
  });

  it("force-exits immediately on a second shutdown request", async () => {
    const t = fakeTarget();
    setShutdownTarget(t);

    await gracefulShutdown("first");
    expect(t.exit).not.toHaveBeenCalled();

    await gracefulShutdown("second");
    expect(t.exit).toHaveBeenCalledWith(130);
  });

  it("schedules a bounded force-exit after the grace window", async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTarget();
      setShutdownTarget(t);

      await gracefulShutdown("timed");
      // Not yet: the grace window has not elapsed.
      expect(t.exit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(3_000);
      expect(t.exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("POST /api/shutdown is removed", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-shutdown-route-"));
    await ensureHarnessRepository(root);
    resetShutdownState();
  });

  afterEach(async () => {
    resetShutdownState();
    abortAllInflightTurns();
    await rm(root, { recursive: true, force: true });
  });

  it("answers 404 and never begins teardown", async () => {
    const app = createServer({ root, testMode: true });
    const t = fakeTarget();
    const runner = new MockRunner();
    registerInflightTurn("task-live", runner);
    setShutdownTarget(t);

    await request(app).post("/api/shutdown").expect(404);
    expect(runner.aborted).toBe(false);
    expect(t.server?.close).not.toHaveBeenCalled();
    expect(t.exit).not.toHaveBeenCalled();
  });
});

describe("mission-control stop (server info + SIGTERM)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-shutdown-cli-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes and reads back the server info file under the harness root", async () => {
    await writeServerInfo(root, { pid: 12345, port: 4827, host: "127.0.0.1", startedAt: "2026-06-29T00:00:00.000Z" });
    const info = await readServerInfo(root);
    expect(info).toEqual({ pid: 12345, port: 4827, host: "127.0.0.1", startedAt: "2026-06-29T00:00:00.000Z" });
    expect(serverInfoPath(root).endsWith(path.join("data", "state", "server.json"))).toBe(true);
  });

  it("reports not running when no server info exists", async () => {
    const outcome = await stopRunningServer(root);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("not running");
  });

  it("cleans up a stale info file whose pid is dead and reports not running", async () => {
    // A very large pid that no test runner owns on macOS or Linux.
    const deadPid = 4_000_000;
    expect(isPidAlive(deadPid)).toBe(false);
    await writeServerInfo(root, { pid: deadPid, port: 4827, host: "127.0.0.1", startedAt: "2026-06-29T00:00:00.000Z" });

    const outcome = await stopRunningServer(root);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("not running");
    // Stale state was removed so a subsequent call is a clean "not running".
    expect(await readServerInfo(root)).toBeNull();
  });

  it("signals the pid from server.json with SIGTERM and removes the info file once it exits", async () => {
    const { child, pid } = await spawnFakeServer(root);
    const exited = once(child, "exit");
    try {
      await writeServerInfo(root, { pid, port: 4827, host: "127.0.0.1", startedAt: "2026-06-29T00:00:00.000Z" });

      const outcome = await stopRunningServer(root);
      await exited;

      expect(outcome.ok).toBe(true);
      expect(outcome.message).toContain(`pid ${pid}`);
      expect(child.signalCode).toBe("SIGTERM");
      expect(await readServerInfo(root)).toBeNull();
    } finally {
      child.kill();
    }
  });

  it("does not signal a pid that is not a Mission Control server and removes the stale info", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    try {
      if (child.pid === undefined) throw new Error("unrelated process failed to start");
      await writeServerInfo(root, { pid: child.pid, port: 4827, host: "127.0.0.1", startedAt: "2026-06-29T00:00:00.000Z" });

      const outcome = await stopRunningServer(root);

      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain("not a Mission Control server");
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(await readServerInfo(root)).toBeNull();
    } finally {
      child.kill();
    }
  });

  it.each([
    ["node /opt/mission-control/dist/server.js", true],
    ["node --experimental-strip-types src/server/index.ts", true],
    ["node /opt/other-tool/server.js", false],
    ["node -e setInterval(() => {}, 1000);", false]
  ])("recognises Mission Control server command lines (%s)", (command, expected) => {
    expect(isMissionControlCommand(command)).toBe(expected);
  });
});
