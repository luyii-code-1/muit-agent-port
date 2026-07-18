import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import type { ProjectSummary, ThreadSummary } from "../shared/types.js";

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", "work", "outputs"]);
const PROJECT_MARKERS = [".git", ".codex", "AGENTS.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "CMakeLists.txt"];

export async function scanProjects(roots: string[], threads: ThreadSummary[]): Promise<ProjectSummary[]> {
  const candidates = new Map<string, Set<string>>();
  for (const rootValue of roots) {
    const root = resolve(rootValue);
    const firstLevel = await directories(root);
    for (const child of firstLevel) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(basename(child))) {
        for (const project of await directories(child)) addCandidate(candidates, project, "codex-date-project");
      } else {
        addCandidate(candidates, child, "root-child");
      }
    }
    for (const thread of threads) {
      if (isWithin(thread.cwd, root)) addCandidate(candidates, resolve(thread.cwd), "codex-thread");
    }
  }

  const projects: ProjectSummary[] = [];
  for (const [path, discoveredMarkers] of [...candidates].slice(0, 2_000)) {
    const entries = await names(path);
    const markers = new Set(discoveredMarkers);
    for (const marker of PROJECT_MARKERS) if (entries.has(marker)) markers.add(marker);
    let updatedAt = 0;
    try {
      updatedAt = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    projects.push({
      path,
      name: basename(path),
      markers: [...markers],
      threadCount: threads.filter((thread) => resolve(thread.cwd) === path).length,
      updatedAt,
    });
  }
  return projects.sort((left, right) => right.updatedAt - left.updatedAt || left.path.localeCompare(right.path));
}

async function directories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith("."))
      .map((entry) => resolve(path, entry.name));
  } catch {
    return [];
  }
}

async function names(path: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(path));
  } catch {
    return new Set();
  }
}

function addCandidate(candidates: Map<string, Set<string>>, pathValue: string, marker: string): void {
  const path = resolve(pathValue);
  const markers = candidates.get(path) ?? new Set<string>();
  markers.add(marker);
  candidates.set(path, markers);
}

function isWithin(pathValue: string, rootValue: string): boolean {
  const child = relative(resolve(rootValue), resolve(pathValue));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
