import { describe, expect, it } from "vitest";

import { applyBridgeArgs } from "./args.js";

describe("applyBridgeArgs", () => {
  it("maps the one-command pairing flags to bridge configuration", () => {
    const env: NodeJS.ProcessEnv = {};
    applyBridgeArgs([
      "--relay", "ws://10.0.0.10:8787/bridge",
      "--node", "windows-pc",
      "--code", "123456",
      "--cwd", "D:\\Projects",
      "--inbox", "D:\\Projects\\.codex-mesh\\inbox",
    ], env);
    expect(env).toMatchObject({
      MESH_RELAY_URL: "ws://10.0.0.10:8787/bridge",
      MESH_NODE_ID: "windows-pc",
      MESH_PAIRING_CODE: "123456",
      MESH_DEFAULT_CWD: "D:\\Projects",
      MESH_INBOX_ROOT: "D:\\Projects\\.codex-mesh\\inbox",
    });
  });
});
