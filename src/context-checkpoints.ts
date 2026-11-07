import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CheckpointSchema, checkpointDigest, type Checkpoint } from '@hivemagnus/emberfold';
import { LegacyCheckpointManager, legacySourceDigest as sourceDigest,
  type CheckpointStorage, type ContextTask, type LegacyMessage, type LegacyExchange,
  type LegacyCheckpoint, type CompactionCall } from '@hivemagnus/emberfold/compat';
import type { TaskStore } from './store.js';
import { parseModelPolicy } from './model-policy.js';
export { SummarySchema, tokenEstimate } from '@hivemagnus/emberfold/compat';
export type { ContextSummary, CompactionCall } from '@hivemagnus/emberfold/compat';
const MessageRow = z.object({ sequence: z.number().int().positive(), session_id: z.string(), task_id: z.string(),
  role: z.enum(['user', 'assistant']), content: z.string(), created_ms: z.number().int(), state: z.string().optional() });

class ArdentCheckpointStorage implements CheckpointStorage {
  constructor(readonly store: TaskStore, readonly policyPath?: string) {
    store.db.exec('CREATE TABLE IF NOT EXISTS emberfold_checkpoint_metadata (checkpoint_id TEXT PRIMARY KEY REFERENCES context_checkpoints(id), metadata_json TEXT NOT NULL)');
  }
  session(task: ContextTask): { id: string; caller: string; context: string } {
    if (!task.session_id) throw new Error('Task has no session');
    const row = this.store.db.prepare('SELECT id,caller,context FROM sessions WHERE id=?').get(task.session_id);
    const session = z.object({ id: z.string(), caller: z.string(), context: z.string() }).parse(row);
    if (session.caller !== task.caller || session.context !== task.context) throw new Error('Session caller or context mismatch');
    return session;
  }

  rows(sessionId: string, watermark = Number.MAX_SAFE_INTEGER): LegacyMessage[] {
    return this.store.db.prepare('SELECT sequence,session_id,task_id,role,content,created_ms FROM session_messages WHERE session_id=? AND sequence<=? ORDER BY sequence')
      .all(sessionId, watermark).map(row => MessageRow.parse(row));
  }

  exchanges(task: ContextTask): LegacyExchange[] {
    const session = this.session(task);
    const current = this.store.db.prepare("SELECT sequence FROM session_messages WHERE task_id=? AND session_id=? AND role='user'").get(task.id, session.id);
    const currentSequence = task.id.startsWith('preview:') ? Number.MAX_SAFE_INTEGER
      : z.object({ sequence: z.number().int().positive() }).parse(current).sequence;
    const rows = this.store.db.prepare(`SELECT m.sequence,m.session_id,m.task_id,m.role,m.content,m.created_ms,t.state
      FROM session_messages m JOIN tasks t ON t.id=m.task_id
      WHERE m.session_id=? AND m.task_id IN
        (SELECT task_id FROM session_messages WHERE session_id=? AND role='user' AND sequence<?)
      ORDER BY m.sequence`).all(session.id, session.id, currentSequence).map(row => MessageRow.parse(row));
    const grouped = new Map<string, LegacyMessage[]>();
    for (const row of rows) grouped.set(row.task_id, [...(grouped.get(row.task_id) ?? []), row]);
    return [...grouped.values()].flatMap(group => {
      if (!['completed', 'partial'].includes(group[0]?.state ?? '') || group.length !== 2) return [];
      const user = group.find(row => row.role === 'user');
      const assistant = group.find(row => row.role === 'assistant');
      return user && assistant && user.sequence < assistant.sequence ? [{ user, assistant }] : [];
    }).sort((a, b) => a.user.sequence - b.user.sequence);
  }


  head(sessionId: string): { rawId: string | null; row: unknown; metadata?: unknown } {
    const pointer = this.store.db.prepare('SELECT checkpoint_id FROM context_checkpoint_heads WHERE session_id=?').get(sessionId);
    if (!pointer) return { rawId: null, row: null };
    const rawId = z.object({ checkpoint_id: z.string() }).parse(pointer).checkpoint_id;
    const row = this.store.db.prepare('SELECT * FROM context_checkpoints WHERE id=?').get(rawId);
    const metadataRow = this.store.db.prepare('SELECT metadata_json FROM emberfold_checkpoint_metadata WHERE checkpoint_id=?').get(rawId);
    if (!metadataRow) return { rawId, row };
    try { return { rawId, row, metadata: JSON.parse(z.object({ metadata_json: z.string() }).parse(metadataRow).metadata_json) as unknown }; }
    catch { return { rawId, row, metadata: null }; }
  }
  lastAttempt(sessionId: string): unknown {
    return this.store.db.prepare('SELECT outcome,reason,created_ms,model,policy_revision,source_watermark FROM context_compaction_attempts WHERE session_id=? ORDER BY created_ms DESC LIMIT 1').get(sessionId);
  }
  record(sessionId: string, headId: string | null, policyRevision: number, model: string | null,
    outcome: string, reason: string | null, watermark: number | null): void {
    this.store.db.transaction(() => {
      this.store.db.prepare(`INSERT INTO context_compaction_attempts
        (id,session_id,source_watermark,parent_id,policy_revision,model,outcome,reason,created_ms) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), sessionId, watermark, headId, policyRevision, model, outcome, reason?.slice(0, 500) ?? null, Date.now());
      this.store.db.prepare(`DELETE FROM context_compaction_attempts WHERE session_id=? AND id NOT IN
        (SELECT id FROM context_compaction_attempts WHERE session_id=? ORDER BY created_ms DESC,id DESC LIMIT 100)`)
        .run(sessionId, sessionId);
    })();
  }


  publish(checkpoint: LegacyCheckpoint, expectedHead: string | null, signal: AbortSignal, metadata: Checkpoint): void {
        this.store.db.transaction(() => {
          if (signal.aborted) throw new Error('Compaction cancelled before publication');
          if (!this.policyPath) throw new Error('Model policy publication pin is unavailable');
          const currentPolicy = parseModelPolicy(readFileSync(this.policyPath, 'utf8'));
          if (currentPolicy.sha256 !== checkpoint.policy_sha256 || currentPolicy.policy.revision !== checkpoint.policy_revision)
            throw new Error('Model policy changed during compaction');
          const current = this.store.db.prepare('SELECT checkpoint_id FROM context_checkpoint_heads WHERE session_id=?').get(checkpoint.session_id);
          const currentId = current ? z.object({ checkpoint_id: z.string() }).parse(current).checkpoint_id : null;
          if (currentId !== expectedHead) throw new Error('Checkpoint head changed during compaction');
          if (sourceDigest(this.rows(checkpoint.session_id, checkpoint.source_watermark)) !== checkpoint.source_sha256) throw new Error('Source messages changed during compaction');
          this.store.db.prepare(`INSERT INTO context_checkpoints VALUES
            (@id,@session_id,@caller,@context,@parent_id,@source_watermark,@source_sha256,@summary_json,@summary_sha256,
             @model,@reasoning_effort,@policy_revision,@policy_sha256,@source_tokens,@summary_tokens,@created_ms,@validation)`).run(checkpoint);
          const previous = checkpoint.parent_id ? this.store.db.prepare('SELECT metadata_json FROM emberfold_checkpoint_metadata WHERE checkpoint_id=?').get(checkpoint.parent_id) : undefined;
          const parent = previous ? z.object({ metadata_json: z.string() }).parse(previous) : null;
          const generation = parent ? CheckpointSchema.parse(JSON.parse(parent.metadata_json) as unknown).generation + 1 : 1;
          const envelope = { ...metadata, generation };
          envelope.checkpoint_sha256 = checkpointDigest(envelope);
          this.store.db.prepare('INSERT INTO emberfold_checkpoint_metadata(checkpoint_id,metadata_json) VALUES (?,?)').run(checkpoint.id, JSON.stringify(envelope));
          this.store.db.prepare(`INSERT INTO context_checkpoint_heads(session_id,checkpoint_id) VALUES (?,?)
            ON CONFLICT(session_id) DO UPDATE SET checkpoint_id=excluded.checkpoint_id`).run(checkpoint.session_id, checkpoint.id);
        })();
  }
}
export class ContextCheckpoints extends LegacyCheckpointManager {
  constructor(readonly store: TaskStore, compactor: CompactionCall) { super(new ArdentCheckpointStorage(store), compactor); }
  override prepare(...args: Parameters<LegacyCheckpointManager['prepare']>): ReturnType<LegacyCheckpointManager['prepare']> {
    const { path } = z.object({ path: z.string().min(1) }).parse(args[3]);
    return new LegacyCheckpointManager(new ArdentCheckpointStorage(this.store, path), this.compactor).prepare(...args);
  }
}
