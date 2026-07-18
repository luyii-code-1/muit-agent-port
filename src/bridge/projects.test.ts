import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { scanProjects } from "./projects.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("scanProjects", () => {
  it("finds every project beneath Codex date directories and associates threads", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-project-scan-"));
    tempDirs.push(root);
    const first = join(root, "2026-07-18", "alpha");
    const second = join(root, "2026-07-18", "beta");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    writeFileSync(join(first, "AGENTS.md"), "# test");
    const projects = await scanProjects([root], [{
      id: "thread-alpha",
      preview: "alpha",
      cwd: first,
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    }]);
    expect(projects.map((project) => project.name).sort()).toEqual(["alpha", "beta"]);
    expect(projects.find((project) => project.name === "alpha")).toMatchObject({
      threadCount: 1,
      markers: expect.arrayContaining(["AGENTS.md", "codex-date-project"]),
    });
  });
});
