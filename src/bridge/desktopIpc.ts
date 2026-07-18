import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";

import type { CodexProgress } from "./codexAppServer.js";

interface IpcMessage {
  type: string;
  requestId?: string;
  sourceClientId?: string;
  targetClientId?: string;
  method?: string;
  version?: number;
  params?: Record<string, unknown>;
  resultType?: "success" | "error";
  result?: unknown;
  error?: string;
  response?: { canHandle: boolean };
}

interface PendingRequest {
  resolve: (message: IpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DesktopTurnOptions {
  threadId: string;
  prompt: string;
  cwd: string;
  approvalPolicy: string;
}

/**
 * Connects to the local Codex Desktop IPC router. This is intentionally kept
 * separate from app-server: the Desktop process remains the owner of the turn,
 * so its normal task UI receives the same live stream.
 */
export class DesktopIpc extends EventEmitter {
  private socket?: Socket;
  private clientId = "initializing-client";
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly endpoint = desktopIpcEndpoint()) {
    super();
  }

  async connect(): Promise<void> {
    if (this.socket?.writable && this.clientId !== "initializing-client") return;
    const socket = connect(this.endpoint);
    this.socket = socket;
    socket.on("data", (chunk) => this.readFrames(chunk));
    socket.on("close", () => this.disconnect(new Error("Codex Desktop IPC disconnected")));
    socket.on("error", (error) => this.disconnect(error));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const response = await this.request("initialize", { clientType: "codex-mesh-bridge" }, 0, 5_000);
    const result = response.result as { clientId?: string } | undefined;
    if (!result?.clientId) throw new Error("Codex Desktop IPC initialization returned no client id");
    this.clientId = result.clientId;
  }

  async startTurn(options: DesktopTurnOptions): Promise<unknown> {
    await this.connect();
    this.broadcast("thread-stream-following-changed", {
      hostId: "local",
      conversationId: options.threadId,
      following: true,
    }, 1);
    // Give the Desktop owner a chance to register us as a follower before the turn begins.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await this.request("thread-follower-start-turn", {
      conversationId: options.threadId,
      turnStartParams: {
        input: [{ type: "text", text: options.prompt }],
        cwd: options.cwd,
        approvalPolicy: options.approvalPolicy,
      },
    }, 1, 30_000);
    return response.result;
  }

  async runTurn(
    options: DesktopTurnOptions,
    onProgress: (progress: CodexProgress) => void,
    timeoutMs = 2 * 60 * 60 * 1000,
  ): Promise<string> {
    await this.connect();
    const follower = new DesktopThreadFollower(options.threadId, onProgress);
    const onBroadcast = (message: IpcMessage): void => follower.handle(message);
    this.on("broadcast", onBroadcast);
    try {
      this.broadcast("thread-stream-following-changed", {
        hostId: "local",
        conversationId: options.threadId,
        following: true,
      }, 1);
      await follower.waitForSnapshot(5_000);
      const completion = follower.watchNextTurn(timeoutMs);
      await this.request("thread-follower-start-turn", {
        conversationId: options.threadId,
        turnStartParams: {
          input: [{ type: "text", text: options.prompt }],
          cwd: options.cwd,
          approvalPolicy: options.approvalPolicy,
        },
      }, 1, 30_000);
      return await completion;
    } finally {
      if (this.socket?.writable) {
        this.broadcast("thread-stream-following-changed", {
          hostId: "local",
          conversationId: options.threadId,
          following: false,
        }, 1);
      }
      this.off("broadcast", onBroadcast);
    }
  }

  close(): void {
    this.socket?.end();
    this.socket = undefined;
  }

  private request(method: string, params: Record<string, unknown>, version: number, timeoutMs: number): Promise<IpcMessage> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Codex Desktop IPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.write({ type: "request", requestId, sourceClientId: this.clientId, version, method, params, timeoutMs });
    });
  }

  private broadcast(method: string, params: Record<string, unknown>, version: number): void {
    this.write({ type: "broadcast", sourceClientId: this.clientId, version, method, params });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.socket?.writable) throw new Error("Codex Desktop IPC is not connected");
    const json = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.allocUnsafe(4 + json.length);
    frame.writeUInt32LE(json.length, 0);
    json.copy(frame, 4);
    this.socket.write(frame);
  }

  private readFrames(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > 256 * 1024 * 1024) {
        this.disconnect(new Error(`Invalid Codex Desktop IPC frame length: ${length}`));
        return;
      }
      if (this.buffer.length < length + 4) return;
      const body = this.buffer.subarray(4, length + 4).toString("utf8");
      this.buffer = this.buffer.subarray(length + 4);
      this.handleMessage(JSON.parse(body) as IpcMessage);
    }
  }

  private handleMessage(message: IpcMessage): void {
    if (message.type === "response" && message.requestId) {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.resultType === "error") pending.reject(new Error(message.error ?? "Codex Desktop IPC request failed"));
      else pending.resolve(message);
      return;
    }
    if (message.type === "client-discovery-request" && message.requestId) {
      if (!this.socket?.writable) return;
      this.write({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false },
      });
      return;
    }
    if (message.type === "broadcast") this.emit("broadcast", message);
  }

  private disconnect(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.clientId = "initializing-client";
    this.socket = undefined;
  }
}

interface DesktopTurn {
  turnId?: string;
  status?: string;
  error?: { message?: string } | null;
  items?: Array<Record<string, unknown>>;
}

class DesktopThreadFollower {
  private state?: Record<string, unknown>;
  private revision?: number;
  private snapshotResolve?: () => void;
  private snapshotReject?: (error: Error) => void;
  private completionResolve?: (result: string) => void;
  private completionReject?: (error: Error) => void;
  private baseline = new Set<string>();
  private readonly seenProgress = new Set<string>();

  constructor(
    private readonly threadId: string,
    private readonly onProgress: (progress: CodexProgress) => void,
  ) {}

  handle(message: IpcMessage): void {
    if (message.method !== "thread-stream-state-changed") return;
    if (message.params?.conversationId !== this.threadId) return;
    const change = message.params.change as Record<string, unknown> | undefined;
    if (!change) return;
    if (change.type === "snapshot") {
      this.state = structuredClone(change.conversationState as Record<string, unknown>);
      this.revision = numberValue(change.revision);
      this.snapshotResolve?.();
    } else if (change.type === "patches" && this.state) {
      const base = numberValue(change.baseRevision);
      if (this.revision !== undefined && base !== undefined && base !== this.revision) {
        this.completionReject?.(new Error(`Desktop stream revision mismatch: expected ${this.revision}, received ${base}`));
        return;
      }
      applyDesktopPatches(this.state, (change.patches as DesktopPatch[] | undefined) ?? []);
      this.revision = numberValue(change.revision) ?? this.revision;
    }
    this.inspect();
  }

  waitForSnapshot(timeoutMs: number): Promise<void> {
    if (this.state) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex Desktop did not provide a task snapshot")), timeoutMs);
      this.snapshotResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.snapshotReject = reject;
    });
  }

  watchNextTurn(timeoutMs: number): Promise<string> {
    this.baseline = new Set(turnEntities(this.state).map(([key]) => key));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Codex Desktop turn timed out in task ${this.threadId}`)), timeoutMs);
      this.completionResolve = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
      this.completionReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.inspect();
    });
  }

  private inspect(): void {
    if (!this.completionResolve || !this.state) return;
    const candidates = turnEntities(this.state).filter(([key]) => !this.baseline.has(key));
    const turn = candidates.at(-1)?.[1];
    if (!turn) return;
    for (const progress of desktopTurnProgress(turn)) {
      const signature = JSON.stringify(progress);
      if (this.seenProgress.has(signature)) continue;
      this.seenProgress.add(signature);
      this.onProgress(progress);
    }
    const status = turn.status;
    if (!status || ["inProgress", "in_progress", "running"].includes(status)) return;
    if (status !== "completed") {
      this.completionReject?.(new Error(turn.error?.message ?? `Desktop Codex turn ended with status ${status}`));
      return;
    }
    const final = [...(turn.items ?? [])].reverse().find((item) => item.type === "agentMessage" && typeof item.text === "string");
    this.completionResolve((final?.text as string | undefined) ?? "Task completed without a final agent message.");
  }
}

interface DesktopPatch {
  op: "add" | "replace" | "remove";
  path: Array<string | number>;
  value?: unknown;
}

export function applyDesktopPatches(root: Record<string, unknown>, patches: DesktopPatch[]): void {
  for (const patch of patches) {
    if (patch.path.length === 0) continue;
    let parent: unknown = root;
    for (const segment of patch.path.slice(0, -1)) {
      if (parent === null || typeof parent !== "object") break;
      parent = (parent as Record<string | number, unknown>)[segment];
    }
    if (parent === null || typeof parent !== "object") continue;
    const key = patch.path.at(-1)!;
    if (Array.isArray(parent)) {
      const index = key === "-" ? parent.length : Number(key);
      if (!Number.isInteger(index)) continue;
      if (patch.op === "add") parent.splice(index, 0, structuredClone(patch.value));
      else if (patch.op === "replace") parent[index] = structuredClone(patch.value);
      else parent.splice(index, 1);
    } else if (patch.op === "remove") {
      delete (parent as Record<string | number, unknown>)[key];
    } else {
      (parent as Record<string | number, unknown>)[key] = structuredClone(patch.value);
    }
  }
}

function turnEntities(state?: Record<string, unknown>): Array<[string, DesktopTurn]> {
  const history = objectValue(objectValue(objectValue(objectValue(state?.turnHistory)?.history)?.entitiesByKey));
  return Object.entries(history ?? {}).filter((entry): entry is [string, DesktopTurn] => {
    const value = entry[1];
    return Boolean(value && typeof value === "object" && Array.isArray((value as DesktopTurn).items));
  });
}

function desktopTurnProgress(turn: DesktopTurn): CodexProgress[] {
  const result: CodexProgress[] = [];
  if (turn.status) result.push({ kind: "status", title: `Turn ${turn.status}` });
  for (const item of turn.items ?? []) {
    const type = String(item.type ?? "");
    const text = stringValue(item.text) ?? stringValue(item.aggregatedOutput) ?? stringValue(item.output);
    if (type === "reasoning") {
      const summary = textValue(item.summary) ?? text;
      if (summary) result.push({ kind: "thinking", title: "Thinking", detail: summary });
    } else if (type === "agentMessage" && text) {
      result.push({ kind: "message", title: item.phase === "commentary" ? "Codex progress" : "Codex message", detail: text });
    } else if (type === "commandExecution") {
      result.push({ kind: "command", title: stringValue(item.command) ?? "Command", detail: text, payload: item.status ? { status: item.status } : undefined });
    } else if (type === "fileChange") {
      result.push({ kind: "file", title: stringValue(item.path) ?? "File change", detail: textValue(item.changes) ?? text });
    } else if (/tool|mcp/i.test(type)) {
      result.push({ kind: "tool", title: stringValue(item.title) ?? stringValue(item.name) ?? type, detail: text });
    }
  }
  return result;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("\n") || undefined;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textValue(record.text ?? record.summary ?? record.content);
  }
  return undefined;
}

export function desktopIpcEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  if (platform() === "win32") return String.raw`\\.\pipe\codex-ipc`;
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(codexHome, "ipc", "ipc.sock");
}
