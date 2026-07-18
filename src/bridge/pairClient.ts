import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { BridgeConfig } from "./config.js";

interface PairResponse {
  nodeId: string;
  nodeToken: string;
  bridgeUrl: string;
}

export async function ensurePaired(config: BridgeConfig): Promise<void> {
  if (config.nodeToken) return;
  const endpoint = new URL(config.relayUrl);
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  endpoint.pathname = "/pair";
  endpoint.search = "";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: config.pairingCode, nodeId: config.nodeId }),
  });
  const body = await response.json() as PairResponse & { error?: string };
  if (!response.ok) throw new Error(body.error || `Pairing failed with HTTP ${response.status}`);
  config.nodeToken = body.nodeToken;
  config.relayUrl = body.bridgeUrl;
  mkdirSync(dirname(config.credentialsPath), { recursive: true });
  const temporaryPath = `${config.credentialsPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({
    nodeId: config.nodeId,
    nodeToken: config.nodeToken,
    relayUrl: config.relayUrl,
  }, null, 2), { mode: 0o600 });
  renameSync(temporaryPath, config.credentialsPath);
  chmodSync(config.credentialsPath, 0o600);
  console.log(`Pairing succeeded; credentials saved to ${config.credentialsPath}`);
}
