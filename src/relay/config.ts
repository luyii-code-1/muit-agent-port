import { resolve } from "node:path";

import { parsePositiveInt } from "../shared/util.js";

export interface RelayConfig {
  host: string;
  port: number;
  dbPath: string;
  mcpToken: string;
  nodeTokens: Record<string, string>;
  fallbackBridgeToken?: string;
  bridgePackagePath?: string;
}

export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const nodeTokens = parseNodeTokens(env.MESH_NODE_TOKENS);
  const mcpToken = env.MESH_MCP_TOKEN?.trim();
  if (!mcpToken || mcpToken.length < 16) throw new Error("MESH_MCP_TOKEN must be at least 16 characters");
  if (env.MESH_BRIDGE_TOKEN?.trim() && env.MESH_BRIDGE_TOKEN.trim().length < 16) {
    throw new Error("MESH_BRIDGE_TOKEN must be at least 16 characters");
  }
  return {
    host: env.MESH_HOST?.trim() || "127.0.0.1",
    port: parsePositiveInt(env.MESH_PORT, 8787),
    dbPath: resolve(env.MESH_DB_PATH?.trim() || "./data/mesh.db"),
    mcpToken,
    nodeTokens,
    fallbackBridgeToken: env.MESH_BRIDGE_TOKEN?.trim() || undefined,
    bridgePackagePath: env.MESH_BRIDGE_PACKAGE_PATH?.trim()
      ? resolve(env.MESH_BRIDGE_PACKAGE_PATH.trim())
      : undefined,
  };
}

function parseNodeTokens(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MESH_NODE_TOKENS must be a JSON object");
  }
  const entries = Object.entries(value);
  if (entries.some(([, token]) => typeof token !== "string" || token.length < 16)) {
    throw new Error("Every MESH_NODE_TOKENS value must be a string of at least 16 characters");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
