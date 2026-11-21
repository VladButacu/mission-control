import path from "node:path";

/**
 * Resolve `candidate` against `root` and return it only when it is `root` itself or lies
 * under it. Returns undefined otherwise. The check is lexical: it does not follow symlinks,
 * and a file that does not exist yet is checked by its own path (path.resolve needs no file).
 * shortcut: lexical check only, realpath the nearest existing parent if symlinks inside the root must be refused.
 */
export function containedPath(root: string, candidate: string): string | undefined {
  const base = path.resolve(root);
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  const resolved = path.resolve(base, candidate);
  return resolved === base || resolved.startsWith(prefix) ? resolved : undefined;
}
