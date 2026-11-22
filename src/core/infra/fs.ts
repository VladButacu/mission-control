import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { containedPath } from "../paths/contained.ts";

interface FileLockOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  staleMs?: number;
}

const DEFAULT_FILE_LOCK_OPTIONS: Required<FileLockOptions> = {
  maxAttempts: 100,
  retryDelayMs: 25,
  staleMs: 30_000
};

/**
 * Resolve `filePath` under the containing `root`. Every helper below calls this before it touches
 * the disk, so a path that escapes its root throws instead of reading or writing elsewhere.
 */
function pathWithin(root: string, filePath: string): string {
  const resolved = containedPath(root, filePath);
  if (!resolved) {
    throw new Error(`Path must stay inside ${root}: ${filePath}`);
  }
  return resolved;
}

function lockPathFor(filePath: string): string {
  return `${filePath}.lock`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function readLockMeta(
  root: string,
  lockPath: string
): Promise<{ pid: number; acquiredAt: number; owner?: string } | null> {
  const safeLock = pathWithin(root, lockPath);
  try {
    const raw = await readFile(safeLock, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; acquiredAt?: unknown; owner?: unknown };
    if (typeof parsed.pid === "number" && typeof parsed.acquiredAt === "number") {
      return {
        pid: parsed.pid,
        acquiredAt: parsed.acquiredAt,
        ...(typeof parsed.owner === "string" ? { owner: parsed.owner } : {})
      };
    }
  } catch {
    /* missing or corrupt lock metadata */
  }
  return null;
}

async function tryClearStaleLock(root: string, lockPath: string, staleMs: number): Promise<boolean> {
  const safeLock = pathWithin(root, lockPath);
  const meta = await readLockMeta(root, safeLock);
  if (meta) {
    const ageMs = Date.now() - meta.acquiredAt;
    const alive = await isPidAlive(meta.pid);
    if (ageMs > staleMs || !alive) {
      try {
        await rm(safeLock, { force: true });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
  // The lock file exists but its metadata could not be parsed. This happens in the
  // brief window after a holder creates the file (O_EXCL) but before its content is
  // fully written — the file reads back empty. Clearing it now would steal a live
  // holder's lock and break mutual exclusion (causing lost updates). Only treat it
  // as clearable when the file is genuinely gone, or has stayed unreadable past the
  // stale window (a holder that crashed mid-write).
  let ageMs: number;
  try {
    const stats = await stat(safeLock);
    ageMs = Date.now() - stats.mtimeMs;
  } catch {
    return true; // file does not exist — nothing holds it
  }
  if (ageMs > staleMs) {
    try {
      await rm(safeLock, { force: true });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function acquireFileLock(root: string, lockPath: string, options: Required<FileLockOptions>): Promise<string> {
  const safeLock = pathWithin(root, lockPath);
  const owner = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      await ensureDir(root, path.dirname(safeLock));
      const meta = { pid: process.pid, acquiredAt: Date.now(), owner };
      await writeFile(safeLock, `${JSON.stringify(meta)}\n`, { flag: "wx" });
      return owner;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw err;
      }
      if (await tryClearStaleLock(root, safeLock, options.staleMs)) {
        continue;
      }
      await sleep(options.retryDelayMs);
    }
  }
  throw new Error(`Timed out acquiring lock for ${safeLock}`);
}

async function releaseFileLock(root: string, lockPath: string, owner: string): Promise<void> {
  const safeLock = pathWithin(root, lockPath);
  const meta = await readLockMeta(root, safeLock);
  if (meta?.owner !== owner) {
    return;
  }
  await rm(safeLock, { force: true });
}

export async function ensureDir(root: string, dir: string): Promise<void> {
  await mkdir(pathWithin(root, dir), { recursive: true });
}

export async function writeFileIfMissing(root: string, filePath: string, content: string): Promise<void> {
  const file = pathWithin(root, filePath);
  try {
    await readFile(file, "utf8");
  } catch {
    await ensureDir(root, path.dirname(file));
    await writeFile(file, content, "utf8");
  }
}

export async function readJsonFile<T>(root: string, filePath: string, fallback: T): Promise<T> {
  const file = pathWithin(root, filePath);
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Whether a path exists on disk (swallows ENOENT and other stat errors). */
export async function pathExists(root: string, filePath: string): Promise<boolean> {
  const file = pathWithin(root, filePath);
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Read a UTF-8 file, or `null` when it is missing or unreadable. */
export async function readTextFile(root: string, filePath: string): Promise<string | null> {
  const file = pathWithin(root, filePath);
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export async function writeJsonFile<T>(root: string, filePath: string, data: T): Promise<void> {
  const file = pathWithin(root, filePath);
  await ensureDir(root, path.dirname(file));
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tempPath = pathWithin(root, `${file}.${unique}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tempPath, file);
}

export async function updateJsonFile<T>(
  root: string,
  filePath: string,
  fallback: T,
  updater: (current: T) => T | Promise<T>,
  lockOptions?: FileLockOptions
): Promise<T> {
  const options = { ...DEFAULT_FILE_LOCK_OPTIONS, ...lockOptions };
  const lockPath = lockPathFor(pathWithin(root, filePath));
  const owner = await acquireFileLock(root, lockPath, options);
  try {
    const current = await readJsonFile(root, filePath, fallback);
    const next = await updater(current);
    await writeJsonFile(root, filePath, next);
    return next;
  } finally {
    await releaseFileLock(root, lockPath, owner);
  }
}

export async function listFileNames(root: string, dir: string): Promise<string[]> {
  const target = pathWithin(root, dir);
  try {
    return await readdir(target);
  } catch {
    return [];
  }
}

export function safeRootPath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error("Target path must be relative to the harness root.");
  }
  const resolved = containedPath(root, relativePath);
  if (!resolved) {
    throw new Error("Target path must stay inside the harness root.");
  }
  return resolved;
}
