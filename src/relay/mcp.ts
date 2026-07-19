import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { MeshNode, MeshTask, ProjectSummary } from "../shared/types.js";
import { redactSecrets, safeEqual } from "../shared/util.js";
import type { BridgeHub } from "./bridgeHub.js";
import type { RelayConfig } from "./config.js";
import type { PairingService } from "./pairing.js";
import type { MeshStore } from "./store.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export class MeshMcpService {
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();

  constructor(
    private readonly store: MeshStore,
    private readonly hub: BridgeHub,
    private readonly config: RelayConfig,
    private readonly pairing: PairingService,
  ) {}

  authorize(request: Request, response: Response, next: () => void): void {
    const authorization = request.header("authorization") ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!supplied || !safeEqual(supplied, this.config.mcpToken)) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  }

  async post(request: Request, response: Response): Promise<void> {
    const sessionId = request.header("mcp-session-id");
    let transport = sessionId ? this.transports.get(sessionId) : undefined;

    if (!transport && isInitializeRequest(request.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.transports.set(id, transport!);
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) this.transports.delete(transport.sessionId);
      };
      const server = this.createServer();
      await server.connect(transport);
    } else if (!transport) {
      response.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: missing or invalid MCP session" },
        id: null,
      });
      return;
    }
    await transport.handleRequest(request, response, request.body);
  }

  async sessionRequest(request: Request, response: Response): Promise<void> {
    const sessionId = request.header("mcp-session-id");
    const transport = sessionId ? this.transports.get(sessionId) : undefined;
    if (!transport) {
      response.status(400).send("Missing or invalid MCP session");
      return;
    }
    await transport.handleRequest(request, response);
  }

  async close(): Promise<void> {
    await Promise.all([...this.transports.values()].map((transport) => transport.close()));
    this.transports.clear();
  }

  private createServer(): McpServer {
    const server = new McpServer(
      { name: "codex-mesh", version: "0.1.0" },
      {
        instructions:
          "Every delegation is two-phase. First call codex_mesh_delegate: the remote Codex may inspect and discuss current state but must not modify files. Read its assessment, resolve questions or conflicts, then call codex_mesh_confirm to authorize execution in the same conversation. Never skip confirmation. Use codex_mesh_projects/threads to select context and do not send secrets.",
      },
    );

    server.registerTool(
      "codex_mesh_nodes",
      {
        title: "List Codex mesh computers",
        description: "List registered computers, connectivity, system labels, user/Codex-managed Role labels, and cached thread counts. Use Roles to choose the most suitable computer.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => {
        const nodes = this.store.listNodes().map((meshNode) => {
          const { threads, projects, ...node } = meshNode;
          return {
          ...node,
          threadCount: threads.length,
          projectCount: projectsForNode(meshNode).length,
          directoryCount: new Set(threads.map((thread) => thread.cwd)).size,
          };
        });
        return result({ nodes });
      },
    );

    server.registerTool(
      "codex_mesh_projects",
      {
        title: "List all Codex projects on a computer",
        description: "List scanned Codex project directories, project markers, and associated conversation counts on one mesh computer.",
        inputSchema: {
          node_id: z.string().min(1),
          query: z.string().max(500).optional(),
          limit: z.number().int().min(1).max(2_000).default(500),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ node_id, query, limit }) => {
        const node = this.store.getNode(node_id);
        if (!node) return errorResult(`Unknown node: ${node_id}`);
        const needle = query?.toLowerCase();
        const projects = projectsForNode(node)
          .filter((project) => !needle || `${project.name} ${project.path}`.toLowerCase().includes(needle))
          .slice(0, limit);
        const directories = [...new Set(node.threads.map((thread) => thread.cwd))].sort();
        return result({ nodeId: node_id, connected: node.connected, cachedAt: node.lastSeenAt, projects, directories });
      },
    );

    server.registerTool(
      "codex_mesh_threads",
      {
        title: "List threads on a Codex computer",
        description: "List the latest cached Codex conversations on one computer. Use an id from this result for exact routing.",
        inputSchema: {
          node_id: z.string().min(1),
          query: z.string().max(500).optional(),
          cwd: z.string().optional(),
          limit: z.number().int().min(1).max(100).default(30),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ node_id, query, cwd, limit }) => {
        const node = this.store.getNode(node_id);
        if (!node) return errorResult(`Unknown node: ${node_id}`);
        const needle = query?.toLowerCase();
        const threads = node.threads
          .filter((thread) => !cwd || thread.cwd === cwd)
          .filter((thread) => !needle || `${thread.name ?? ""} ${thread.preview}`.toLowerCase().includes(needle))
          .slice(0, limit);
        return result({
          nodeId: node_id,
          connected: node.connected,
          cachedAt: node.lastSeenAt,
          threads: threads.map(safeThread),
        });
      },
    );

    server.registerTool(
      "codex_mesh_delegate",
      {
        title: "Consult another Codex before delegation",
        description:
          "Phase 1 only: ask another Codex to inspect and discuss current state, risks, conflicts, questions, and a proposed plan. It is explicitly forbidden from changing files until codex_mesh_confirm is called.",
        inputSchema: {
          target_node_id: z.string().min(1),
          prompt: z.string().min(1).max(100_000),
          routing: z.enum(["exact", "best", "new"]).default("best"),
          thread_id: z.string().optional(),
          thread_query: z.string().max(500).optional(),
          cwd: z.string().optional(),
          source_node_id: z.string().optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
          wait_seconds: z.number().int().min(0).max(50).default(30),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async (input) => {
        if (input.routing === "exact" && !input.thread_id) {
          return errorResult("routing=exact requires thread_id");
        }
        const node = this.store.getNode(input.target_node_id);
        if (!node) return errorResult(`Unknown target node: ${input.target_node_id}`);
        const priorExecutionMode = input.routing === "exact" && input.thread_id
          ? executionModeForThread(this.store.listTasks(100), input.thread_id)
          : undefined;

        const now = Date.now();
        const task: MeshTask = {
          taskId: randomUUID(),
          targetNodeId: input.target_node_id,
          sourceNodeId: input.source_node_id,
          prompt: input.prompt,
          routing: input.routing,
          threadId: input.thread_id,
          threadQuery: input.thread_query,
          cwd: input.cwd,
          metadata: {
            ...input.metadata,
            ...(priorExecutionMode ? { meshExecutionMode: priorExecutionMode } : {}),
            meshPhase: "consultation",
          },
          status: "queued",
          createdAt: now,
          updatedAt: now,
        };
        this.store.createTask(task);
        const delivered = this.hub.dispatch(task);
        const current = input.wait_seconds > 0
          ? await this.waitUntilTerminal(task.taskId, input.wait_seconds * 1000)
          : this.store.getTask(task.taskId);
        return result({ delivered, task: current ? safeTask(current) : undefined });
      },
    );

    server.registerTool(
      "codex_mesh_confirm",
      {
        title: "Confirm a discussed Codex delegation",
        description:
          "Phase 2: after reading the completed remote assessment and resolving its questions, confirm execution in the exact same remote conversation. Never call this before the consultation completes.",
        inputSchema: {
          consultation_task_id: z.string().min(1),
          confirmation: z.string().min(1).max(100_000).optional(),
          source_node_id: z.string().optional(),
          wait_seconds: z.number().int().min(0).max(50).default(0),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async ({ consultation_task_id, confirmation, source_node_id, wait_seconds }) => {
        const consultation = this.store.getTask(consultation_task_id);
        if (!consultation) return errorResult(`Unknown consultation task: ${consultation_task_id}`);
        if (consultation.metadata?.meshPhase !== "consultation") {
          return errorResult("The referenced task is not a consultation");
        }
        if (consultation.status !== "completed" || !consultation.result) {
          return errorResult(`Consultation must complete before confirmation; current status is ${consultation.status}`);
        }
        if (!consultation.selectedThreadId) {
          return errorResult("Consultation completed without a selected remote conversation");
        }
        if (/\bBLOCKED\b/i.test(consultation.result) && !confirmation) {
          return errorResult("The remote Codex reported BLOCKED. Provide confirmation with answers or conflict resolution before execution.");
        }
        const now = Date.now();
        const resolvedConfirmation = confirmation ?? "现状已确认，按讨论后的方案执行。";
        const consultationExecutionMode = consultation.executionMode === "background"
          || consultation.metadata?.meshExecutionMode === "background"
          ? "background"
          : undefined;
        const executionPrompt = [
          "[Explicit follow-up confirmation after Codex-to-Codex consultation]",
          "The consultation has completed. This message explicitly authorizes execution in the same conversation.",
          "",
          "Original proposed task:",
          consultation.prompt,
          "",
          "Remote assessment:",
          consultation.result,
          "",
          "Requester's confirmation or answers:",
          resolvedConfirmation,
        ].join("\n");
        const task: MeshTask = {
          taskId: randomUUID(),
          targetNodeId: consultation.targetNodeId,
          sourceNodeId: source_node_id ?? consultation.sourceNodeId,
          prompt: executionPrompt,
          routing: "exact",
          threadId: consultation.selectedThreadId,
          cwd: consultation.cwd,
          metadata: {
            meshPhase: "execution",
            ...(consultationExecutionMode ? { meshExecutionMode: consultationExecutionMode } : {}),
            consultationTaskId: consultation.taskId,
            remoteAssessment: consultation.result,
            originalPrompt: consultation.prompt,
            confirmation: resolvedConfirmation,
          },
          status: "queued",
          createdAt: now,
          updatedAt: now,
        };
        this.store.createTask(task);
        const delivered = this.hub.dispatch(task);
        const current = wait_seconds > 0
          ? await this.waitUntilTerminal(task.taskId, wait_seconds * 1000)
          : this.store.getTask(task.taskId);
        return result({
          delivered,
          consultation: redactSecrets(consultation.result),
          task: current ? safeTask(current) : undefined,
        });
      },
    );

    server.registerTool(
      "codex_mesh_cancel",
      {
        title: "Cancel a Codex mesh task",
        description: "Interrupt the Desktop turn associated with a mesh task and mark it cancelled. This also works for a stale task whose Relay status is already failed.",
        inputSchema: {
          task_id: z.string().min(1),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async ({ task_id }) => {
        const task = this.store.getTask(task_id);
        if (!task) return errorResult(`Unknown task: ${task_id}`);
        const delivered = this.hub.cancel(task);
        if (!delivered) return errorResult(`Target node is offline; task was not interrupted: ${task.targetNodeId}`);
        const cancelled = this.store.updateTask(task_id, { status: "cancelled", error: undefined });
        return result({ delivered, task: cancelled ? safeTask(cancelled) : undefined });
      },
    );

    server.registerTool(
      "codex_mesh_task",
      {
        title: "Get a Codex mesh task",
        description: "Read a delegated task's status and result. Optionally wait briefly for the next state change.",
        inputSchema: {
          task_id: z.string().min(1),
          wait_seconds: z.number().int().min(0).max(50).default(0),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ task_id, wait_seconds }) => {
        const task = wait_seconds > 0
          ? await this.waitUntilTerminal(task_id, wait_seconds * 1000)
          : this.store.getTask(task_id);
        return task ? result({ task: safeTask(task) }) : errorResult(`Unknown task: ${task_id}`);
      },
    );

    server.registerTool(
      "codex_mesh_activity",
      {
        title: "List Codex-to-Codex collaboration",
        description: "Show recent delegated prompts, selected conversations, status, results, and errors across the mesh.",
        inputSchema: {
          limit: z.number().int().min(1).max(100).default(30),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ limit }) => result({ tasks: this.store.listTasks(limit).map(safeTask) }),
    );

    server.registerTool(
      "codex_mesh_pairing_code",
      {
        title: "Create a one-time bridge pairing code",
        description: "Create a six-digit one-time code so a new Mac or Windows Codex Bridge can join without editing relay token maps.",
        inputSchema: {
          ttl_minutes: z.number().int().min(1).max(30).default(10),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async ({ ttl_minutes }) => {
        const pairing = this.pairing.createCode(ttl_minutes);
        return result({
          ...pairing,
          instruction: "On the new computer, set MESH_PAIRING_CODE to this code for its first Bridge start. The code is single-use.",
        });
      },
    );

    return server;
  }

  private async waitUntilTerminal(taskId: string, timeoutMs: number): Promise<MeshTask | undefined> {
    const deadline = Date.now() + timeoutMs;
    let task = this.store.getTask(taskId);
    while (task && !TERMINAL_STATUSES.has(task.status) && Date.now() < deadline) {
      task = await this.store.waitForTask(taskId, deadline - Date.now());
    }
    return task;
  }
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function executionModeForThread(tasks: MeshTask[], threadId: string): "background" | undefined {
  const latest = tasks.find((task) => task.selectedThreadId === threadId);
  return latest?.executionMode === "background" ? "background" : undefined;
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function projectsForNode(node: MeshNode): ProjectSummary[] {
  const byPath = new Map(node.projects.map((project) => [project.path, project]));
  for (const thread of node.threads) {
    const existing = byPath.get(thread.cwd);
    if (existing) continue;
    byPath.set(thread.cwd, {
      path: thread.cwd,
      name: thread.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || thread.cwd,
      markers: ["thread-directory"],
      threadCount: node.threads.filter((candidate) => candidate.cwd === thread.cwd).length,
      updatedAt: thread.updatedAt * 1_000,
    });
  }
  return [...byPath.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

function safeThread<T extends { name?: string | null; preview: string }>(thread: T): T {
  return {
    ...thread,
    name: thread.name ? redactSecrets(thread.name) : thread.name,
    preview: redactSecrets(thread.preview),
  };
}

function safeTask(task: MeshTask): MeshTask {
  let metadata = task.metadata;
  if (metadata) {
    metadata = JSON.parse(redactSecrets(JSON.stringify(metadata))) as Record<string, unknown>;
  }
  return {
    ...task,
    prompt: redactSecrets(task.prompt),
    result: task.result ? redactSecrets(task.result) : task.result,
    error: task.error ? redactSecrets(task.error) : task.error,
    metadata,
  };
}
