import { describe, expect, it } from "vitest";

import { DesktopIpc } from "./desktopIpc.js";

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
});
