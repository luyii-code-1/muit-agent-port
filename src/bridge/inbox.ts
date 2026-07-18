import { mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { assertAllowedCwd } from "./config.js";

export function createEmptyInboxProject(
  inboxRoot: string,
  taskId: string,
  allowedRoots: string[],
): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) {
    throw new Error("Invalid task ID for Mesh inbox project");
  }
  const project = assertAllowedCwd(resolve(inboxRoot, taskId), allowedRoots);
  mkdirSync(project, { recursive: true });
  if (readdirSync(project).length !== 0) {
    throw new Error(`Mesh inbox project is not empty: ${project}`);
  }
  return project;
}
