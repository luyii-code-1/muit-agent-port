import { describe, expect, it } from "vitest";

import type { MeshTask } from "../shared/types.js";
import { executionModeForThread } from "./mcp.js";

function task(overrides: Partial<MeshTask>): MeshTask {
  return {
    taskId: "task-1",
    targetNodeId: "windows",
    prompt: "test",
    routing: "exact",
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("executionModeForThread", () => {
  it("keeps exact continuations of background threads in app-server mode", () => {
    expect(executionModeForThread([
      task({ selectedThreadId: "thread-1", executionMode: "background" }),
    ], "thread-1")).toBe("background");
  });

  it("does not force Desktop-owned threads into background mode", () => {
    expect(executionModeForThread([
      task({ selectedThreadId: "thread-1", executionMode: "desktop" }),
    ], "thread-1")).toBeUndefined();
  });
});
