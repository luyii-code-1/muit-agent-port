import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";

type LedgerStatus = "accepted" | "running" | "completed" | "failed";

export interface LedgerEntry {
  taskId: string;
  status: LedgerStatus;
  threadId?: string;
  result?: string;
  error?: string;
}

interface LedgerRow {
  task_id: string;
  status: LedgerStatus;
  thread_id: string | null;
  result: string | null;
  error: string | null;
}

export class BridgeLedger {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_ledger (
        task_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        thread_id TEXT,
        result TEXT,
        error TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.prepare(`
      UPDATE task_ledger
      SET status = 'failed',
          error = 'Bridge restarted while this task was in progress; automatic replay was blocked to avoid duplicate edits.',
          updated_at = ?
      WHERE status IN ('accepted', 'running')
    `).run(Date.now());
  }

  get(taskId: string): LedgerEntry | undefined {
    const row = this.db.prepare("SELECT * FROM task_ledger WHERE task_id = ?").get(taskId) as LedgerRow | undefined;
    if (!row) return undefined;
    return {
      taskId: row.task_id,
      status: row.status,
      threadId: row.thread_id ?? undefined,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
    };
  }

  accept(taskId: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO task_ledger (task_id, status, updated_at)
      VALUES (?, 'accepted', ?)
    `).run(taskId, Date.now());
  }

  update(taskId: string, status: LedgerStatus, values: Pick<LedgerEntry, "threadId" | "result" | "error"> = {}): void {
    this.db.prepare(`
      UPDATE task_ledger SET
        status = @status,
        thread_id = @threadId,
        result = @result,
        error = @error,
        updated_at = @updatedAt
      WHERE task_id = @taskId
    `).run({
      taskId,
      status,
      threadId: values.threadId ?? null,
      result: values.result ?? null,
      error: values.error ?? null,
      updatedAt: Date.now(),
    });
  }

  close(): void {
    this.db.close();
  }
}
