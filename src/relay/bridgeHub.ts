import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import {
  bridgeHelloSchema,
  bridgeToRelaySchema,
  type MeshTask,
  type RelayToBridge,
} from "../shared/types.js";
import { errorMessage, safeEqual } from "../shared/util.js";
import type { RelayConfig } from "./config.js";
import type { MeshStore } from "./store.js";

interface AuthenticatedSocket extends WebSocket {
  meshNodeId?: string;
  meshAuthenticated?: boolean;
}

export class BridgeHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sockets = new Map<string, AuthenticatedSocket>();

  constructor(
    private readonly store: MeshStore,
    private readonly config: RelayConfig,
  ) {
    this.wss.on("connection", (socket: AuthenticatedSocket) => this.handleConnection(socket));
  }

  handleUpgrade(request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/bridge") {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit("connection", ws, request));
  }

  dispatch(task: MeshTask): boolean {
    const socket = this.sockets.get(task.targetNodeId);
    if (!socket || socket.readyState !== socket.OPEN) return false;
    this.send(socket, {
      type: "dispatch",
      task: {
        taskId: task.taskId,
        sourceNodeId: task.sourceNodeId,
        prompt: task.prompt,
        routing: task.routing,
        threadId: task.threadId,
        threadQuery: task.threadQuery,
        cwd: task.cwd,
        metadata: task.metadata,
      },
    });
    if (task.status !== "running") this.store.updateTask(task.taskId, { status: "dispatched" });
    return true;
  }

  close(): void {
    for (const socket of this.sockets.values()) socket.close(1001, "Relay shutting down");
    this.wss.close();
  }

  private handleConnection(socket: AuthenticatedSocket): void {
    const helloTimer = setTimeout(() => socket.close(4001, "hello timeout"), 10_000);

    socket.on("message", (data) => {
      try {
        const json = JSON.parse(data.toString()) as unknown;
        if (!socket.meshAuthenticated) {
          const hello = bridgeHelloSchema.parse(json);
          if (!this.verifyNodeToken(hello.nodeId, hello.token)) {
            socket.close(4003, "authentication failed");
            return;
          }
          clearTimeout(helloTimer);
          socket.meshAuthenticated = true;
          socket.meshNodeId = hello.nodeId;
          const previous = this.sockets.get(hello.nodeId);
          if (previous && previous !== socket) previous.close(4002, "replaced by a newer connection");
          this.sockets.set(hello.nodeId, socket);
          this.store.upsertNode({
            id: hello.nodeId,
            hostname: hello.hostname,
            platform: hello.platform,
            labels: hello.labels,
          });
          this.send(socket, { type: "hello_ack", nodeId: hello.nodeId });
          for (const task of this.store.listPendingTasks(hello.nodeId)) this.dispatch(task);
          return;
        }

        const message = bridgeToRelaySchema.parse(json);
        if (message.type === "hello") return;
        const nodeId = socket.meshNodeId!;
        if ("taskId" in message) {
          const task = this.store.getTask(message.taskId);
          if (!task || task.targetNodeId !== nodeId) {
            throw new Error(`Node ${nodeId} cannot update task ${message.taskId}`);
          }
        }
        switch (message.type) {
          case "heartbeat":
            this.store.updateInventory(nodeId, message.threads, message.projects);
            break;
          case "task_started":
            this.store.updateTask(message.taskId, {
              status: "running",
              selectedThreadId: message.threadId,
              executionMode: message.executionMode,
              error: undefined,
            });
            break;
          case "task_progress":
            this.store.appendTaskEvent({
              taskId: message.taskId,
              kind: message.kind,
              title: message.title,
              detail: message.detail,
              payload: message.payload,
            });
            break;
          case "task_completed":
            this.store.updateTask(message.taskId, {
              status: "completed",
              selectedThreadId: message.threadId,
              result: message.result,
              error: undefined,
            });
            break;
          case "task_failed":
            this.store.updateTask(message.taskId, {
              status: "failed",
              selectedThreadId: message.threadId,
              error: message.error,
            });
            break;
        }
      } catch (error) {
        this.send(socket, { type: "error", message: errorMessage(error) });
      }
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      const nodeId = socket.meshNodeId;
      if (nodeId && this.sockets.get(nodeId) === socket) {
        this.sockets.delete(nodeId);
        this.store.setNodeDisconnected(nodeId);
      }
    });
  }

  private verifyNodeToken(nodeId: string, supplied: string): boolean {
    const expected = this.config.nodeTokens[nodeId] ?? this.config.fallbackBridgeToken;
    if (expected) return safeEqual(supplied, expected);
    const storedHash = this.store.getNodeTokenHash(nodeId);
    const suppliedHash = createHash("sha256").update(supplied).digest("hex");
    return storedHash ? safeEqual(suppliedHash, storedHash) : false;
  }

  private send(socket: WebSocket, message: RelayToBridge): void {
    socket.send(JSON.stringify(message));
  }
}
