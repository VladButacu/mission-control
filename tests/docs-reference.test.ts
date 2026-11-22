import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createServer } from "../src/server/app.ts";
import { TOOL_DEFS } from "../src/mcp/tool-registry.ts";

const REFERENCE_PATH = fileURLToPath(new URL("../docs/reference.md", import.meta.url));

/** The fields of an Express router layer that this test reads. */
interface StackLayer {
  name: string;
  route?: { path: string | RegExp; methods: Record<string, boolean> };
  handle?: { stack?: StackLayer[] };
  matchers?: Array<(pathname: string) => unknown>;
}

interface RouteEntry {
  method: string;
  path: string;
}

/** Turn a route path (string or RegExp) into the form written in the reference. */
function displayPath(routePath: string | RegExp): string {
  if (typeof routePath === "string") return routePath;
  return routePath.source
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\\//g, "/")
    .replace("(.+)", "{slug}");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routesOfLayer(layer: StackLayer, prefix: string): RouteEntry[] {
  if (!layer.route) return [];
  const full = `${prefix}${displayPath(layer.route.path)}`;
  return Object.entries(layer.route.methods)
    .filter(([, enabled]) => enabled)
    .map(([method]) => ({ method: method.toUpperCase(), path: full }));
}

/**
 * Every route registered on the live app, read from Express's own router stack.
 * Nested routers are mounted at /api by createServer; the mount is checked
 * against the real layer matcher, so moving a router fails this test.
 */
function listRegisteredRoutes(app: unknown): RouteEntry[] {
  const stack = (app as { router: { stack: StackLayer[] } }).router.stack;
  const routes: RouteEntry[] = [];
  for (const layer of stack) {
    if (layer.route) {
      routes.push(...routesOfLayer(layer, ""));
    } else if (layer.name === "router" && layer.handle?.stack) {
      expect(layer.matchers?.[0]?.("/api/probe")).toBeTruthy();
      for (const nested of layer.handle.stack) {
        routes.push(...routesOfLayer(nested, "/api"));
      }
    }
  }
  return routes;
}

describe("docs/reference.md drift", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-docs-reference-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists every registered MCP tool", async () => {
    const reference = await readFile(REFERENCE_PATH, "utf8");
    expect(TOOL_DEFS.length).toBeGreaterThan(0);
    for (const tool of TOOL_DEFS) {
      expect(reference, `MCP tool ${tool.name} is missing from docs/reference.md`).toMatch(
        new RegExp(`\\|\\s*\`${escapeRegExp(tool.name)}\`\\s*\\|`)
      );
    }
  });

  it("lists every registered HTTP method and path", async () => {
    const reference = await readFile(REFERENCE_PATH, "utf8");
    const routes = listRegisteredRoutes(createServer({ root, testMode: true }));
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      const row = new RegExp(`\\|\\s*${route.method}\\s*\\|\\s*\`${escapeRegExp(route.path)}\`\\s*\\|`);
      expect(reference, `${route.method} ${route.path} is missing from docs/reference.md`).toMatch(row);
    }
  });
});
