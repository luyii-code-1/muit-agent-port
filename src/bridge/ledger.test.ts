import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BridgeLedger } from "./ledger.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("BridgeLedger", () => {
  it("turns interrupted work into a terminal failure after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-mesh-ledger-test-"));
    tempDirs.push(dir);
    const path = join(dir, "bridge.db");
    const first = new BridgeLedger(path);
    first.accept("task-1");
    first.update("task-1", "running", { threadId: "thread-1" });
    first.close();

    const restarted = new BridgeLedger(path);
    expect(restarted.get("task-1")).toMatchObject({
      status: "failed",
      threadId: "thread-1",
      error: expect.stringContaining("automatic replay was blocked"),
    });
    restarted.close();
  });

  it("preserves completed results across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-mesh-ledger-test-"));
    tempDirs.push(dir);
    const path = join(dir, "bridge.db");
    const first = new BridgeLedger(path);
    first.accept("task-2");
    first.update("task-2", "completed", { threadId: "thread-2", result: "done" });
    first.close();

    const restarted = new BridgeLedger(path);
    expect(restarted.get("task-2")).toMatchObject({ status: "completed", result: "done" });
    restarted.close();
  });
});
