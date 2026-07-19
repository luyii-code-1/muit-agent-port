import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

import type { ThreadSummary } from "../shared/types.js";
import { errorMessage } from "../shared/util.js";
import type { ApprovalPolicy, SandboxMode } from "./config.js";

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface RpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface CodexThread {
  id: string;
  name?: string | null;
  preview: string;
  cwd: string;
  status: { type?: string } | string;
  createdAt: number;
  updatedAt: number;
  turns?: Turn[];
}

interface ThreadListResult {
  data: CodexThread[];
  nextCursor?: string | null;
}

interface ThreadResult {
  thread: CodexThread;
}

interface TurnItem {
  id?: string;
  type: string;
  text?: string;
  status?: string;
  command?: string | string[];
  aggregatedOutput?: string;
  output?: string;
  summary?: unknown;
  title?: string;
  name?: string;
  path?: string;
  changes?: unknown;
}

interface Turn {
  id: string;
  status: string;
  items: TurnItem[];
  error?: { message?: string } | null;
}

interface TurnResult {
  turn: Turn;
}

export interface RunOptions {
  threadId: string;
  prompt: string;
  cwd: string;
  approvalPolicy: ApprovalPolicy;
}

export interface CodexProgress {
  kind: "status" | "thinking" | "message" | "tool" | "command" | "file" | "warning";
  title: string;
  detail?: string;
  payload?: Record<string, unknown>;
}

export class CodexAppServer {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly events = new EventEmitter();
  private readonly completedTurns = new Map<string, Turn>();
  private readonly completedItems = new Map<string, TurnItem[]>();

  constructor(private readonly codexCommand: string) {}

  async start(): Promise<void> {
    if (this.child) return;
    const needsWindowsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(this.codexCommand);
    const child = spawn(this.codexCommand, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      shell: needsWindowsShell,
      windowsHide: true,
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => process.stderr.write(`[codex app-server] ${chunk.toString()}`));
    child.on("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      for (const call of this.pending.values()) {
        clearTimeout(call.timer);
        call.reject(error);
      }
      this.pending.clear();
      this.completedItems.clear();
      this.child = undefined;
      this.events.emit("exit", error);
    });
    child.on("error", (error) => this.events.emit("exit", error));

    await this.call("initialize", {
      clientInfo: { name: "codex_mesh_bridge", title: "Codex Mesh Bridge", version: "0.1.0" },
      capabilities: {
        optOutNotificationMethods: ["item/agentMessage/delta"],
      },
    });
    this.notify("initialized", {});
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    this.child = undefined;
  }

  async listThreads(limit = 5_000): Promise<ThreadSummary[]> {
    const sourceKinds = [
      "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
      "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
    ];
    const byId = new Map<string, ThreadSummary>();
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const result = await this.call("thread/list", {
          limit: Math.min(100, limit - byId.size),
          archived,
          cursor,
          sourceKinds,
          sortKey: "updated_at",
          sortDirection: "desc",
        }) as ThreadListResult;
        for (const thread of result.data) byId.set(thread.id, this.summarizeThread(thread));
        cursor = result.nextCursor ?? null;
      } while (cursor && byId.size < limit);
      if (byId.size >= limit) break;
    }
    return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async readThread(threadId: string): Promise<ThreadSummary> {
    const result = await this.call("thread/read", { threadId, includeTurns: false }) as ThreadResult;
    return this.summarizeThread(result.thread);
  }

  async readThreadDetail(threadId: string): Promise<CodexThread> {
    const result = await this.call("thread/read", { threadId, includeTurns: true }) as ThreadResult;
    return result.thread;
  }

  async waitForExternalTurn(
    threadId: string,
    previousTurnIds: Set<string>,
    onProgress: (progress: CodexProgress) => void,
    timeoutMs = 2 * 60 * 60 * 1000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastFingerprint = "";
    let selectedTurnId: string | undefined;
    while (Date.now() < deadline) {
      const thread = await this.readThreadDetail(threadId);
      const turns = thread.turns ?? [];
      const turn = selectedTurnId
        ? turns.find((candidate) => candidate.id === selectedTurnId)
        : [...turns].reverse().find((candidate) => !previousTurnIds.has(candidate.id));
      if (turn) {
        selectedTurnId = turn.id;
        const fingerprint = JSON.stringify({ status: turn.status, items: turn.items });
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          for (const progress of summarizeTurnProgress(turn)) onProgress(progress);
        }
        if (turn.status !== "inProgress" && turn.status !== "in_progress" && turn.status !== "running") {
          if (turn.status !== "completed") {
            throw new Error(turn.error?.message ?? `Desktop Codex turn ended with status ${turn.status}`);
          }
          return finalAgentMessage(turn) ?? "Task completed without a final agent message.";
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
    throw new Error(`Desktop Codex turn timed out in thread ${threadId}`);
  }

  async startThread(
    cwd: string,
    approvalPolicy: ApprovalPolicy,
    sandbox: SandboxMode,
  ): Promise<string> {
    const result = await this.call("thread/start", { cwd, approvalPolicy, sandbox }) as ThreadResult;
    return result.thread.id;
  }

  async resumeThread(
    threadId: string,
    cwd: string,
    approvalPolicy: ApprovalPolicy,
    sandbox: SandboxMode,
  ): Promise<void> {
    await this.call("thread/resume", { threadId, cwd, approvalPolicy, sandbox });
  }

  async runTurn(options: RunOptions): Promise<string> {
    const response = await this.call("turn/start", {
      threadId: options.threadId,
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      input: [{ type: "text", text: options.prompt }],
    }) as TurnResult;
    const turn = await this.waitForTurn(response.turn.id);
    if (turn.status !== "completed") {
      throw new Error(turn.error?.message ?? `Codex turn ended with status ${turn.status}`);
    }
    const notificationMessage = finalAgentMessage(turn);
    if (notificationMessage) return notificationMessage;

    // Recent app-server builds may emit a slim turn/completed notification with
    // no items. The complete turn is persisted on the thread shortly afterward.
    // Hydrate it before concluding that the agent produced no final message.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const thread = await this.readThreadDetail(options.threadId);
      const persistedTurn = thread.turns?.find((candidate) => candidate.id === turn.id);
      const persistedMessage = persistedTurn ? finalAgentMessage(persistedTurn) : undefined;
      if (persistedMessage) return persistedMessage;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return "Task completed without a final agent message.";
  }

  private call(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ method, id, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: unknown): void {
    if (!this.child) throw new Error("codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    try {
      const message = JSON.parse(line) as RpcResponse & RpcNotification;
      if (typeof message.id === "number" && !message.method) {
        const call = this.pending.get(message.id);
        if (!call) return;
        this.pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.error) call.reject(new Error(`${message.error.message} (${message.error.code})`));
        else call.resolve(message.result);
        return;
      }
      if (typeof message.id === "number" && message.method) {
        this.write({
          id: message.id,
          error: { code: -32601, message: `Bridge cannot handle server request: ${message.method}` },
        });
        return;
      }
      if (message.method === "item/completed") {
        const turnId = message.params?.turnId;
        const item = message.params?.item as TurnItem | undefined;
        if (typeof turnId === "string" && item) {
          const items = this.completedItems.get(turnId) ?? [];
          this.completedItems.set(turnId, mergeTurnItems(items, [item]));
        }
      } else if (message.method === "turn/completed") {
        const turn = message.params?.turn as Turn | undefined;
        if (turn) {
          const completedTurn = {
            ...turn,
            items: mergeTurnItems(this.completedItems.get(turn.id) ?? [], turn.items ?? []),
          };
          this.completedItems.delete(turn.id);
          this.completedTurns.set(turn.id, completedTurn);
          this.events.emit(`turn:${turn.id}`, completedTurn);
        }
      }
    } catch (error) {
      console.error(`Failed to parse app-server message: ${errorMessage(error)}`);
    }
  }

  private waitForTurn(turnId: string, timeoutMs = 12 * 60 * 60 * 1000): Promise<Turn> {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return Promise.resolve(completed);
    }
    return new Promise((resolve, reject) => {
      const event = `turn:${turnId}`;
      const onExit = (error: Error): void => done(error);
      const timer = setTimeout(() => done(new Error(`Codex turn timed out: ${turnId}`)), timeoutMs);
      const onComplete = (turn: Turn): void => {
        this.completedTurns.delete(turnId);
        cleanup();
        resolve(turn);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.events.off(event, onComplete);
        this.events.off("exit", onExit);
      };
      const done = (error: Error): void => {
        cleanup();
        reject(error);
      };
      this.events.once(event, onComplete);
      this.events.once("exit", onExit);
    });
  }

  private summarizeThread(thread: CodexThread): ThreadSummary {
    return {
      id: thread.id,
      name: thread.name,
      preview: thread.preview,
      cwd: thread.cwd,
      status: typeof thread.status === "string" ? thread.status : thread.status.type ?? "unknown",
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  }
}

export function finalAgentMessage(turn: Turn): string | undefined {
  const messages = turn.items
    .filter((item) => item.type === "agentMessage" && item.text)
    .map((item) => item.text!);
  return messages.at(-1);
}

export function mergeTurnItems(streamed: TurnItem[], completed: TurnItem[]): TurnItem[] {
  const items: TurnItem[] = [];
  const indexes = new Map<string, number>();
  for (const item of [...streamed, ...completed]) {
    if (item.id) {
      const existing = indexes.get(item.id);
      if (existing !== undefined) {
        items[existing] = item;
        continue;
      }
      indexes.set(item.id, items.length);
    }
    items.push(item);
  }
  return items;
}

export function summarizeTurnProgress(turn: Turn): CodexProgress[] {
  const progress: CodexProgress[] = [{ kind: "status", title: `Turn ${turn.status}` }];
  for (const item of turn.items) {
    const detail = item.text ?? item.aggregatedOutput ?? item.output;
    if (item.type === "reasoning") {
      const summary = textFromUnknown(item.summary) || detail;
      if (summary) progress.push({ kind: "thinking", title: "Thinking", detail: summary });
    } else if (item.type === "agentMessage" && detail) {
      progress.push({ kind: "message", title: "Codex message", detail });
    } else if (item.type === "commandExecution") {
      const command = Array.isArray(item.command) ? item.command.join(" ") : item.command;
      progress.push({ kind: "command", title: command || "Command", detail, payload: item.status ? { status: item.status } : undefined });
    } else if (item.type === "fileChange") {
      progress.push({ kind: "file", title: item.path || item.title || "File change", detail: textFromUnknown(item.changes) || detail });
    } else if (/tool|mcp/i.test(item.type)) {
      progress.push({ kind: "tool", title: item.title || item.name || item.type, detail });
    }
  }
  return progress;
}

function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value.map(textFromUnknown).filter(Boolean).join("\n");
    return text || undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textFromUnknown(record.text ?? record.summary ?? record.content);
  }
  return undefined;
}
