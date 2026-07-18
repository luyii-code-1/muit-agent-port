import { z } from "zod";

export const threadSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  preview: z.string().default(""),
  cwd: z.string(),
  status: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const projectSummarySchema = z.object({
  path: z.string(),
  name: z.string(),
  markers: z.array(z.string()).default([]),
  threadCount: z.number().int().nonnegative().default(0),
  updatedAt: z.number(),
});

export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const dispatchPayloadSchema = z.object({
  taskId: z.string(),
  sourceNodeId: z.string().optional(),
  prompt: z.string().min(1).max(100_000),
  routing: z.enum(["exact", "best", "new"]),
  threadId: z.string().optional(),
  threadQuery: z.string().max(500).optional(),
  cwd: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type DispatchPayload = z.infer<typeof dispatchPayloadSchema>;

export const bridgeHelloSchema = z.object({
  type: z.literal("hello"),
  nodeId: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
  token: z.string().min(1),
  hostname: z.string().max(255),
  platform: z.string().max(80),
  labels: z.array(z.string().max(80)).max(50),
  version: z.string(),
});

export const bridgeToRelaySchema = z.discriminatedUnion("type", [
  bridgeHelloSchema,
  z.object({
    type: z.literal("heartbeat"),
    threads: z.array(threadSummarySchema).max(5_000),
    projects: z.array(projectSummarySchema).max(2_000).default([]),
  }),
  z.object({
    type: z.literal("task_started"),
    taskId: z.string(),
    threadId: z.string(),
    executionMode: z.enum(["desktop", "background"]),
  }),
  z.object({
    type: z.literal("task_progress"),
    taskId: z.string(),
    threadId: z.string(),
    kind: z.enum(["status", "thinking", "message", "tool", "command", "file", "warning"]),
    title: z.string().max(500),
    detail: z.string().max(50_000).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("task_completed"),
    taskId: z.string(),
    threadId: z.string(),
    result: z.string().max(1_000_000),
  }),
  z.object({
    type: z.literal("task_failed"),
    taskId: z.string(),
    threadId: z.string().optional(),
    error: z.string().max(20_000),
  }),
]);

export type BridgeToRelay = z.infer<typeof bridgeToRelaySchema>;

export const relayToBridgeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello_ack"), nodeId: z.string() }),
  z.object({ type: z.literal("dispatch"), task: dispatchPayloadSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type RelayToBridge = z.infer<typeof relayToBridgeSchema>;

export type TaskStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "completed"
  | "failed";

export interface MeshTask extends DispatchPayload {
  targetNodeId: string;
  status: TaskStatus;
  selectedThreadId?: string;
  executionMode?: "desktop" | "background";
  events?: MeshTaskEvent[];
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MeshTaskEvent {
  id: number;
  taskId: string;
  kind: "status" | "thinking" | "message" | "tool" | "command" | "file" | "warning";
  title: string;
  detail?: string;
  payload?: Record<string, unknown>;
  createdAt: number;
}

export interface MeshNode {
  id: string;
  hostname: string;
  platform: string;
  labels: string[];
  connected: boolean;
  lastSeenAt: number;
  threads: ThreadSummary[];
  projects: ProjectSummary[];
}
