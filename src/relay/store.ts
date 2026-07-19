import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";

import type { DispatchPayload, MeshNode, MeshTask, MeshTaskEvent, ProjectSummary, TaskStatus, ThreadSummary } from "../shared/types.js";
import { redactSecrets } from "../shared/util.js";

interface TaskRow {
  id: string;
  source_node_id: string | null;
  target_node_id: string;
  prompt: string;
  routing: DispatchPayload["routing"];
  thread_id: string | null;
  thread_query: string | null;
  cwd: string | null;
  metadata_json: string | null;
  status: TaskStatus;
  selected_thread_id: string | null;
  execution_mode: "desktop" | "background" | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface NodeRow {
  id: string;
  hostname: string;
  platform: string;
  labels_json: string;
  connected: number;
  last_seen_at: number;
  threads_json: string;
  token_hash: string | null;
  projects_json: string;
  roles_json: string;
  role_source: "manual" | "codex" | null;
  role_updated_at: number | null;
}

export class MeshStore {
  private readonly db: Database.Database;
  private readonly events = new EventEmitter();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        hostname TEXT NOT NULL,
        platform TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        connected INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL,
        threads_json TEXT NOT NULL DEFAULT '[]',
        token_hash TEXT,
        projects_json TEXT NOT NULL DEFAULT '[]',
        roles_json TEXT NOT NULL DEFAULT '[]',
        role_source TEXT,
        role_updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        source_node_id TEXT,
        target_node_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        routing TEXT NOT NULL,
        thread_id TEXT,
        thread_query TEXT,
        cwd TEXT,
        metadata_json TEXT,
        status TEXT NOT NULL,
        selected_thread_id TEXT,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_target_status_idx
      ON tasks(target_node_id, status, created_at);

      CREATE TABLE IF NOT EXISTS pairing_codes (
        code_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_events_task_id_idx
      ON task_events(task_id, id);
    `);
    const nodeColumns = this.db.pragma("table_info(nodes)") as Array<{ name: string }>;
    if (!nodeColumns.some((column) => column.name === "token_hash")) {
      this.db.exec("ALTER TABLE nodes ADD COLUMN token_hash TEXT");
    }
    if (!nodeColumns.some((column) => column.name === "projects_json")) {
      this.db.exec("ALTER TABLE nodes ADD COLUMN projects_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!nodeColumns.some((column) => column.name === "roles_json")) {
      this.db.exec("ALTER TABLE nodes ADD COLUMN roles_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!nodeColumns.some((column) => column.name === "role_source")) {
      this.db.exec("ALTER TABLE nodes ADD COLUMN role_source TEXT");
    }
    if (!nodeColumns.some((column) => column.name === "role_updated_at")) {
      this.db.exec("ALTER TABLE nodes ADD COLUMN role_updated_at INTEGER");
    }
    const taskColumns = this.db.pragma("table_info(tasks)") as Array<{ name: string }>;
    if (!taskColumns.some((column) => column.name === "execution_mode")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN execution_mode TEXT");
    }
  }

  close(): void {
    this.db.close();
  }

  upsertNode(node: Omit<MeshNode, "connected" | "lastSeenAt" | "threads" | "projects" | "roles" | "roleSource" | "roleUpdatedAt">): MeshNode {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO nodes (id, hostname, platform, labels_json, connected, last_seen_at, threads_json)
      VALUES (@id, @hostname, @platform, @labels, 1, @now, '[]')
      ON CONFLICT(id) DO UPDATE SET
        hostname = excluded.hostname,
        platform = excluded.platform,
        labels_json = excluded.labels_json,
        connected = 1,
        last_seen_at = excluded.last_seen_at
    `).run({
      id: node.id,
      hostname: node.hostname,
      platform: node.platform,
      labels: JSON.stringify(node.labels),
      now,
    });
    return this.getNode(node.id)!;
  }

  setNodeDisconnected(nodeId: string): void {
    this.db.prepare("UPDATE nodes SET connected = 0, last_seen_at = ? WHERE id = ?").run(Date.now(), nodeId);
  }

  updateThreads(nodeId: string, threads: ThreadSummary[]): void {
    this.db.prepare(
      "UPDATE nodes SET threads_json = ?, last_seen_at = ?, connected = 1 WHERE id = ?",
    ).run(JSON.stringify(sanitizeThreads(threads)), Date.now(), nodeId);
  }

  updateInventory(nodeId: string, threads: ThreadSummary[], projects: ProjectSummary[]): void {
    this.db.prepare(
      "UPDATE nodes SET threads_json = ?, projects_json = ?, last_seen_at = ?, connected = 1 WHERE id = ?",
    ).run(JSON.stringify(sanitizeThreads(threads)), JSON.stringify(projects), Date.now(), nodeId);
  }

  getNode(nodeId: string): MeshNode | undefined {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as NodeRow | undefined;
    return row ? this.nodeFromRow(row) : undefined;
  }

  listNodes(): MeshNode[] {
    const rows = this.db.prepare("SELECT * FROM nodes ORDER BY connected DESC, last_seen_at DESC").all() as NodeRow[];
    return rows.map((row) => this.nodeFromRow(row));
  }

  setNodeRoles(nodeId: string, roles: string[], source: "manual" | "codex"): MeshNode | undefined {
    const normalized = normalizeRoles(roles);
    const result = this.db.prepare(
      "UPDATE nodes SET roles_json = ?, role_source = ?, role_updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(normalized), source, Date.now(), nodeId);
    if (result.changes === 0) return undefined;
    this.emitChange(`node:${nodeId}`);
    return this.getNode(nodeId);
  }

  setNodeTokenHash(nodeId: string, tokenHash: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO nodes (id, hostname, platform, labels_json, connected, last_seen_at, threads_json, token_hash)
      VALUES (?, ?, ?, '[]', 0, ?, '[]', ?)
      ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, last_seen_at = excluded.last_seen_at
    `).run(nodeId, nodeId, "unknown", now, tokenHash);
  }

  getNodeTokenHash(nodeId: string): string | undefined {
    const row = this.db.prepare("SELECT token_hash FROM nodes WHERE id = ?").get(nodeId) as { token_hash: string | null } | undefined;
    return row?.token_hash ?? undefined;
  }

  createPairingCode(codeHash: string, expiresAt: number): void {
    const now = Date.now();
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?").run(now);
      this.db.prepare("INSERT INTO pairing_codes (code_hash, expires_at, created_at) VALUES (?, ?, ?)")
        .run(codeHash, expiresAt, now);
    });
    transaction();
  }

  consumePairingCode(codeHash: string): boolean {
    const now = Date.now();
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?").run(now);
      const result = this.db.prepare("DELETE FROM pairing_codes WHERE code_hash = ? AND expires_at > ?")
        .run(codeHash, now);
      return result.changes === 1;
    });
    return transaction();
  }

  listTasks(limit = 100): MeshTask[] {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit) as TaskRow[];
    return rows.map((row) => this.taskFromRow(row));
  }

  createTask(task: MeshTask): void {
    this.db.prepare(`
      INSERT INTO tasks (
        id, source_node_id, target_node_id, prompt, routing, thread_id,
        thread_query, cwd, metadata_json, status, selected_thread_id,
        result, error, execution_mode, created_at, updated_at
      ) VALUES (
        @id, @sourceNodeId, @targetNodeId, @prompt, @routing, @threadId,
        @threadQuery, @cwd, @metadata, @status, @selectedThreadId,
        @result, @error, @executionMode, @createdAt, @updatedAt
      )
    `).run({
      id: task.taskId,
      sourceNodeId: task.sourceNodeId ?? null,
      targetNodeId: task.targetNodeId,
      prompt: task.prompt,
      routing: task.routing,
      threadId: task.threadId ?? null,
      threadQuery: task.threadQuery ?? null,
      cwd: task.cwd ?? null,
      metadata: task.metadata ? JSON.stringify(task.metadata) : null,
      status: task.status,
      selectedThreadId: task.selectedThreadId ?? null,
      result: task.result ?? null,
      error: task.error ?? null,
      executionMode: task.executionMode ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
    this.emitChange(task.taskId);
  }

  getTask(taskId: string): MeshTask | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    return row ? this.taskFromRow(row) : undefined;
  }

  listPendingTasks(nodeId: string): MeshTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE target_node_id = ? AND status IN ('queued', 'dispatched', 'running')
      ORDER BY created_at ASC
    `).all(nodeId) as TaskRow[];
    return rows.map((row) => this.taskFromRow(row));
  }

  updateTask(
    taskId: string,
    patch: Partial<Pick<MeshTask, "status" | "selectedThreadId" | "executionMode" | "result" | "error">>,
  ): MeshTask | undefined {
    const current = this.getTask(taskId);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.db.prepare(`
      UPDATE tasks SET
        status = @status,
        selected_thread_id = @selectedThreadId,
        execution_mode = @executionMode,
        result = @result,
        error = @error,
        updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id: taskId,
      status: next.status,
      selectedThreadId: next.selectedThreadId ?? null,
      executionMode: next.executionMode ?? null,
      result: next.result ?? null,
      error: next.error ?? null,
      updatedAt: next.updatedAt,
    });
    this.emitChange(taskId);
    return next;
  }

  appendTaskEvent(event: Omit<MeshTaskEvent, "id" | "createdAt">): MeshTaskEvent {
    const createdAt = Date.now();
    const previous = this.db.prepare(`
      SELECT id, kind, title, detail, payload_json, created_at
      FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1
    `).get(event.taskId) as {
      id: number; kind: MeshTaskEvent["kind"]; title: string; detail: string | null;
      payload_json: string | null; created_at: number;
    } | undefined;
    const safeTitle = redactSecrets(event.title);
    const safeDetail = event.detail ? redactSecrets(event.detail) : undefined;
    const safePayload = event.payload ? redactSecrets(JSON.stringify(event.payload)) : undefined;
    if (
      previous
      && previous.kind === event.kind
      && previous.title === safeTitle
      && createdAt - previous.created_at < 10_000
      && (!previous.detail || safeDetail?.startsWith(previous.detail))
    ) {
      this.db.prepare(`
        UPDATE task_events SET detail = ?, payload_json = ?, created_at = ? WHERE id = ?
      `).run(safeDetail ?? previous.detail, safePayload ?? previous.payload_json, createdAt, previous.id);
      this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(createdAt, event.taskId);
      const saved = {
        ...event,
        id: previous.id,
        title: safeTitle,
        detail: safeDetail ?? previous.detail ?? undefined,
        payload: safePayload ? JSON.parse(safePayload) as Record<string, unknown> : event.payload,
        createdAt,
      };
      this.emitChange(event.taskId);
      return saved;
    }
    const result = this.db.prepare(`
      INSERT INTO task_events (task_id, kind, title, detail, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.taskId,
      event.kind,
      safeTitle,
      safeDetail ?? null,
      safePayload ?? null,
      createdAt,
    );
    // Bound retained progress per task so long-running command output cannot grow forever.
    this.db.prepare(`
      DELETE FROM task_events WHERE task_id = ? AND id NOT IN (
        SELECT id FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 250
      )
    `).run(event.taskId, event.taskId);
    const saved = { ...event, id: Number(result.lastInsertRowid), createdAt };
    this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(createdAt, event.taskId);
    this.emitChange(event.taskId);
    return saved;
  }

  subscribe(listener: (taskId: string) => void): () => void {
    this.events.on("change", listener);
    return () => this.events.off("change", listener);
  }

  async waitForTask(taskId: string, timeoutMs: number): Promise<MeshTask | undefined> {
    const current = this.getTask(taskId);
    if (!current || current.status === "completed" || current.status === "failed" || timeoutMs <= 0) {
      return current;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      const listener = (): void => done();
      const self = this;
      function done(): void {
        clearTimeout(timer);
        self.events.off(taskId, listener);
        resolve();
      }
      this.events.once(taskId, listener);
      const latest = this.getTask(taskId);
      if (!latest || latest.updatedAt !== current.updatedAt || latest.status === "completed" || latest.status === "failed") {
        done();
      }
    });
    return this.getTask(taskId);
  }

  private nodeFromRow(row: NodeRow): MeshNode {
    return {
      id: row.id,
      hostname: row.hostname,
      platform: row.platform,
      labels: JSON.parse(row.labels_json) as string[],
      roles: JSON.parse(row.roles_json || "[]") as string[],
      roleSource: row.role_source ?? undefined,
      roleUpdatedAt: row.role_updated_at ?? undefined,
      connected: row.connected === 1,
      lastSeenAt: row.last_seen_at,
      threads: JSON.parse(row.threads_json) as ThreadSummary[],
      projects: JSON.parse(row.projects_json) as ProjectSummary[],
    };
  }

  private taskFromRow(row: TaskRow): MeshTask {
    return {
      taskId: row.id,
      sourceNodeId: row.source_node_id ?? undefined,
      targetNodeId: row.target_node_id,
      prompt: row.prompt,
      routing: row.routing,
      threadId: row.thread_id ?? undefined,
      threadQuery: row.thread_query ?? undefined,
      cwd: row.cwd ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined,
      status: row.status,
      selectedThreadId: row.selected_thread_id ?? undefined,
      executionMode: row.execution_mode ?? undefined,
      events: this.listTaskEvents(row.id),
      result: row.result ?? undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private listTaskEvents(taskId: string): MeshTaskEvent[] {
    const rows = this.db.prepare(`
      SELECT id, task_id, kind, title, detail, payload_json, created_at
      FROM task_events WHERE task_id = ? ORDER BY id ASC
    `).all(taskId) as Array<{
      id: number; task_id: string; kind: MeshTaskEvent["kind"]; title: string;
      detail: string | null; payload_json: string | null; created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      kind: row.kind,
      title: row.title,
      detail: row.detail ?? undefined,
      payload: row.payload_json ? JSON.parse(row.payload_json) as Record<string, unknown> : undefined,
      createdAt: row.created_at,
    }));
  }

  private emitChange(taskId: string): void {
    this.events.emit(taskId);
    this.events.emit("change", taskId);
  }
}

function normalizeRoles(roles: string[]): string[] {
  return [...new Set(roles.map((role) => role.trim()).filter(Boolean))].slice(0, 20);
}

function sanitizeThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return threads.map((thread) => ({
    ...thread,
    name: thread.name ? redactSecrets(thread.name) : thread.name,
    preview: redactSecrets(thread.preview),
  }));
}
