import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "../core/infra/fs.ts";
import { ensureHarnessRepository } from "../core/bootstrap/repository.ts";
import { containedPath } from "../core/paths/contained.ts";
import { listProjects, projectDir } from "../core/projects/registry.ts";
import { rankSearchResults, tokenize } from "./search-utils.ts";

const SLUG_OUTSIDE_PAGES = "Memory slug must stay inside the project's memory pages.";

export interface MemoryPageInput {
  slug: string;
  type: string;
  title: string;
  tags?: string[];
  content: string;
}

export interface MemoryPageSummary {
  /** Onboarded project this page belongs to. */
  projectId: string;
  slug: string;
  type: string;
  title: string;
  tags: string[];
  updatedAt: string;
}

export interface MemoryPage extends MemoryPageSummary {
  content: string;
}

export interface MemorySearchResult extends MemoryPageSummary {
  score: number;
  snippet: string;
}

/**
 * Memory is scoped per project: every page lives under
 * `data/state/projects/<projectId>/memory/pages/<slug>.md`. Isolation is by
 * directory — there is no global memory and no slug-prefix scoping.
 */
function pagesRoot(root: string, projectId: string): string {
  return path.join(projectDir(root, projectId), "memory", "pages");
}

/** Strips leading and trailing slashes in one linear pass (a `/\/+$/` regex is quadratic on long slash runs). */
function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "/") start++;
  while (end > start && value[end - 1] === "/") end--;
  return value.slice(start, end);
}

export function normalizeSlug(slug: string): string {
  const normalized = trimSlashes(slug.trim().replace(/\\/g, "/"))
    .replace(/[^a-zA-Z0-9/_-]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
  if (!normalized || normalized.includes("..")) {
    throw new Error("Memory slug must be a safe relative path.");
  }
  return normalized;
}

function serializePage(input: MemoryPageInput): string {
  const tags = input.tags ?? [];
  return `---
slug: ${normalizeSlug(input.slug)}
type: ${input.type.trim() || "note"}
title: ${input.title.trim()}
tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]
updated_at: ${new Date().toISOString()}
---

${input.content.trim()}
`;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  if (!content.startsWith("---\n")) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }
  const raw = content.slice(4, end).trim();
  const body = content.slice(end + 4).trim();
  const frontmatter: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { frontmatter, body };
}

function parseTags(raw?: string): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((tag) => tag.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function pageFromMarkdown(root: string, projectId: string, filePath: string, markdown: string): MemoryPage {
  const { frontmatter, body } = parseFrontmatter(markdown);
  const fallbackSlug = path
    .relative(pagesRoot(root, projectId), filePath)
    .replace(/\.md$/, "")
    .replace(/\\/g, "/");
  const slug = frontmatter["slug"] || fallbackSlug;
  return {
    projectId,
    slug,
    type: frontmatter["type"] || "note",
    title: frontmatter["title"] || slug,
    tags: parseTags(frontmatter["tags"]),
    updatedAt: frontmatter["updated_at"] || "",
    content: body
  };
}

async function walkMarkdown(base: string, dir = base): Promise<string[]> {
  const safeDir = containedPath(base, dir);
  if (!safeDir) return [];
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(safeDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(safeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdown(base, fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function captureMemoryPage(root: string, projectId: string, input: MemoryPageInput): Promise<MemoryPage> {
  await ensureHarnessRepository(root);
  const filePath = containedPath(pagesRoot(root, projectId), `${normalizeSlug(input.slug)}.md`);
  if (!filePath) throw new Error(SLUG_OUTSIDE_PAGES);
  await mkdir(path.dirname(filePath), { recursive: true });
  const markdown = serializePage(input);
  await writeFile(filePath, markdown, "utf8");
  return pageFromMarkdown(root, projectId, filePath, markdown);
}

export async function listMemoryPages(root: string, projectId: string): Promise<MemoryPageSummary[]> {
  await ensureHarnessRepository(root);
  const pagesDir = pagesRoot(root, projectId);
  await ensureDir(root, pagesDir);
  const files = await walkMarkdown(pagesDir);
  const pages = await Promise.all(files.map((file) => readMemoryFile(root, projectId, file)));
  return pages
    .map(({ content: _content, ...summary }) => summary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.slug.localeCompare(b.slug));
}

/** Pages across every onboarded project, each summary stamped with its projectId. */
export async function listAllMemoryPages(root: string): Promise<MemoryPageSummary[]> {
  const projects = await listProjects(root);
  const perProject = await Promise.all(projects.map((project) => listMemoryPages(root, project.id)));
  return perProject.flat();
}

export async function getMemoryPage(root: string, projectId: string, slug: string): Promise<MemoryPage> {
  await ensureHarnessRepository(root);
  const normalized = normalizeSlug(slug);
  const filePath = containedPath(pagesRoot(root, projectId), `${normalized}.md`);
  if (!filePath) throw new Error(SLUG_OUTSIDE_PAGES);
  try {
    return pageFromMarkdown(root, projectId, filePath, await readFile(filePath, "utf8"));
  } catch {
    throw new Error(`Memory page not found: ${normalized}`);
  }
}

export async function deleteMemoryPage(root: string, projectId: string, slug: string): Promise<boolean> {
  await ensureHarnessRepository(root);
  const normalized = normalizeSlug(slug);
  const filePath = containedPath(pagesRoot(root, projectId), `${normalized}.md`);
  if (!filePath) throw new Error(SLUG_OUTSIDE_PAGES);
  try {
    await unlink(filePath);
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  return true;
}

export async function searchMemoryPages(
  root: string,
  projectId: string,
  query: string
): Promise<MemorySearchResult[]> {
  await ensureHarnessRepository(root);
  const terms = tokenize(query);
  if (!terms.length) {
    return [];
  }
  const files = await walkMarkdown(pagesRoot(root, projectId));
  const pages = await Promise.all(files.map((file) => readMemoryFile(root, projectId, file)));
  return rankSearchResults(pages, terms, {
    getHaystack: (page) => `${page.slug} ${page.type} ${page.title} ${page.tags.join(" ")} ${page.content}`,
    getSnippetSource: (page) => page.content,
    mode: "presence",
    snippetLength: 220,
    sortKey: (a, b) => a.slug.localeCompare(b.slug)
  });
}

async function readMemoryFile(root: string, projectId: string, filePath: string): Promise<MemoryPage> {
  const safePath = containedPath(pagesRoot(root, projectId), filePath);
  if (!safePath) throw new Error(SLUG_OUTSIDE_PAGES);
  return pageFromMarkdown(root, projectId, safePath, await readFile(safePath, "utf8"));
}
