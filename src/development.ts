import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ArdentConfig } from './config.js';
import { identityHistory, readIdentity } from './identity.js';
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

  /** Stored records after a cursor, in creation order. */
  list(options: { after?: DevelopmentCursor | undefined; limit?: number; kind?: string | undefined } = {}): Array<DevelopmentRecord & { created_ms: number }> {
    const after = options.after ?? { ms: -1, id: '' };
    return this.store.db.prepare(`SELECT * FROM development_records WHERE (created_ms>? OR (created_ms=? AND id>?)) AND (? IS NULL OR kind=?)
      ORDER BY created_ms, id LIMIT ?`).all(after.ms, after.ms, after.id, options.kind ?? null, options.kind ?? null,
      Math.max(1, Math.min(options.limit ?? 100, 1000))).map(raw => {
      const row = Row.parse(raw);
      return { ...DevelopmentRecordSchema.parse({ id: row.id, agent_ref: this.agentRef, kind: row.kind, title: row.title, body: row.body,
        author: row.author, epistemic: row.epistemic, before_sha256: row.before_sha256, after_sha256: row.after_sha256,
        sources: JSON.parse(row.sources_json) as unknown, created_at: new Date(row.created_ms).toISOString() }), created_ms: row.created_ms };
    });
  }
}

/** Position in the merged development history: the creation time and id of the last record seen. */
export type DevelopmentCursor = { ms: number; id: string };
export function encodeDevelopmentCursor(cursor: DevelopmentCursor): string {
  return Buffer.from(JSON.stringify([cursor.ms, cursor.id])).toString('base64url');
}
export function decodeDevelopmentCursor(value: string): DevelopmentCursor {
  try {
    const [ms, id] = z.tuple([z.number().int().min(0), z.string().max(160)]).parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown);
    return { ms, id };
  } catch { throw new Error('Invalid development cursor'); }
}

type Dated = DevelopmentRecord & { created_ms: number };
const historyName = /^(\d+)-([a-f0-9]{12})-([a-f0-9]{64})\.md$/;

/** Identity edits from the retained identity history (the newest 20 per file). */
async function identityChanges(profileDir: string, config: ArdentConfig, agentRef: string): Promise<Dated[]> {
  const records: Dated[] = [];
  for (const kind of ['soul', 'identity'] as const) {
    const names = (await identityHistory(profileDir, kind)).map(item => item.name).reverse();
    let current: string | null = null;
    try { current = (await readIdentity(profileDir, config, kind)).revision; } catch { /* A missing file has no current revision. */ }
    names.forEach((name, index) => {
      const match = historyName.exec(name);
      if (!match) return;
      const ms = Number(match[1]);
      const after = index + 1 < names.length ? historyName.exec(names[index + 1] ?? '')?.[3] ?? null : current;
      const label = kind === 'soul' ? 'Soul' : 'Identity';
      records.push({ ...DevelopmentRecordSchema.parse({ id: `dev_identity_${kind}_${match[1]}_${match[2]}`, agent_ref: agentRef, kind: 'identity_change',
        title: `${label} updated`, body: `The ${kind} file (${kind === 'soul' ? config.identity.soul_file : config.identity.identity_file}) was replaced.`,
        author: 'runtime', epistemic: 'observed', before_sha256: match[3], after_sha256: after,
        sources: [{ kind: 'identity', ref: `${kind}:${name}` }], created_at: new Date(ms).toISOString() }), created_ms: ms });
    });
  }
  return records;
}

/** Research method reflections the runtime journaled for finished tasks. */
function methodReflections(store: TaskStore, agentRef: string, after: DevelopmentCursor, limit: number): Dated[] {
  const rows = z.array(z.object({ sequence: z.number().int(), task_id: z.string(), detail_json: z.string(), created_ms: z.number().int() }))
    .parse(store.db.prepare(`SELECT sequence,task_id,detail_json,created_ms FROM events WHERE kind='method_reflection'
      AND (created_ms>? OR (created_ms=? AND printf('dev_reflection_%012d', sequence)>?)) ORDER BY created_ms, sequence LIMIT ?`)
      .all(after.ms, after.ms, after.id, limit));
  return rows.flatMap(row => {
    const detail = z.object({ category: z.string(), observation: z.string() }).passthrough().safeParse(JSON.parse(row.detail_json) as unknown);
    if (!detail.success) return [];
    return [{ ...DevelopmentRecordSchema.parse({ id: `dev_reflection_${String(row.sequence).padStart(12, '0')}`, agent_ref: agentRef, kind: 'method_reflection',
      title: `Method reflection: ${detail.data.category.replaceAll('_', ' ')}`.slice(0, 200), body: detail.data.observation.slice(0, 8000),
      author: 'runtime', epistemic: 'observed', before_sha256: null, after_sha256: null,
      sources: [{ kind: 'task', ref: row.task_id }], created_at: new Date(row.created_ms).toISOString() }), created_ms: row.created_ms }];
  });
}

/**
 * One page of the agent's development history in the portable record shape:
 * stored notes and skill changes, identity edits, and method reflections,
 * merged in creation order.
 */
export async function developmentPage(input: { records: DevelopmentRecords; profileDir: string; config: ArdentConfig },
  query: { after?: string | undefined; limit?: number | undefined; kind?: string | undefined } = {}): Promise<{ records: DevelopmentRecord[]; next: string | null }> {
  const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
  const after = query.after ? decodeDevelopmentCursor(query.after) : { ms: -1, id: '' };
  const kind = query.kind === undefined ? undefined : DevelopmentKind.parse(query.kind);
  const store = input.records.store;
  const agentRef = input.records.agentRef;
  const later = (record: Dated) => record.created_ms > after.ms || (record.created_ms === after.ms && record.id > after.id);
  const merged = [
    ...input.records.list({ after, limit: limit + 1, kind }),
    ...(kind === undefined || kind === 'method_reflection' ? methodReflections(store, agentRef, after, limit + 1) : []),
    ...(kind === undefined || kind === 'identity_change' ? (await identityChanges(input.profileDir, input.config, agentRef)).filter(later) : [])
  ].sort((a, b) => a.created_ms - b.created_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const page = merged.slice(0, limit);
  const last = page.at(-1);
  return { records: page.map(({ created_ms: _created, ...record }) => record),
    next: merged.length > limit && last ? encodeDevelopmentCursor({ ms: last.created_ms, id: last.id }) : null };
}

/** Record an operator's skill selection change, with the configuration revisions before and after it. */
export function recordSkillChange(records: DevelopmentRecords, name: string, enabled: boolean, before: string, after: string): DevelopmentRecord {
  return records.add({ kind: 'skill_change', title: `Skill ${name} ${enabled ? 'enabled' : 'disabled'}`.slice(0, 200),
    body: `The operator ${enabled ? 'enabled' : 'disabled'} the ${name} skill. It applies after the profile restarts.`,
    sources: [{ kind: 'skill', ref: name }], author: 'operator', epistemic: 'observed', before_sha256: before, after_sha256: after });
}
