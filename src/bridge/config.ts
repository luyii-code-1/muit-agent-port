import { hostname, platform } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { readFileSync } from "node:fs";

import { parsePositiveInt } from "../shared/util.js";

export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface BridgeConfig {
  relayUrl: string;
  nodeId: string;
  nodeToken: string;
  pairingCode?: string;
  credentialsPath: string;
  nodeHostname: string;
  nodePlatform: string;
  labels: string[];
  roles: string[];
  defaultCwd: string;
  inboxRoot: string;
  allowedRoots: string[];
  codexCommand: string;
  concurrency: number;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  refreshMs: number;
  ledgerPath: string;
}

export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const credentialsPath = resolve(env.MESH_CREDENTIALS_PATH?.trim() || "./data/bridge-credentials.json");
  const stored = readCredentials(credentialsPath);
  const relayUrl = env.MESH_RELAY_URL?.trim() || stored?.relayUrl || "";
  if (!relayUrl) throw new Error("MESH_RELAY_URL is required");
  const parsedRelay = new URL(relayUrl);
  if (parsedRelay.protocol !== "ws:" && parsedRelay.protocol !== "wss:") {
    throw new Error("MESH_RELAY_URL must use ws:// or wss://");
  }
  const nodeId = env.MESH_NODE_ID?.trim() || stored?.nodeId || "";
  if (!nodeId) throw new Error("MESH_NODE_ID is required");
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(nodeId)) {
    throw new Error("MESH_NODE_ID may only contain letters, digits, dot, underscore, and dash");
  }
  const nodeToken = env.MESH_NODE_TOKEN?.trim() || stored?.nodeToken || "";
  const pairingCode = env.MESH_PAIRING_CODE?.trim();
  if (!nodeToken && !pairingCode) throw new Error("Set MESH_NODE_TOKEN or a first-run MESH_PAIRING_CODE");
  if (nodeToken && nodeToken.length < 16) throw new Error("MESH_NODE_TOKEN must be at least 16 characters");
  if (pairingCode && !/^\d{6}$/.test(pairingCode)) throw new Error("MESH_PAIRING_CODE must be six digits");
  const defaultCwd = resolve(required(env.MESH_DEFAULT_CWD, "MESH_DEFAULT_CWD"));
  const allowedRoots = (env.MESH_ALLOWED_ROOTS?.split(",") ?? [defaultCwd])
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value));
  const approvalPolicy = (env.MESH_APPROVAL_POLICY || "never") as ApprovalPolicy;
  if (!["untrusted", "on-request", "never"].includes(approvalPolicy)) {
    throw new Error("MESH_APPROVAL_POLICY must be untrusted, on-request, or never");
  }
  const sandbox = (env.MESH_SANDBOX || "workspace-write") as SandboxMode;
  if (!["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) {
    throw new Error("MESH_SANDBOX must be read-only, workspace-write, or danger-full-access");
  }
  if (!allowedRoots.some((root) => isWithinRoot(defaultCwd, root))) {
    throw new Error("MESH_DEFAULT_CWD must be inside MESH_ALLOWED_ROOTS");
  }
  const inboxRoot = resolve(
    env.MESH_INBOX_ROOT?.trim() || resolve(defaultCwd, ".codex-mesh", "inbox"),
  );
  if (!allowedRoots.some((root) => isWithinRoot(inboxRoot, root))) {
    throw new Error("MESH_INBOX_ROOT must be inside MESH_ALLOWED_ROOTS");
  }
  return {
    relayUrl,
    nodeId,
    nodeToken,
    pairingCode,
    credentialsPath,
    nodeHostname: hostname(),
    nodePlatform: platform(),
    labels: (env.MESH_NODE_LABELS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    roles: (env.MESH_NODE_ROLES ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    defaultCwd,
    inboxRoot,
    allowedRoots,
    codexCommand: env.MESH_CODEX_COMMAND?.trim() || "codex",
    concurrency: parsePositiveInt(env.MESH_BRIDGE_CONCURRENCY, 1),
    approvalPolicy,
    sandbox,
    refreshMs: Math.max(parsePositiveInt(env.MESH_THREAD_REFRESH_MS, 30_000), 5_000),
    ledgerPath: resolve(env.MESH_BRIDGE_DB_PATH?.trim() || `./data/bridge-${nodeId}.db`),
  };
}

interface StoredCredentials {
  nodeId: string;
  nodeToken: string;
  relayUrl: string;
}

function readCredentials(path: string): StoredCredentials | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as StoredCredentials;
    return value.nodeId && value.nodeToken && value.relayUrl ? value : undefined;
  } catch {
    return undefined;
  }
}

export function assertAllowedCwd(path: string, allowedRoots: string[]): string {
  const resolved = resolve(path);
  if (!isAllowedCwd(resolved, allowedRoots)) {
    throw new Error(`Requested cwd is outside MESH_ALLOWED_ROOTS: ${resolved}`);
  }
  return resolved;
}

export function isAllowedCwd(path: string, allowedRoots: string[]): boolean {
  const resolved = resolve(path);
  return allowedRoots.some((root) => isWithinRoot(resolved, root));
}

function isWithinRoot(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}
