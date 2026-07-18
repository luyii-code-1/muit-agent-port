import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MeshStore } from "./store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("MeshStore", () => {
  it("persists nodes and task lifecycle", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-mesh-test-"));
    tempDirs.push(dir);
    const store = new MeshStore(join(dir, "mesh.db"));
    store.upsertNode({ id: "mac", hostname: "Mac", platform: "darwin", labels: ["frontend"] });
    store.updateThreads("mac", [{
      id: "thread-1",
      name: "UI",
      preview: "Build UI",
      cwd: "/work/app",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    }]);
    const now = Date.now();
    store.createTask({
      taskId: "task-1",
      targetNodeId: "mac",
      prompt: "Review this",
      routing: "best",
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
    store.updateTask("task-1", { status: "completed", selectedThreadId: "thread-1", result: "done" });

    expect(store.getNode("mac")?.threads[0]?.id).toBe("thread-1");
    expect(store.getTask("task-1")).toMatchObject({
      status: "completed",
      selectedThreadId: "thread-1",
      result: "done",
    });
    store.close();
  });

  it("reoffers running tasks after a node reconnects", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-mesh-test-"));
    tempDirs.push(dir);
    const store = new MeshStore(join(dir, "mesh.db"));
    const now = Date.now();
    store.createTask({
      taskId: "task-running",
      targetNodeId: "mac",
      prompt: "Continue",
      routing: "new",
      status: "running",
      selectedThreadId: "thread-running",
      createdAt: now,
      updatedAt: now,
    });
    expect(store.listPendingTasks("mac").map((task) => task.taskId)).toContain("task-running");
    store.close();
  });
});
