import { createServer } from "node:http";
import express from "express";
import { z } from "zod";
import type { MeshNode, MeshTask } from "../shared/types.js";
import { redactSecrets } from "../shared/util.js";

import { BridgeHub } from "./bridgeHub.js";
import { loadRelayConfig } from "./config.js";
import { dashboardHtml } from "./dashboard.js";
import { MeshMcpService } from "./mcp.js";
import { PairingService } from "./pairing.js";
import { MeshStore } from "./store.js";

const config = loadRelayConfig();
const store = new MeshStore(config.dbPath);
const pairing = new PairingService(store, config.mcpToken);
const hub = new BridgeHub(store, config);
const mcp = new MeshMcpService(store, hub, config, pairing);
const app = express();
const pairAttempts = new Map<string, { count: number; resetAt: number }>();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.get("/", (_request, response) => response.type("html").send(dashboardHtml));
app.get("/download/codex-mesh-mcp.zip", (_request, response) => {
  if (!config.bridgePackagePath) {
    response.status(404).json({ error: "Bridge package is not configured" });
    return;
  }
  response.download(config.bridgePackagePath, "codex-mesh-mcp.zip");
});
app.get("/healthz", (_request, response) => {
  response.json({
    ok: true,
    connectedNodes: store.listNodes().filter((node) => node.connected).length,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});
app.use("/api", (request, response, next) => mcp.authorize(request, response, next));
app.get("/api/snapshot", (_request, response) => {
  response.json({
    nodes: store.listNodes().map(safeNode),
    tasks: store.listTasks(100).map(safeTask),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});
app.get("/api/events", (request, response) => {
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.write(`event: ready\ndata: {}\n\n`);
  const unsubscribe = store.subscribe((taskId) => {
    response.write(`event: task\ndata: ${JSON.stringify({ taskId })}\n\n`);
  });
  const ping = setInterval(() => response.write(`: ping\n\n`), 20_000);
  request.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});
app.post("/api/pairing-code", (_request, response) => response.json(pairing.createCode(10)));
app.post("/pair", (request, response) => {
  const address = request.ip || request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const current = pairAttempts.get(address);
  const attempt = !current || current.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : current;
  attempt.count += 1;
  pairAttempts.set(address, attempt);
  if (attempt.count > 10) {
    response.status(429).json({ error: "Too many pairing attempts; retry in one minute" });
    return;
  }
  const parsed = z.object({
    code: z.string().regex(/^\d{6}$/),
    nodeId: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
  }).safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid pairing request" });
    return;
  }
  const nodeToken = pairing.pairNode(parsed.data.code, parsed.data.nodeId);
  if (!nodeToken) {
    response.status(403).json({ error: "Pairing code is invalid or expired" });
    return;
  }
  const forwardedProto = request.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const secure = forwardedProto === "https" || request.secure;
  const host = request.header("host") ?? `${config.host}:${config.port}`;
  response.json({
    nodeId: parsed.data.nodeId,
    nodeToken,
    bridgeUrl: `${secure ? "wss" : "ws"}://${host}/bridge`,
    mcpUrl: `${secure ? "https" : "http"}://${host}/mcp`,
  });
});
app.use("/mcp", (request, response, next) => mcp.authorize(request, response, next));
app.post("/mcp", (request, response, next) => void mcp.post(request, response).catch(next));
app.get("/mcp", (request, response, next) => void mcp.sessionRequest(request, response).catch(next));
app.delete("/mcp", (request, response, next) => void mcp.sessionRequest(request, response).catch(next));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  if (!response.headersSent) response.status(500).json({ error: "internal server error" });
});

const httpServer = createServer(app);
httpServer.on("upgrade", (request, socket, head) => hub.handleUpgrade(request, socket, head));
httpServer.listen(config.port, config.host, () => {
  console.log(`Codex Mesh relay listening on http://${config.host}:${config.port}`);
  console.log(`MCP endpoint: http://${config.host}:${config.port}/mcp`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  httpServer.close();
  hub.close();
  await mcp.close();
  store.close();
}

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

function safeNode(node: MeshNode): MeshNode {
  return {
    ...node,
    threads: node.threads.map((thread) => ({
      ...thread,
      name: thread.name ? redactSecrets(thread.name) : thread.name,
      preview: redactSecrets(thread.preview),
    })),
  };
}

function safeTask(task: MeshTask): MeshTask {
  return {
    ...task,
    prompt: redactSecrets(task.prompt),
    result: task.result ? redactSecrets(task.result) : task.result,
    error: task.error ? redactSecrets(task.error) : task.error,
    metadata: task.metadata
      ? JSON.parse(redactSecrets(JSON.stringify(task.metadata))) as Record<string, unknown>
      : undefined,
  };
}
