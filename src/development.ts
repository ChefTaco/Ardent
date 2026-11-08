import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { TaskStore } from './store.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** A short machine-readable category, such as `self_understanding`, `method`, `lesson` or `skill_change`. */
export const DevelopmentKind = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const DevelopmentSource = z.object({ kind: z.enum(['task', 'artifact', 'memory', 'url', 'identity', 'skill', 'note']), ref: z.string().trim().min(1).max(512) }).strict();
/**
 * Portable record of how an agent developed: its own notes, operator notes and
 * observed changes. `epistemic` says how much the record can be trusted.
 */
export const DevelopmentRecordSchema = z.object({
  id: z.string().regex(/^dev_[A-Za-z0-9_-]{1,120}$/), agent_ref: z.string(), kind: DevelopmentKind,
  title: z.string(), body: z.string(), author: z.enum(['agent', 'operator', 'runtime']),
  epistemic: z.enum(['agent_reported', 'operator_reported', 'observed']),
  before_sha256: digest.nullable(), after_sha256: digest.nullable(), sources: z.array(DevelopmentSource).max(16), created_at: z.string()
}).strict();
export type DevelopmentRecord = z.infer<typeof DevelopmentRecordSchema>;
/** A note written by the agent (`development_note`) or the operator. */
export const DevelopmentNoteInput = z.object({ kind: DevelopmentKind, title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000), sources: z.array(DevelopmentSource).max(16).optional() }).strict();
export type DevelopmentNoteInput = z.infer<typeof DevelopmentNoteInput>;

const Row = z.object({ id: z.string(), kind: z.string(), title: z.string(), body: z.string(), author: z.string(), epistemic: z.string(),
  before_sha256: z.string().nullable(), after_sha256: z.string().nullable(), sources_json: z.string(), created_ms: z.number().int() });

/** Append-only development records owned by the agent profile. */
export class DevelopmentRecords {
  constructor(readonly store: TaskStore, readonly agentRef: string) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS development_records (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL,
      epistemic TEXT NOT NULL, before_sha256 TEXT, after_sha256 TEXT, sources_json TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(id), created_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS development_records_created ON development_records(created_ms, id);
      CREATE TRIGGER IF NOT EXISTS development_records_immutable_update BEFORE UPDATE ON development_records
        BEGIN SELECT RAISE(ABORT, 'Development records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS development_records_immutable_delete BEFORE DELETE ON development_records
        BEGIN SELECT RAISE(ABORT, 'Development records are immutable'); END;`);
  }

  /** Record a note or an observed change. A task-bound record is also journaled on the task. */
  add(input: DevelopmentNoteInput & { author: DevelopmentRecord['author']; epistemic: DevelopmentRecord['epistemic'];
    taskId?: string | undefined; before_sha256?: string | null; after_sha256?: string | null }): DevelopmentRecord {
    const note = DevelopmentNoteInput.parse({ kind: input.kind, title: input.title, body: input.body, ...(input.sources ? { sources: input.sources } : {}) });
    const sources = [...(input.taskId ? [{ kind: 'task' as const, ref: input.taskId }] : []), ...(note.sources ?? [])]
      .filter((source, index, all) => all.findIndex(other => other.kind === source.kind && other.ref === source.ref) === index).slice(0, 16);
    const created = Date.now();
    const id = `dev_${created.toString(36).padStart(9, '0')}${randomBytes(10).toString('hex')}`;
    const record = DevelopmentRecordSchema.parse({ id, agent_ref: this.agentRef, kind: note.kind, title: note.title, body: note.body,
      author: input.author, epistemic: input.epistemic, before_sha256: input.before_sha256 ?? null, after_sha256: input.after_sha256 ?? null,
      sources, created_at: new Date(created).toISOString() });
    this.store.db.transaction(() => {
      this.store.db.prepare(`INSERT INTO development_records(id,kind,title,body,author,epistemic,before_sha256,after_sha256,sources_json,task_id,created_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, record.kind, record.title, record.body, record.author, record.epistemic,
        record.before_sha256, record.after_sha256, JSON.stringify(record.sources), input.taskId ?? null, created);
      if (input.taskId) this.store.append(input.taskId, 'development_note', { id, kind: record.kind, title: record.title });
    })();
    return record;
  }

  /** Stored records in creation order. */
  list(options: { afterMs?: number; limit?: number } = {}): Array<DevelopmentRecord & { created_ms: number }> {
    return this.store.db.prepare('SELECT * FROM development_records WHERE created_ms>=? ORDER BY created_ms, id LIMIT ?')
      .all(options.afterMs ?? 0, Math.max(1, Math.min(options.limit ?? 100, 10_000))).map(raw => {
        const row = Row.parse(raw);
        return { ...DevelopmentRecordSchema.parse({ id: row.id, agent_ref: this.agentRef, kind: row.kind, title: row.title, body: row.body,
          author: row.author, epistemic: row.epistemic, before_sha256: row.before_sha256, after_sha256: row.after_sha256,
          sources: JSON.parse(row.sources_json) as unknown, created_at: new Date(row.created_ms).toISOString() }), created_ms: row.created_ms };
      });
  }
}
