import { platform } from "node:os";
import WebSocket from "ws";

import {
  relayToBridgeSchema,
  type BridgeToRelay,
  type DispatchPayload,
  type ThreadSummary,
} from "../shared/types.js";
import { errorMessage, sleep } from "../shared/util.js";
import { CodexAppServer } from "./codexAppServer.js";
import { DesktopIpc } from "./desktopIpc.js";
import { applyBridgeArgs } from "./args.js";
import { assertAllowedCwd, isAllowedCwd, loadBridgeConfig } from "./config.js";
import { BridgeLedger } from "./ledger.js";
import { createEmptyInboxProject } from "./inbox.js";
import { ensurePaired } from "./pairClient.js";
import { scanProjects } from "./projects.js";
import { buildCollaborationPrompt } from "./prompts.js";
import { selectBestThread } from "./routing.js";

applyBridgeArgs(process.argv.slice(2));
const config = loadBridgeConfig();
await ensurePaired(config);
const codex = new CodexAppServer(config.codexCommand);
const desktop = new DesktopIpc();
const ledger = new BridgeLedger(config.ledgerPath);
const queue: DispatchPayload[] = [];
const queuedIds = new Set<string>();
const activeTasks = new Map<string, string>();
const cancelledIds = new Set<string>();
let active = 0;
let socket: WebSocket | undefined;
let stopping = false;
let authenticated = false;

await codex.start();
void connectLoop();

async function connectLoop(): Promise<void> {
  let attempt = 0;
  while (!stopping) {
    try {
      await connectOnce();
      attempt = 0;
    } catch (error) {
      console.error(`Relay connection failed: ${errorMessage(error)}`);
    }
    if (stopping) break;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5)) + Math.floor(Math.random() * 500);
    await sleep(delay);
  }
}

async function connectOnce(): Promise<void> {
  const ws = new WebSocket(config.relayUrl, { maxPayload: 2 * 1024 * 1024 });
  socket = ws;
  authenticated = false;
  await new Promise<void>((resolve, reject) => {
    const heartbeat = setInterval(() => void sendHeartbeat(), config.refreshMs);
    ws.on("open", () => {
      send({
        type: "hello",
        nodeId: config.nodeId,
        token: config.nodeToken,
        hostname: config.nodeHostname,
        platform: config.nodePlatform || platform(),
        labels: config.labels,
        roles: config.roles,
        version: "0.1.0",
      });
    });
    ws.on("message", (data) => void handleRelayMessage(data.toString()).catch((error) => {
      console.error(`Relay message failed: ${errorMessage(error)}`);
    }));
    ws.once("error", reject);
    ws.once("close", (code, reason) => {
      clearInterval(heartbeat);
      authenticated = false;
      if (socket === ws) socket = undefined;
      console.error(`Relay disconnected (${code}): ${reason.toString()}`);
      resolve();
    });
  });
}

async function handleRelayMessage(raw: string): Promise<void> {
  const message = relayToBridgeSchema.parse(JSON.parse(raw) as unknown);
  switch (message.type) {
    case "hello_ack":
      authenticated = true;
      console.log(`Connected to relay as ${message.nodeId}`);
      await sendHeartbeat();
      break;
    case "error":
      console.error(`Relay error: ${message.message}`);
      break;
    case "dispatch":
      acceptTask(message.task);
      break;
    case "cancel":
      await cancelTask(message.taskId, message.threadId);
      break;
  }
}

function acceptTask(task: DispatchPayload): void {
  const existing = ledger.get(task.taskId);
  if (existing) {
    if (existing.status === "completed") {
      send({
        type: "task_completed",
        taskId: task.taskId,
        threadId: existing.threadId!,
        result: existing.result ?? "",
      });
    } else if (existing.status === "failed") {
      send({
        type: "task_failed",
        taskId: task.taskId,
        threadId: existing.threadId,
        error: existing.error ?? "Task failed",
      });
    }
    return;
  }
  if (queuedIds.has(task.taskId)) return;
  ledger.accept(task.taskId);
  queuedIds.add(task.taskId);
  queue.push(task);
  drainQueue();
}

function drainQueue(): void {
  while (active < config.concurrency && queue.length > 0) {
    const task = queue.shift()!;
    queuedIds.delete(task.taskId);
    active += 1;
    void runTask(task).finally(() => {
      active -= 1;
      drainQueue();
    });
  }
}

async function runTask(task: DispatchPayload): Promise<void> {
  let threadId: string | undefined;
  try {
    const selected = task.routing === "exact"
      ? await codex.readThread(task.threadId!)
      : chooseThread(task, await codex.listThreads());
    if (task.routing === "exact") assertAllowedCwd(selected!.cwd, config.allowedRoots);
    const cwd = selected
      ? assertAllowedCwd(selected.cwd, config.allowedRoots)
      : createEmptyInboxProject(config.inboxRoot, task.taskId, config.allowedRoots);
    if (selected) {
      threadId = selected.id;
    } else {
      threadId = await codex.startThread(cwd, config.approvalPolicy, config.sandbox);
    }
    ledger.update(task.taskId, "running", { threadId });
    activeTasks.set(task.taskId, threadId);
    const prompt = buildCollaborationPrompt(task);
    let result: string;
    const useBackground = !selected || task.metadata?.meshExecutionMode === "background";
    if (!useBackground) {
      send({ type: "task_started", taskId: task.taskId, threadId, executionMode: "desktop" });
      sendProgress(task.taskId, threadId, "status", "Attached to Codex Desktop task");
      const seen = new Set<string>();
      result = await desktop.runTurn({
        threadId,
        prompt,
        cwd,
        approvalPolicy: config.approvalPolicy,
      }, (progress) => {
        const signature = JSON.stringify(progress);
        if (seen.has(signature)) return;
        seen.add(signature);
        sendProgress(task.taskId, threadId!, progress.kind, progress.title, progress.detail, progress.payload);
      });
    } else {
      if (selected) {
        await codex.resumeThread(threadId, cwd, config.approvalPolicy, config.sandbox);
      }
      send({ type: "task_started", taskId: task.taskId, threadId, executionMode: "background" });
      sendProgress(
        task.taskId,
        threadId,
        "status",
        selected ? "Continued background app-server task" : "New empty-project task uses background app-server mode",
      );
      const seen = new Set<string>();
      result = await codex.runTurn({ threadId, cwd, approvalPolicy: config.approvalPolicy, prompt }, (progress) => {
        const signature = JSON.stringify(progress);
        if (seen.has(signature)) return;
        seen.add(signature);
        sendProgress(task.taskId, threadId!, progress.kind, progress.title, progress.detail, progress.payload);
      });
    }
    ledger.update(task.taskId, "completed", { threadId, result });
    if (!cancelledIds.has(task.taskId)) send({ type: "task_completed", taskId: task.taskId, threadId, result });
    await sendHeartbeat();
  } catch (error) {
    const message = errorMessage(error);
    if (cancelledIds.has(task.taskId)) {
      ledger.update(task.taskId, "failed", { threadId, error: "Cancelled by requester" });
      send({ type: "task_cancelled", taskId: task.taskId, threadId });
    } else {
      ledger.update(task.taskId, "failed", { threadId, error: message });
      send({ type: "task_failed", taskId: task.taskId, threadId, error: message });
    }
  } finally {
    activeTasks.delete(task.taskId);
    cancelledIds.delete(task.taskId);
  }
}

async function cancelTask(taskId: string, requestedThreadId?: string): Promise<void> {
  const threadId = activeTasks.get(taskId) ?? requestedThreadId;
  cancelledIds.add(taskId);
  const queuedIndex = queue.findIndex((task) => task.taskId === taskId);
  if (queuedIndex >= 0) {
    queue.splice(queuedIndex, 1);
    queuedIds.delete(taskId);
  }
  if (threadId) await desktop.interruptTurn(threadId);
  ledger.update(taskId, "failed", { threadId, error: "Cancelled by requester" });
  send({ type: "task_cancelled", taskId, threadId });
}

function chooseThread(task: DispatchPayload, threads: ThreadSummary[]): ThreadSummary | undefined {
  if (task.routing === "new") return undefined;
  const allowedThreads = threads.filter((thread) => isAllowedCwd(thread.cwd, config.allowedRoots));
  return selectBestThread(allowedThreads, { cwd: task.cwd, query: task.threadQuery });
}

async function sendHeartbeat(): Promise<void> {
  if (!authenticated) return;
  try {
    const threads = await codex.listThreads();
    const projects = await scanProjects(config.allowedRoots, threads);
    send({ type: "heartbeat", threads, projects });
  } catch (error) {
    console.error(`Thread refresh failed: ${errorMessage(error)}`);
  }
}

function send(message: BridgeToRelay): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function sendProgress(
  taskId: string,
  threadId: string,
  kind: "status" | "thinking" | "message" | "tool" | "command" | "file" | "warning",
  title: string,
  detail?: string,
  payload?: Record<string, unknown>,
): void {
  send({ type: "task_progress", taskId, threadId, kind, title, detail, payload });
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  socket?.close(1000, "Bridge shutting down");
  desktop.close();
  await codex.stop();
  ledger.close();
}

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
