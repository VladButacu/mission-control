import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { DEFAULT_HARNESS_ROOT } from "../core/bootstrap/repository.ts";
import { ensureDir, writeJsonFile } from "../core/infra/fs.ts";

/**
 * Cross-process stop control. The running server writes a small info file
 * (pid + port + host) under the harness root on startup. `mission-control stop`
 * reads it in a separate process, confirms the pid is still a Mission Control
 * server, and sends SIGTERM. The server then runs its graceful shutdown path,
 * which removes the info file.
 */

export interface ServerInfo {
  /** OS process id of the running server. */
  pid: number;
  /** Port the HTTP server listens on. */
  port: number;
  /** Host the HTTP server listens on (loopback by default). */
  host: string;
  /** ISO timestamp the server started. */
  startedAt: string;
}

const execFileAsync = promisify(execFile);

/**
 * Command lines of a Mission Control server: the source entry (`src/server/index.ts`,
 * used by `mc`) and the bundled entry (`dist/server.js`, used by `bin/mc.js`).
 * shortcut: matches the entry path only, so a renamed entry must update this pattern.
 */
const SERVER_COMMAND = /(?:^|[\s/])(?:src\/server\/index\.ts|dist\/server\.js)(?:\s|$)/;

/** Bounded wait after SIGTERM. Covers the server's 3s force-exit grace and the 2s runner kill backstop. */
const STOP_WAIT_MS = 10_000;
const STOP_POLL_MS = 100;

/** Location of the runtime server-info file under a harness root. */
export function serverInfoPath(root: string): string {
  return path.join(root, "data", "state", "server.json");
}

/** Record the running server's identity so `mission-control stop` can reach it. */
export async function writeServerInfo(root: string, info: ServerInfo): Promise<void> {
  await ensureDir(root, path.dirname(serverInfoPath(root)));
  await writeJsonFile(root, serverInfoPath(root), info);
}

/** Remove the server-info file (called during graceful shutdown). */
export async function removeServerInfo(root: string): Promise<void> {
  await rm(serverInfoPath(root), { force: true });
}

/** Read the recorded server info, or null when no server has registered. */
export async function readServerInfo(root: string): Promise<ServerInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(serverInfoPath(root), "utf8")) as Partial<ServerInfo>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.port === "number" &&
      typeof parsed.host === "string"
    ) {
      return {
        pid: parsed.pid,
        port: parsed.port,
        host: parsed.host,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : ""
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve the harness root the same way the server does. */
export function resolveHarnessRoot(): string {
  return process.env["HARNESS_ROOT"]?.trim() || DEFAULT_HARNESS_ROOT;
}

/** True when a process with this pid exists (or exists and is owned elsewhere). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = it exists but we can't signal it.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when a process command line is a Mission Control server entry. */
export function isMissionControlCommand(command: string): boolean {
  return SERVER_COMMAND.test(command);
}

/** Command line of a pid as reported by ps, or "" when ps cannot find it. */
async function commandOf(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Poll until the pid is gone. Returns false when it is still alive at the deadline. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(STOP_POLL_MS);
  }
  return true;
}

export interface StopOutcome {
  ok: boolean;
  message: string;
}

/**
 * Stop the running Mission Control server with SIGTERM. Reads the server-info
 * file and signals the recorded pid only after ps confirms it is a Mission
 * Control server; a reused pid is left alone and its stale record is removed.
 * Never throws: callers print `message` and exit with `ok ? 0 : 1`.
 */
export async function stopRunningServer(root: string = resolveHarnessRoot()): Promise<StopOutcome> {
  const info = await readServerInfo(root);
  if (!info) {
    return { ok: false, message: "Mission Control is not running." };
  }
  if (!isPidAlive(info.pid)) {
    // Stale info left by a crashed/killed server. Clean it up so the next start
    // and subsequent stop calls report correctly.
    await removeServerInfo(root);
    return { ok: false, message: "Mission Control is not running (cleaned up stale state)." };
  }
  if (!isMissionControlCommand(await commandOf(info.pid))) {
    await removeServerInfo(root);
    return {
      ok: false,
      message: `pid ${info.pid} in server.json is not a Mission Control server. Did not signal it; removed the stale server info.`
    };
  }

  try {
    process.kill(info.pid, "SIGTERM");
  } catch (err) {
    // ESRCH means it exited after the check above; the wait below reports that.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      return { ok: false, message: `Could not signal Mission Control (pid ${info.pid}): ${(err as Error).message}` };
    }
  }

  if (!(await waitForExit(info.pid, STOP_WAIT_MS))) {
    return {
      ok: false,
      message:
        `Mission Control (pid ${info.pid}) is still running ${STOP_WAIT_MS / 1000}s after SIGTERM. ` +
        `It may still be shutting down; check with \`ps -p ${info.pid}\`.`
    };
  }
  await removeServerInfo(root);
  return { ok: true, message: `Mission Control (pid ${info.pid}) stopped.` };
}
