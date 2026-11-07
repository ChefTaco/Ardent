import { Task as TaskCodec, TaskState, type ListTasksRequest, type ListTasksResponse, type Task } from '@a2a-js/sdk';
import type { ServerCallContext, TaskStore as A2ATaskStore } from '@a2a-js/sdk/server';
import type Database from 'better-sqlite3';
import { z } from 'zod';

const StoredTask = z.object({ id: z.string().min(1), contextId: z.string(), status: z.object({ state: z.string(), timestamp: z.string().optional() }).nullable().optional(), artifacts: z.array(z.unknown()).optional(), history: z.array(z.unknown()).optional() }).passthrough();
const Row = z.object({ task_json: z.string() });
const Cursor = z.object({ timestamp: z.string(), id: z.string() });

function owner(context: ServerCallContext): { tenant: string; caller: string } {
  const user = context.user;
  if (!user?.isAuthenticated || !user.userName) throw new Error('Authenticated A2A caller required');
  return { tenant: context.tenant ?? '', caller: user.userName };
}

function readTask(json: string): Task {
  const raw: unknown = JSON.parse(json);
  StoredTask.parse(raw);
  return TaskCodec.fromJSON(raw);
}

export class SqliteA2ATaskStore implements A2ATaskStore {
  constructor(readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS a2a_tasks (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, caller TEXT NOT NULL,
      context_id TEXT NOT NULL, status TEXT NOT NULL, status_timestamp TEXT NOT NULL,
      task_json TEXT NOT NULL, updated_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS a2a_tasks_scope ON a2a_tasks(tenant, caller, status_timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS a2a_tasks_scope_context ON a2a_tasks(tenant, caller, context_id, status_timestamp DESC, id DESC);`);
    db.exec(`CREATE TABLE IF NOT EXISTS a2a_request_receipts (
      tenant TEXT NOT NULL, caller TEXT NOT NULL, message_id TEXT NOT NULL,
      request_sha256 TEXT NOT NULL, task_id TEXT, created_ms INTEGER NOT NULL,
      PRIMARY KEY(tenant, caller, message_id));`);
  }
  async save(task: Task, context: ServerCallContext): Promise<void> {
    const scope = owner(context);
    if (!task.id || !task.contextId) throw new Error('A2A task id/context required');
    const prior = this.db.prepare('SELECT tenant, caller FROM a2a_tasks WHERE id=?').get(task.id);
    if (prior) {
      const bound = z.object({ tenant: z.string(), caller: z.string() }).parse(prior);
      if (bound.tenant !== scope.tenant || bound.caller !== scope.caller) throw new Error('A2A task owner mismatch');
    }
    this.db.prepare(`INSERT INTO a2a_tasks(id,tenant,caller,context_id,status,status_timestamp,task_json,updated_ms)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET context_id=excluded.context_id,status=excluded.status,
      status_timestamp=excluded.status_timestamp,task_json=excluded.task_json,updated_ms=excluded.updated_ms`)
      .run(task.id, scope.tenant, scope.caller, task.contextId, task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED, task.status?.timestamp ?? '', JSON.stringify(TaskCodec.toJSON(task)), Date.now());
    const newest = task.history?.at(-1)?.messageId;
    if (newest) this.db.prepare('UPDATE a2a_request_receipts SET task_id=? WHERE tenant=? AND caller=? AND message_id=? AND (task_id IS NULL OR task_id=?)')
      .run(task.id, scope.tenant, scope.caller, newest, task.id);
  }
  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const scope = owner(context);
    const row = this.db.prepare('SELECT task_json FROM a2a_tasks WHERE id=? AND tenant=? AND caller=?').get(taskId, scope.tenant, scope.caller);
    return row ? readTask(Row.parse(row).task_json) : undefined;
  }
  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const scope = owner(context);
    const size = params.pageSize ?? 50;
    if (!Number.isInteger(size) || size < 1 || size > 100) throw new Error('Invalid A2A pageSize');
    // The context and timestamp columns are written from the same task as
    // task_json, so these SQL filters, ordering and cursor match the former
    // in-memory evaluation. The status column's encoding depends on the SQLite
    // driver's number binding, so a status filter is still applied to parsed tasks.
    const where = ['tenant=?', 'caller=?'];
    const values: string[] = [scope.tenant, scope.caller];
    if (params.contextId) { where.push('context_id=?'); values.push(params.contextId); }
    if (params.statusTimestampAfter) { where.push("status_timestamp!='' AND status_timestamp>?"); values.push(params.statusTimestampAfter); }
    const filter = where.join(' AND ');
    let cursor: z.infer<typeof Cursor> | undefined;
    if (params.pageToken) {
      try { cursor = Cursor.parse(JSON.parse(Buffer.from(params.pageToken, 'base64url').toString('utf8')) as unknown); }
      catch { throw new Error('Invalid A2A pageToken'); }
    }
    let page: Task[];
    let total: number;
    let more: boolean;
    if (params.status !== undefined && params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
      const filtered = this.db.prepare(`SELECT task_json FROM a2a_tasks WHERE ${filter} ORDER BY status_timestamp DESC,id DESC`).all(...values)
        .map(row => readTask(Row.parse(row).task_json)).filter(task => task.status?.state === params.status);
      let start = 0;
      if (cursor) {
        const found = filtered.findIndex(task => task.id === cursor.id && (task.status?.timestamp ?? '') === cursor.timestamp);
        if (found < 0) throw new Error('A2A page cursor was not found');
        start = found + 1;
      }
      page = filtered.slice(start, start + size);
      total = filtered.length;
      more = start + size < filtered.length;
    } else {
      total = z.object({ total: z.number().int() }).parse(this.db.prepare(`SELECT count(*) AS total FROM a2a_tasks WHERE ${filter}`).get(...values)).total;
      let after = '';
      const afterValues: string[] = [];
      if (cursor) {
        if (!this.db.prepare(`SELECT 1 FROM a2a_tasks WHERE ${filter} AND id=? AND status_timestamp=?`).get(...values, cursor.id, cursor.timestamp))
          throw new Error('A2A page cursor was not found');
        after = ' AND (status_timestamp<? OR (status_timestamp=? AND id<?))';
        afterValues.push(cursor.timestamp, cursor.timestamp, cursor.id);
      }
      const rows = this.db.prepare(`SELECT task_json FROM a2a_tasks WHERE ${filter}${after} ORDER BY status_timestamp DESC,id DESC LIMIT ?`)
        .all(...values, ...afterValues, size + 1).map(row => readTask(Row.parse(row).task_json));
      page = rows.slice(0, size);
      more = rows.length > size;
    }
    const last = page.at(-1);
    const nextPageToken = last && more
      ? Buffer.from(JSON.stringify({ timestamp: last.status?.timestamp ?? '', id: last.id })).toString('base64url') : '';
    return { tasks: page.map(task => params.includeArtifacts ? task : { ...task, artifacts: [] }), nextPageToken, pageSize: size, totalSize: total };
  }
}
