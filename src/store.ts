import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';

export const TaskState = z.enum(['queued', 'running', 'input_required', 'completed', 'partial', 'failed', 'cancelled', 'unknown']);
export type TaskState = z.infer<typeof TaskState>;
export const TaskSchema = z.object({ id: z.string().guid(), caller: z.string(), context: z.enum(['direct', 'peer', 'scheduled']), session_id: z.string().guid().nullable(), prompt: z.string(), content_hash: z.string(), idempotency_key: z.string().nullable(), backend: z.enum(['llamacpp', 'codex']), state: TaskState, result: z.string().nullable(), error: z.string().nullable(), deadline_ms: z.number().int(), created_ms: z.number().int(), updated_ms: z.number().int() });
export type Task = z.infer<typeof TaskSchema>;
export const SessionSchema = z.object({ id: z.string().guid(), caller: z.string(), context: z.enum(['direct', 'peer', 'scheduled']), key: z.string(), created_ms: z.number().int(), updated_ms: z.number().int() });
export type Session = z.infer<typeof SessionSchema>;
export const SessionMessageSchema = z.object({ sequence: z.number().int(), session_id: z.string().guid(), task_id: z.string().guid(), role: z.enum(['user', 'assistant']), content: z.string(), created_ms: z.number().int() });
export type SessionMessage = z.infer<typeof SessionMessageSchema>;
export const EventSchema = z.object({ sequence: z.number().int(), task_id: z.string(), kind: z.string(), detail: z.unknown().optional(), created_ms: z.number().int() });
export type TaskEvent = z.infer<typeof EventSchema>;

export class TaskStore {
  readonly db: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, caller TEXT NOT NULL, context TEXT NOT NULL, prompt TEXT NOT NULL,
      session_id TEXT, content_hash TEXT NOT NULL, idempotency_key TEXT, backend TEXT NOT NULL, state TEXT NOT NULL,
      result TEXT, error TEXT, deadline_ms INTEGER NOT NULL, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
      UNIQUE(caller, context, idempotency_key));
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, caller TEXT NOT NULL, context TEXT NOT NULL, key TEXT NOT NULL,
        created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, UNIQUE(caller, context, key));
      CREATE TABLE IF NOT EXISTS session_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        task_id TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL, content TEXT NOT NULL, created_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS session_messages_session_sequence ON session_messages(session_id, sequence);
      CREATE TABLE IF NOT EXISTS channel_inbound (
        platform TEXT NOT NULL, account TEXT NOT NULL, update_id TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id), created_ms INTEGER NOT NULL,
        channel_type TEXT NOT NULL DEFAULT 'unknown' CHECK(channel_type IN
          ('unknown','telegram_private','telegram_group','telegram_supergroup',
           'mattermost_dm','mattermost_channel')),
        PRIMARY KEY(platform, account, update_id));
      CREATE TABLE IF NOT EXISTS channel_cursors (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_preferences (
        caller TEXT NOT NULL, session_key TEXT NOT NULL, backend TEXT NOT NULL,
        updated_ms INTEGER NOT NULL, PRIMARY KEY(caller, session_key));
      CREATE TABLE IF NOT EXISTS channel_deliveries (
        id TEXT PRIMARY KEY, platform TEXT NOT NULL, account TEXT NOT NULL, update_id TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id), state TEXT NOT NULL, external_id TEXT, error TEXT,
        created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
        UNIQUE(platform, account, update_id));
      CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
      kind TEXT NOT NULL, detail_json TEXT NOT NULL, created_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task_sequence ON events(task_id, sequence);
      CREATE TABLE IF NOT EXISTS admission_fence (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), release_id TEXT NOT NULL,
        closed_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS context_checkpoints (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        caller TEXT NOT NULL, context TEXT NOT NULL, parent_id TEXT,
        source_watermark INTEGER NOT NULL, source_sha256 TEXT NOT NULL,
        summary_json TEXT NOT NULL, summary_sha256 TEXT NOT NULL,
        model TEXT NOT NULL, reasoning_effort TEXT NOT NULL,
        policy_revision INTEGER NOT NULL, policy_sha256 TEXT NOT NULL,
        source_tokens INTEGER NOT NULL, summary_tokens INTEGER NOT NULL,
        created_ms INTEGER NOT NULL, validation TEXT NOT NULL CHECK(validation='passed'));
      CREATE INDEX IF NOT EXISTS context_checkpoints_session ON context_checkpoints(session_id,created_ms);
      CREATE TABLE IF NOT EXISTS context_checkpoint_heads (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id), checkpoint_id TEXT NOT NULL REFERENCES context_checkpoints(id));
      CREATE TABLE IF NOT EXISTS context_compaction_attempts (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        source_watermark INTEGER, parent_id TEXT, policy_revision INTEGER,
        model TEXT, outcome TEXT NOT NULL, reason TEXT,
        created_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS context_attempts_session ON context_compaction_attempts(session_id,created_ms);`);
    const columns = z.array(z.object({ name: z.string() })).parse(this.db.pragma('table_info(tasks)'));
    if (!columns.some(column => column.name === 'session_id')) this.db.exec('ALTER TABLE tasks ADD COLUMN session_id TEXT');
    // Additive lookup indexes for caller listing, session history and recovery.
    // Created after the column migration so an older database gains session_id first.
    this.db.exec(`CREATE INDEX IF NOT EXISTS tasks_caller_created ON tasks(caller, created_ms);
      CREATE INDEX IF NOT EXISTS tasks_session_created ON tasks(session_id, created_ms);
      CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state);`);
    const inboundColumns = z.array(z.object({ name: z.string() })).parse(this.db.pragma('table_info(channel_inbound)'));
    if (!inboundColumns.some(column => column.name === 'channel_type')) this.db.exec(`ALTER TABLE channel_inbound ADD COLUMN
      channel_type TEXT NOT NULL DEFAULT 'unknown' CHECK(channel_type IN
        ('unknown','telegram_private','telegram_group','telegram_supergroup',
         'mattermost_dm','mattermost_channel'))`);
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS channel_inbound_type_immutable
      BEFORE UPDATE OF channel_type ON channel_inbound
      WHEN OLD.channel_type != NEW.channel_type
      BEGIN SELECT RAISE(ABORT, 'Inbound channel type is immutable'); END;`);
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS session_messages_immutable_update
      BEFORE UPDATE ON session_messages BEGIN SELECT RAISE(ABORT, 'Session messages are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS session_messages_immutable_delete
      BEFORE DELETE ON session_messages BEGIN SELECT RAISE(ABORT, 'Session messages are immutable'); END;`);
  }
  close(): void { this.db.close(); }
  admissionFence(): { release_id: string; closed_ms: number } | null {
    const row = this.db.prepare('SELECT release_id,closed_ms FROM admission_fence WHERE singleton=1').get();
    return row ? z.object({ release_id: z.string().guid(), closed_ms: z.number().int() }).parse(row) : null;
  }
  closeAdmission(releaseId: string): { release_id: string; closed_ms: number; queued: number; running: number; unknown: number; deliveries_unsettled: number; inbound_unbound: number } {
    z.string().guid().parse(releaseId);
    return this.db.transaction(() => {
      const prior = this.admissionFence();
      if (prior && prior.release_id !== releaseId) throw new Error('Admission is already fenced by another release');
      if (!prior) this.db.prepare('INSERT INTO admission_fence(singleton,release_id,closed_ms) VALUES (1,?,?)').run(releaseId, Date.now());
      const state = this.admissionFence()!;
      const count = (sql: string) => z.object({ count: z.number().int() }).parse(this.db.prepare(sql).get()).count;
      return { ...state,
        queued: count("SELECT count(*) AS count FROM tasks WHERE state='queued'"),
        running: count("SELECT count(*) AS count FROM tasks WHERE state='running'"),
        unknown: count("SELECT count(*) AS count FROM tasks WHERE state='unknown'"),
        deliveries_unsettled: count("SELECT count(*) AS count FROM channel_deliveries WHERE state IN ('queued','unknown')"),
        inbound_unbound: count(`SELECT count(*) AS count FROM channel_inbound AS inbound
          LEFT JOIN channel_deliveries AS delivery ON delivery.platform=inbound.platform
            AND delivery.account=inbound.account AND delivery.update_id=inbound.update_id
          WHERE inbound.task_id IS NULL AND (delivery.id IS NULL OR delivery.state IN ('queued','unknown'))`) };
    })();
  }
  session(caller: string, context: 'direct' | 'peer' | 'scheduled', key: string): Session {
    if (!caller || caller.length > 128 || !key || key.length > 256) throw new Error('Invalid session identity');
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM sessions WHERE caller=? AND context=? AND key=?').get(caller, context, key);
      if (previous) return SessionSchema.parse(previous);
      const now = Date.now();
      const value: Session = { id: randomUUID(), caller, context, key, created_ms: now, updated_ms: now };
      this.db.prepare('INSERT INTO sessions(id,caller,context,key,created_ms,updated_ms) VALUES (@id,@caller,@context,@key,@created_ms,@updated_ms)').run(value);
      return value;
    })();
  }
  resetSession(caller: string, context: 'direct' | 'peer' | 'scheduled', key: string): Session {
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM sessions WHERE caller=? AND context=? AND key=?').get(caller, context, key);
      if (previous) this.db.prepare('UPDATE sessions SET key=? WHERE id=?').run(`${key}:archived:${randomUUID()}`, SessionSchema.parse(previous).id);
      return this.session(caller, context, key);
    })();
  }
  listSessions(caller: string, context: 'direct' | 'peer' | 'scheduled', limit = 50): Session[] {
    return this.db.prepare('SELECT * FROM sessions WHERE caller=? AND context=? ORDER BY updated_ms DESC LIMIT ?').all(caller, context, Math.max(1, Math.min(limit, 100))).map(row => SessionSchema.parse(row));
  }
  sessionMessages(sessionId: string, caller: string, limit = 100): SessionMessage[] {
    const session = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    if (!session || SessionSchema.parse(session).caller !== caller) throw new Error('Session not found');
    return this.db.prepare('SELECT * FROM (SELECT * FROM session_messages WHERE session_id=? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence').all(sessionId, Math.max(1, Math.min(limit, 500))).map(row => SessionMessageSchema.parse(row));
  }
  accept(input: { caller: string; context: 'direct' | 'peer' | 'scheduled'; sessionId?: string; prompt: string; idempotencyKey?: string; backend: 'llamacpp' | 'codex'; deadlineMs: number }): Task {
    if (!input.caller || input.caller.length > 128 || !input.prompt.trim() || input.prompt.length > 16000 || (input.idempotencyKey && input.idempotencyKey.length > 128)) throw new Error('Invalid task input');
    const hash = createHash('sha256').update(JSON.stringify([input.prompt, input.backend])).digest('hex');
    return this.db.transaction(() => {
      if (this.admissionFence()) throw new Error('Profile admission is fenced for rollback');
      if (input.sessionId) {
        const session = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(input.sessionId);
        if (!session) throw new Error('Session not found');
        const scoped = SessionSchema.parse(session);
        if (scoped.caller !== input.caller || scoped.context !== input.context) throw new Error('Session caller or context mismatch');
      }
      if (input.idempotencyKey) {
        const previous = this.db.prepare('SELECT * FROM tasks WHERE caller=? AND context=? AND idempotency_key=?').get(input.caller, input.context, input.idempotencyKey);
        if (previous) {
          const task = TaskSchema.parse(previous);
          if (task.content_hash !== hash) throw new Error('Idempotency key reused with different task content');
          return task;
        }
      }
      const now = Date.now();
      const task: Task = { id: randomUUID(), caller: input.caller, context: input.context, session_id: input.sessionId ?? null, prompt: input.prompt, content_hash: hash, idempotency_key: input.idempotencyKey ?? null, backend: input.backend, state: 'queued', result: null, error: null, deadline_ms: input.deadlineMs, created_ms: now, updated_ms: now };
      this.db.prepare(`INSERT INTO tasks (id,caller,context,session_id,prompt,content_hash,idempotency_key,backend,state,result,error,deadline_ms,created_ms,updated_ms)
        VALUES (@id,@caller,@context,@session_id,@prompt,@content_hash,@idempotency_key,@backend,@state,@result,@error,@deadline_ms,@created_ms,@updated_ms)`).run(task);
      if (task.session_id) this.db.prepare('INSERT INTO session_messages(session_id,task_id,role,content,created_ms) VALUES (?,?,?,?,?)').run(task.session_id, task.id, 'user', task.prompt, now);
      this.append(task.id, 'accepted', { caller: input.caller, context: input.context, backend: input.backend });
      return task;
    })();
  }
  appendAssistant(task: Task, content: string): void {
    if (!task.session_id) return;
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO session_messages(session_id,task_id,role,content,created_ms) VALUES (?,?,?,?,?)').run(task.session_id, task.id, 'assistant', content, Date.now());
      this.db.prepare('UPDATE sessions SET updated_ms=? WHERE id=?').run(Date.now(), task.session_id);
    })();
  }
  finishWithAssistant(id: string, state: 'completed' | 'partial', content: string): void {
    this.db.transaction(() => {
      const prior = this.get(id);
      if (!prior || ['completed', 'partial', 'failed', 'cancelled', 'unknown'].includes(prior.state))
        throw new Error('Task is absent or terminal');
      const now = Date.now();
      this.db.prepare('UPDATE tasks SET state=?,result=?,error=NULL,updated_ms=? WHERE id=?').run(state, content, now, id);
      this.append(id, 'state', { from: prior.state, to: state, error: null });
      if (prior.session_id) {
        this.db.prepare('INSERT INTO session_messages(session_id,task_id,role,content,created_ms) VALUES (?,?,?,?,?)')
          .run(prior.session_id, id, 'assistant', content, now);
        this.db.prepare('UPDATE sessions SET updated_ms=? WHERE id=?').run(now, prior.session_id);
      }
    })();
  }
  latestSessionTask(sessionId: string, caller: string): Task | undefined {
    const row = this.db.prepare('SELECT t.* FROM tasks t JOIN sessions s ON s.id=t.session_id WHERE t.session_id=? AND s.caller=? ORDER BY t.created_ms DESC LIMIT 1').get(sessionId, caller);
    return row ? TaskSchema.parse(row) : undefined;
  }
  hasInbound(platform: string, account: string, updateId: string): boolean {
    return this.db.prepare('SELECT 1 FROM channel_inbound WHERE platform=? AND account=? AND update_id=?')
      .get(platform, account, updateId) !== undefined;
  }
  claimInbound(platform: string, account: string, updateId: string,
    channelType: 'unknown' | 'telegram_private' | 'telegram_group' | 'telegram_supergroup' |
      'mattermost_dm' | 'mattermost_channel' = 'unknown'): { claimed: boolean; taskId: string | null } {
    if (!platform || !account || !updateId || updateId.length > 256) throw new Error('Invalid channel update identity');
    if ((platform === 'telegram' && channelType.startsWith('mattermost_')) ||
        (platform === 'mattermost' && channelType.startsWith('telegram_')) ||
        !['unknown', 'telegram_private', 'telegram_group', 'telegram_supergroup',
          'mattermost_dm', 'mattermost_channel'].includes(channelType))
      throw new Error('Inbound channel type differs from platform');
    return this.db.transaction(() => {
      if (this.admissionFence()) throw new Error('Profile admission is fenced for rollback');
      const row = this.db.prepare('SELECT task_id,channel_type FROM channel_inbound WHERE platform=? AND account=? AND update_id=?').get(platform, account, updateId);
      if (row) {
        const prior = z.object({ task_id: z.string().nullable(), channel_type: z.string() }).parse(row);
        if (prior.channel_type !== 'unknown' && channelType !== 'unknown' &&
            prior.channel_type !== channelType) throw new Error('Inbound channel type changed');
        return { claimed: false, taskId: prior.task_id };
      }
      this.db.prepare(`INSERT INTO channel_inbound
        (platform,account,update_id,task_id,created_ms,channel_type) VALUES (?,?,?,?,?,?)`)
        .run(platform, account, updateId, null, Date.now(), channelType);
      return { claimed: true, taskId: null };
    })();
  }
  bindInboundTask(platform: string, account: string, updateId: string, taskId: string): void {
    this.db.prepare('UPDATE channel_inbound SET task_id=? WHERE platform=? AND account=? AND update_id=? AND task_id IS NULL').run(taskId, platform, account, updateId);
  }
  cursor(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM channel_cursors WHERE key=?').get(key);
    return row ? z.object({ value: z.string() }).parse(row).value : undefined;
  }
  setCursor(key: string, value: string): void {
    this.db.prepare('INSERT INTO channel_cursors(key,value,updated_ms) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_ms=excluded.updated_ms').run(key, value, Date.now());
  }
  channelBackend(caller: string, sessionKey: string): 'llamacpp' | 'codex' | undefined {
    const row = this.db.prepare('SELECT backend FROM channel_preferences WHERE caller=? AND session_key=?').get(caller, sessionKey);
    return row ? z.object({ backend: z.enum(['llamacpp', 'codex']) }).parse(row).backend : undefined;
  }
  setChannelBackend(caller: string, sessionKey: string, backend: 'llamacpp' | 'codex'): void {
    this.db.prepare('INSERT INTO channel_preferences(caller,session_key,backend,updated_ms) VALUES (?,?,?,?) ON CONFLICT(caller,session_key) DO UPDATE SET backend=excluded.backend,updated_ms=excluded.updated_ms').run(caller, sessionKey, backend, Date.now());
  }
  delivery(platform: string, account: string, updateId: string): { id: string; state: 'queued' | 'sent' | 'failed' | 'unknown'; taskId: string | null; externalId: string | null } | undefined {
    const row = this.db.prepare('SELECT id,state,task_id,external_id FROM channel_deliveries WHERE platform=? AND account=? AND update_id=?').get(platform, account, updateId);
    return row ? z.object({ id: z.string(), state: z.enum(['queued', 'sent', 'failed', 'unknown']), task_id: z.string().nullable(), external_id: z.string().nullable() }).transform(value => ({ id: value.id, state: value.state, taskId: value.task_id, externalId: value.external_id })).parse(row) : undefined;
  }
  queueDelivery(platform: string, account: string, updateId: string, taskId: string | null): string {
    const id = randomUUID();
    this.db.prepare('INSERT OR IGNORE INTO channel_deliveries(id,platform,account,update_id,task_id,state,external_id,error,created_ms,updated_ms) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, platform, account, updateId, taskId, 'queued', null, null, Date.now(), Date.now());
    return this.delivery(platform, account, updateId)?.id ?? id;
  }
  setDelivery(id: string, state: 'sent' | 'failed' | 'unknown', externalId: string | null = null, error: string | null = null): void {
    this.db.prepare('UPDATE channel_deliveries SET state=?,external_id=?,error=?,updated_ms=? WHERE id=?').run(state, externalId, error, Date.now(), id);
  }
  get(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    return row ? TaskSchema.parse(row) : undefined;
  }
  list(limit = 50): Task[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_ms DESC LIMIT ?').all(Math.max(1, Math.min(limit, 100))).map(row => TaskSchema.parse(row));
  }
  listByCaller(caller: string, limit = 50): Task[] {
    return this.db.prepare('SELECT * FROM tasks WHERE caller=? ORDER BY created_ms DESC LIMIT ?').all(caller, Math.max(1, Math.min(limit, 100))).map(row => TaskSchema.parse(row));
  }
  setState(id: string, state: TaskState, result: string | null = null, error: string | null = null): void {
    const prior = this.get(id);
    if (!prior) throw new Error('Task not found');
    const terminal = ['completed', 'partial', 'failed', 'cancelled', 'unknown'];
    if (terminal.includes(prior.state)) throw new Error('Terminal task cannot transition');
    this.db.transaction(() => {
      this.db.prepare('UPDATE tasks SET state=?,result=?,error=?,updated_ms=? WHERE id=?').run(state, result, error, Date.now(), id);
      this.append(id, 'state', { from: prior.state, to: state, error });
    })();
  }
  startQueued(id: string): void {
    this.db.transaction(() => {
      if (this.admissionFence()) throw new Error('Profile admission is fenced for rollback');
      const task = this.get(id);
      if (!task || task.state !== 'queued') throw new Error('Task is no longer queued');
      this.db.prepare('UPDATE tasks SET state=?,updated_ms=? WHERE id=?').run('running', Date.now(), id);
      this.append(id, 'state', { from: 'queued', to: 'running', error: null });
    })();
  }
  append(id: string, kind: string, detail: unknown): void {
    this.db.prepare('INSERT INTO events(task_id,kind,detail_json,created_ms) VALUES (?,?,?,?)').run(id, kind, JSON.stringify(detail), Date.now());
  }
  events(id: string, after = 0, limit = 100): TaskEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id, after, Math.max(1, Math.min(limit, 500)));
    return rows.map(row => {
      const value = z.object({ sequence: z.number(), task_id: z.string(), kind: z.string(), detail_json: z.string(), created_ms: z.number() }).parse(row);
      return EventSchema.parse({ sequence: value.sequence, task_id: value.task_id, kind: value.kind, detail: JSON.parse(value.detail_json) as unknown, created_ms: value.created_ms });
    });
  }
  recover(): { queued: Task[]; interrupted: number } {
    const running = this.db.prepare("SELECT id FROM tasks WHERE state='running'").all().map(row => z.object({ id: z.string() }).parse(row));
    this.db.transaction(() => {
      for (const row of running) this.setState(row.id, 'unknown', null, 'Interrupted during execution; provider/tool effect may be unresolved');
      this.db.prepare("UPDATE channel_deliveries SET state='unknown',error='Process stopped during a queued delivery; send outcome is uncertain',updated_ms=? WHERE state='queued'").run(Date.now());
    })();
    return { queued: this.db.prepare("SELECT * FROM tasks WHERE state='queued' ORDER BY created_ms").all().map(row => TaskSchema.parse(row)), interrupted: running.length };
  }
}
