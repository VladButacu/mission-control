import { realpathSync } from "node:fs";
import path from "node:path";

/** Real path of `target`, or of its nearest existing ancestor with the missing tail re-joined. */
function realpathOfNearestAncestor(target: string): string {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `resolved` lies outside the real location of `base` once symlinks are followed. */
function escapesThroughSymlink(base: string, resolved: string): boolean {
  let realBase: string;
  try {
    realBase = realpathSync(base);
  } catch {
    return false; // a root that does not exist yet cannot contain a symlink
  }
  const realPrefix = realBase.endsWith(path.sep) ? realBase : `${realBase}${path.sep}`;
  const realResolved = realpathOfNearestAncestor(resolved);
  return realResolved !== realBase && !realResolved.startsWith(realPrefix);
}

/**
 * Resolve `candidate` against `root` and return it only when it is `root` itself or lies
 * under it. Returns undefined otherwise. Symlinks are followed for the existing part of the
 * path, so a symlink inside the root that points outside it is refused. A path that does not
 * exist yet is checked through its nearest existing ancestor. The returned value is the lexical
 * resolved path.
 */
export function containedPath(root: string, candidate: string): string | undefined {
  const base = path.resolve(root);
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  const resolved = path.resolve(base, candidate);
  if (resolved === base) return base;
  if (escapesThroughSymlink(base, resolved)) return undefined;
  if (!resolved.startsWith(prefix)) return undefined;
  return resolved;
}
