import { describe, expect, it } from "vitest";

import { buildInstallKit } from "./installKit.js";

describe("buildInstallKit", () => {
  it("builds a Windows script and an AI deployment prompt", () => {
    const kit = buildInstallKit({
      platform: "windows",
      nodeId: "win-app",
      roles: ["Android", "BLE"],
      pairingCode: "123456",
      relayHttpUrl: "http://mesh.local:8787",
    });
    expect(kit.script).toContain("MESH_PAIRING_CODE");
    expect(kit.script).toContain("ws://mesh.local:8787/bridge");
    expect(kit.promptMarkdown).toContain("win-app");
    expect(kit.promptMarkdown).toContain("Android");
  });
});
