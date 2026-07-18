import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createEmptyInboxProject } from "./inbox.js";

describe("createEmptyInboxProject", () => {
  it("creates a unique empty project beneath the inbox root", () => {
    const root = mkdtempSync(join(tmpdir(), "mesh-inbox-"));
    const inbox = join(root, ".codex-mesh", "inbox");
    expect(createEmptyInboxProject(inbox, "task-123", [root])).toBe(join(inbox, "task-123"));
  });

  it("rejects traversal-shaped task IDs", () => {
    const root = mkdtempSync(join(tmpdir(), "mesh-inbox-"));
    expect(() => createEmptyInboxProject(join(root, "inbox"), "../escape", [root])).toThrow(/Invalid task ID/);
  });

  it("refuses to reuse a project that is no longer empty", () => {
    const root = mkdtempSync(join(tmpdir(), "mesh-inbox-"));
    const project = join(root, "inbox", "task-123");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "existing.txt"), "occupied");
    expect(() => createEmptyInboxProject(join(root, "inbox"), "task-123", [root])).toThrow(/not empty/);
  });
});
