import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";

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

export function desktopIpcEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  if (platform() === "win32") return String.raw`\\.\pipe\codex-ipc`;
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(codexHome, "ipc", "ipc.sock");
}
