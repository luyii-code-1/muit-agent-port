import { describe, expect, it } from "vitest";

import { applyDesktopPatches, DesktopIpc } from "./desktopIpc.js";

describe("DesktopIpc", () => {
  it("ignores a late discovery request after disconnect", () => {
    const ipc = new DesktopIpc("unused");
    expect(() => {
      Reflect.apply((ipc as unknown as { handleMessage: (message: unknown) => void }).handleMessage, ipc, [{
        type: "client-discovery-request",
        requestId: "late",
      }]);
    }).not.toThrow();
  });

  it("applies Desktop snapshot patches in place", () => {
    const state: Record<string, unknown> = { turns: [{ status: "inProgress", items: [] }] };
    applyDesktopPatches(state, [
      { op: "add", path: ["turns", 0, "items", 0], value: { type: "reasoning", summary: ["Inspecting"] } },
      { op: "replace", path: ["turns", 0, "status"], value: "completed" },
    ]);
    expect(state).toEqual({
      turns: [{ status: "completed", items: [{ type: "reasoning", summary: ["Inspecting"] }] }],
    });
  });
});
