import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ChatMessageSchema } from '@hivemagnus/emberfold';
import type Database from './sqlite.js';
import type { ChatMessage } from './llamacpp.js';
import { ToolResultSchema, type ToolResult } from './tools.js';

/**
 * Execution checkpoints: what a running task needs to continue after a crash
 * or restart, written at fixed boundaries in the same SQLite transaction as the
 * journal event they belong to.
 *
 * - `execution_state`: the exact model transcript (llama.cpp) or thread
 *   identifiers (Codex) after the last completed boundary, with the task's
 *   evidence and tool-call count.
 * - `tool_invocations`: one row per tool call, `dispatched` before invocation
 *   and settled with its result after. A `dispatched` row whose effect is not
 *   `read` is an unknown effect: it needs reconciliation, never a retry.
 * - `task_recovery`: the recovery status the planner and operators set.
 *
 * Execution checkpoints are separate from context checkpoints
 * (`context_checkpoints`); neither reads the other. Tools, mission scope,
 * memory grants, caller and ownership are never taken from a checkpoint: they
 * are re-derived from their owning stores when a task resumes.
 */
export const InvocationState = z.enum(['dispatched', 'succeeded', 'failed_no_effect', 'failed_unknown', 'reconciled_applied',
  'reconciled_not_applied', 'operator_applied', 'operator_not_applied', 'not_dispatched']);
export type InvocationState = z.infer<typeof InvocationState>;
export const RecoveryStatus = z.enum(['ready', 'reconciling', 'resumed', 'awaiting_decision', 'unsupported', 'resolved']);
export type RecoveryStatus = z.infer<typeof RecoveryStatus>;
export const RecoveryAction = z.enum(['mark_applied', 'mark_not_applied', 'retry_with_new_deadline', 'abandon']);
export type RecoveryAction = z.infer<typeof RecoveryAction>;
export const RecoveryReason = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/), message: z.string().max(1000) });
export type RecoveryReason = z.infer<typeof RecoveryReason>;
export const PendingCall = z.object({ call_id: z.string(), tool: z.string(), effect: z.string(), dispatched_at: z.string().nullable(), reconcilable: z.boolean() });
export type PendingCall = z.infer<typeof PendingCall>;
export const RecoveryCheckpoint = z.object({ step: z.number().int(), completed_calls: z.number().int().min(0), pending_calls: z.array(PendingCall) });
export type RecoveryCheckpoint = z.infer<typeof RecoveryCheckpoint>;
export const RecoveryDecision = z.object({ action: RecoveryAction, by: z.string().max(128), at: z.string(), note: z.string().max(2000).optional() });
export type RecoveryDecision = z.infer<typeof RecoveryDecision>;

/** States that settle a call: its outcome is recorded and is reused, never re-dispatched. */
export const SETTLED_STATES: ReadonlySet<InvocationState> = new Set(['succeeded', 'failed_no_effect', 'failed_unknown', 'reconciled_applied',
  'reconciled_not_applied', 'operator_applied', 'operator_not_applied']);
/** Settled states that prove the call had no effect. */
export const NO_EFFECT_STATES: ReadonlySet<InvocationState> = new Set(['failed_no_effect', 'reconciled_not_applied', 'operator_not_applied', 'not_dispatched']);

const SourceEvidence = z.object({ url: z.string(), extracted: z.boolean(), title: z.string(), published_at: z.string().nullable(),
  retrieved_at: z.string().nullable(), content_sha256: z.string().nullable() });
const EvidenceJson = z.object({ source_ids: z.array(z.string()), sources: z.array(z.tuple([z.string(), SourceEvidence])),
  artifact_ids: z.array(z.string()), research_attempted: z.boolean() });
export type EvidenceSnapshot = { sourceIds: Set<string>; sources: Map<string, z.infer<typeof SourceEvidence>>; artifactIds: Set<string>; researchAttempted: boolean };
export const CodexThreadState = z.object({ thread_id: z.string().min(1).max(256), durable: z.boolean(),
  turns: z.array(z.object({ id: z.string().min(1).max(256), started_ms: z.number().int() })).max(256) });
export type CodexThreadState = z.infer<typeof CodexThreadState>;

export type ExecutionState = {
  task_id: string; attempt: number; step: number; backend: 'llamacpp' | 'codex';
  messages: ChatMessage[]; evidence: EvidenceSnapshot; tool_count: number; codex: CodexThreadState | null; updated_ms: number;
};
export type ToolInvocation = {
  task_id: string; call_id: string; attempt: number; step: number | null; name: string; effect: string; args_sha256: string;
  args: unknown; idempotency_key: string; state: InvocationState; result: ToolResult | null; dispatched_ms: number | null; settled_ms: number | null;
};
export type TaskRecoveryRow = {
  task_id: string; status: RecoveryStatus; reason: RecoveryReason; attempt: number; checkpoint: RecoveryCheckpoint | null;
  continuation_task_id: string | null; decided: RecoveryDecision | null; updated_ms: number;
};

const StateRow = z.object({ task_id: z.string(), attempt: z.number().int(), step: z.number().int(), backend: z.enum(['llamacpp', 'codex']),
  messages_json: z.string(), evidence_json: z.string(), tool_count: z.number().int(), codex_json: z.string().nullable(), sha256: z.string(), updated_ms: z.number().int() });
const InvocationRow = z.object({ task_id: z.string(), call_id: z.string(), attempt: z.number().int(), step: z.number().int().nullable(), name: z.string(),
  effect: z.string(), args_sha256: z.string(), args_json: z.string(), idempotency_key: z.string(), state: InvocationState, result_json: z.string().nullable(),
  dispatched_ms: z.number().int().nullable(), settled_ms: z.number().int().nullable() });
const RecoveryRow = z.object({ task_id: z.string(), status: RecoveryStatus, reason_json: z.string(), attempt: z.number().int(), checkpoint_json: z.string().nullable(),
  continuation_task_id: z.string().nullable(), decided_json: z.string().nullable(), updated_ms: z.number().int() });

/** The digest of a call's full (uncompacted) arguments, to prove a re-dispatch sends exactly what was dispatched. */
export function argumentsDigest(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args ?? null)).digest('hex');
}
/** The invocation state a recorded tool result settles a call in. */
export function settledState(result: ToolResult): InvocationState {
  return result.ok ? 'succeeded' : result.effect === 'none' ? 'failed_no_effect' : 'failed_unknown';
}
function evidenceJson(evidence: EvidenceSnapshot): string {
  return JSON.stringify({ source_ids: [...evidence.sourceIds], sources: [...evidence.sources], artifact_ids: [...evidence.artifactIds], research_attempted: evidence.researchAttempted });
}
function stateDigest(messagesJson: string, evidence: string, codex: string | null, toolCount: number, step: number): string {
  return createHash('sha256').update(JSON.stringify([messagesJson, evidence, codex, toolCount, step])).digest('hex');
}

/** A stored checkpoint that does not match its digest or schema. It is never used. */
export class InvalidCheckpointError extends Error {}

export class ExecutionStates {
  constructor(readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS execution_state (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id), attempt INTEGER NOT NULL, step INTEGER NOT NULL,
      backend TEXT NOT NULL, messages_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
      tool_count INTEGER NOT NULL, codex_json TEXT, sha256 TEXT NOT NULL, updated_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_invocations (
        task_id TEXT NOT NULL REFERENCES tasks(id), call_id TEXT NOT NULL, attempt INTEGER NOT NULL,
        step INTEGER, name TEXT NOT NULL, effect TEXT NOT NULL, args_sha256 TEXT NOT NULL, args_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('dispatched','succeeded','failed_no_effect',
          'failed_unknown','reconciled_applied','reconciled_not_applied','operator_applied','operator_not_applied','not_dispatched')),
        result_json TEXT, dispatched_ms INTEGER, settled_ms INTEGER, PRIMARY KEY(task_id, call_id));
      CREATE TABLE IF NOT EXISTS task_recovery (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id), status TEXT NOT NULL, reason_json TEXT NOT NULL,
        attempt INTEGER NOT NULL, checkpoint_json TEXT, continuation_task_id TEXT, decided_json TEXT, updated_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS task_recovery_status ON task_recovery(status);`);
  }

  /** The task's checkpoint; throws `InvalidCheckpointError` when it fails its digest or schema. */
  get(taskId: string): ExecutionState | undefined {
    const raw = this.db.prepare('SELECT * FROM execution_state WHERE task_id=?').get(taskId);
    if (!raw) return undefined;
    const row = StateRow.parse(raw);
    if (stateDigest(row.messages_json, row.evidence_json, row.codex_json, row.tool_count, row.step) !== row.sha256)
      throw new InvalidCheckpointError('Execution checkpoint does not match its digest');
    try {
      const messages: ChatMessage[] = z.array(ChatMessageSchema).parse(JSON.parse(row.messages_json) as unknown);
      const evidence = EvidenceJson.parse(JSON.parse(row.evidence_json) as unknown);
      const codex = row.codex_json === null ? null : CodexThreadState.parse(JSON.parse(row.codex_json) as unknown);
      return { task_id: row.task_id, attempt: row.attempt, step: row.step, backend: row.backend, messages, tool_count: row.tool_count, codex,
        evidence: { sourceIds: new Set(evidence.source_ids), sources: new Map(evidence.sources), artifactIds: new Set(evidence.artifact_ids), researchAttempted: evidence.research_attempted },
        updated_ms: row.updated_ms };
    } catch { throw new InvalidCheckpointError('Execution checkpoint is malformed'); }
  }
  /** Whether a task has a checkpoint row, valid or not. */
  has(taskId: string): boolean { return this.db.prepare('SELECT 1 FROM execution_state WHERE task_id=?').get(taskId) !== undefined; }

  /** Upsert the checkpoint. Call inside the boundary transaction. `codex` keeps the stored value when undefined. */
  upsert(taskId: string, value: { attempt: number; step: number; backend: 'llamacpp' | 'codex'; messages: readonly ChatMessage[];
    evidence: EvidenceSnapshot; toolCount: number; codex?: CodexThreadState | null }): void {
    const messagesJson = JSON.stringify(value.messages);
    const evidence = evidenceJson(value.evidence);
    const codex = value.codex === undefined ? this.#codexJson(taskId) : value.codex === null ? null : JSON.stringify(CodexThreadState.parse(value.codex));
    this.db.prepare(`INSERT INTO execution_state(task_id,attempt,step,backend,messages_json,evidence_json,tool_count,codex_json,sha256,updated_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET attempt=excluded.attempt,step=excluded.step,backend=excluded.backend,
      messages_json=excluded.messages_json,evidence_json=excluded.evidence_json,tool_count=excluded.tool_count,codex_json=excluded.codex_json,
      sha256=excluded.sha256,updated_ms=excluded.updated_ms`)
      .run(taskId, value.attempt, value.step, value.backend, messagesJson, evidence, value.toolCount, codex,
        stateDigest(messagesJson, evidence, codex, value.toolCount, value.step), Date.now());
  }
  #codexJson(taskId: string): string | null {
    const row = this.db.prepare('SELECT codex_json FROM execution_state WHERE task_id=?').get(taskId);
    return row ? z.object({ codex_json: z.string().nullable() }).parse(row).codex_json : null;
  }

  invocations(taskId: string): ToolInvocation[] {
    return this.db.prepare('SELECT * FROM tool_invocations WHERE task_id=? ORDER BY COALESCE(dispatched_ms, settled_ms, 0), call_id').all(taskId).map(raw => this.#invocation(raw));
  }
  invocation(taskId: string, callId: string): ToolInvocation | undefined {
    const raw = this.db.prepare('SELECT * FROM tool_invocations WHERE task_id=? AND call_id=?').get(taskId, callId);
    return raw ? this.#invocation(raw) : undefined;
  }
  #invocation(raw: unknown): ToolInvocation {
    const row = InvocationRow.parse(raw);
    const result = row.result_json === null ? null : ToolResultSchema.safeParse(JSON.parse(row.result_json) as unknown).data ?? null;
    return { task_id: row.task_id, call_id: row.call_id, attempt: row.attempt, step: row.step, name: row.name, effect: row.effect,
      args_sha256: row.args_sha256, args: JSON.parse(row.args_json) as unknown, idempotency_key: row.idempotency_key, state: row.state,
      result, dispatched_ms: row.dispatched_ms, settled_ms: row.settled_ms };
  }

  /**
   * Record a call as `dispatched` before it is invoked. A repeated call id
   * replaces its row (a re-dispatch of an unsettled read or idempotent call
   * keeps its idempotency key). `compactArgs` is what is stored; `fullArgs`
   * only feeds the digest.
   */
  dispatch(taskId: string, call: { callId: string; attempt: number; step: number | null; name: string; effect: string; fullArgs: unknown; compactArgs: unknown; idempotencyKey: string }): void {
    this.#write(taskId, call, 'dispatched', null, Date.now(), null);
  }
  /** Record a call that was never dispatched (cancelled or over the limit before dispatch). */
  notDispatched(taskId: string, call: { callId: string; attempt: number; step: number | null; name: string; effect: string; fullArgs: unknown; compactArgs: unknown; idempotencyKey: string }, result: ToolResult): void {
    const prior = this.invocation(taskId, call.callId);
    // A later batch must not erase an earlier receipt for the same id.
    if (prior && SETTLED_STATES.has(prior.state) && prior.step === call.step) return;
    this.#write(taskId, call, 'not_dispatched', result, null, Date.now());
  }
  #write(taskId: string, call: { callId: string; attempt: number; step: number | null; name: string; effect: string; fullArgs: unknown; compactArgs: unknown; idempotencyKey: string },
    state: InvocationState, result: ToolResult | null, dispatched: number | null, settled: number | null): void {
    this.db.prepare(`INSERT INTO tool_invocations(task_id,call_id,attempt,step,name,effect,args_sha256,args_json,idempotency_key,state,result_json,dispatched_ms,settled_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,call_id) DO UPDATE SET attempt=excluded.attempt,step=excluded.step,name=excluded.name,
      effect=excluded.effect,args_sha256=excluded.args_sha256,args_json=excluded.args_json,idempotency_key=excluded.idempotency_key,state=excluded.state,
      result_json=excluded.result_json,dispatched_ms=excluded.dispatched_ms,settled_ms=excluded.settled_ms`)
      .run(taskId, call.callId, call.attempt, call.step, call.name, call.effect, argumentsDigest(call.fullArgs), JSON.stringify(call.compactArgs ?? null),
        call.idempotencyKey, state, result === null ? null : JSON.stringify(result), dispatched, settled);
  }
  /** Settle a call with its outcome. */
  settle(taskId: string, callId: string, state: InvocationState, result: ToolResult): void {
    this.db.prepare('UPDATE tool_invocations SET state=?,result_json=?,settled_ms=? WHERE task_id=? AND call_id=?')
      .run(state, JSON.stringify(result), Date.now(), taskId, callId);
  }
  /** Copy a row to another task (a continuation), optionally settled differently. Keeps the idempotency key. */
  copy(from: ToolInvocation, toTaskId: string, override: { state: InvocationState; result: ToolResult | null } | undefined): void {
    const state = override?.state ?? from.state;
    const result = override ? override.result : from.result;
    this.db.prepare(`INSERT INTO tool_invocations(task_id,call_id,attempt,step,name,effect,args_sha256,args_json,idempotency_key,state,result_json,dispatched_ms,settled_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(toTaskId, from.call_id, from.attempt, from.step, from.name, from.effect, from.args_sha256,
      JSON.stringify(from.args ?? null), from.idempotency_key, state, result === null ? null : JSON.stringify(result), from.dispatched_ms,
      override ? state === 'not_dispatched' ? null : Date.now() : from.settled_ms);
  }

  /**
   * Whether the task has an effect that may have happened without a recorded
   * outcome: an unsettled non-read call, a call settled with an unknown
   * effect, or (from a database older than these tables) a non-read
   * `tool_attempt` with no invocation row.
   */
  uncertain(taskId: string): boolean {
    if (this.db.prepare(`SELECT 1 FROM tool_invocations WHERE task_id=? AND ((state='dispatched' AND effect!='read') OR state='failed_unknown') LIMIT 1`).get(taskId)) return true;
    return this.legacyAttempts(taskId).some(attempt => attempt.effect !== 'read');
  }
  /** `tool_attempt` events with no invocation row: calls journaled before execution checkpoints existed. */
  legacyAttempts(taskId: string): Array<{ call_id: string | null; name: string; effect: string | null; settled: boolean }> {
    const rows = this.db.prepare(`SELECT e.sequence, json_extract(e.detail_json,'$.id') AS call_id, json_extract(e.detail_json,'$.name') AS name,
        json_extract(e.detail_json,'$.effect') AS effect FROM events e WHERE e.task_id=? AND e.kind='tool_attempt'
        AND NOT EXISTS (SELECT 1 FROM tool_invocations i WHERE i.task_id=e.task_id AND i.call_id=json_extract(e.detail_json,'$.id'))`).all(taskId);
    return rows.map(raw => {
      const row = z.object({ sequence: z.number().int(), call_id: z.string().nullable(), name: z.string().nullable(), effect: z.string().nullable() }).parse(raw);
      const settled = row.call_id !== null && this.db.prepare(`SELECT 1 FROM events WHERE task_id=? AND sequence>? AND kind='tool_result'
        AND json_extract(detail_json,'$.id')=? AND json_extract(detail_json,'$.result.ok')=0 AND json_extract(detail_json,'$.result.effect')='none' LIMIT 1`)
        .get(taskId, row.sequence, row.call_id) !== undefined;
      return { call_id: row.call_id, name: row.name ?? 'unknown', effect: settled ? 'read' : row.effect, settled };
    });
  }

  recovery(taskId: string): TaskRecoveryRow | undefined {
    const raw = this.db.prepare('SELECT * FROM task_recovery WHERE task_id=?').get(taskId);
    return raw ? this.#recovery(raw) : undefined;
  }
  /** Recovery rows for several tasks (task lists). */
  recoveries(taskIds: readonly string[]): Map<string, TaskRecoveryRow> {
    const found = new Map<string, TaskRecoveryRow>();
    if (!taskIds.length) return found;
    for (const raw of this.db.prepare(`SELECT * FROM task_recovery WHERE task_id IN (${taskIds.map(() => '?').join(',')})`).all(...taskIds)) {
      const row = this.#recovery(raw);
      found.set(row.task_id, row);
    }
    return found;
  }
  #recovery(raw: unknown): TaskRecoveryRow {
    const row = RecoveryRow.parse(raw);
    return { task_id: row.task_id, status: row.status, reason: RecoveryReason.parse(JSON.parse(row.reason_json) as unknown), attempt: row.attempt,
      checkpoint: row.checkpoint_json === null ? null : RecoveryCheckpoint.parse(JSON.parse(row.checkpoint_json) as unknown),
      continuation_task_id: row.continuation_task_id, decided: row.decided_json === null ? null : RecoveryDecision.parse(JSON.parse(row.decided_json) as unknown),
      updated_ms: row.updated_ms };
  }
  setRecovery(taskId: string, value: { status: RecoveryStatus; reason: RecoveryReason; attempt: number; checkpoint?: RecoveryCheckpoint | null;
    continuationTaskId?: string | null; decided?: RecoveryDecision | null }): void {
    const prior = this.recovery(taskId);
    const checkpoint = value.checkpoint === undefined ? prior?.checkpoint ?? null : value.checkpoint;
    const continuation = value.continuationTaskId === undefined ? prior?.continuation_task_id ?? null : value.continuationTaskId;
    const decided = value.decided === undefined ? prior?.decided ?? null : value.decided;
    this.db.prepare(`INSERT INTO task_recovery(task_id,status,reason_json,attempt,checkpoint_json,continuation_task_id,decided_json,updated_ms)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET status=excluded.status,reason_json=excluded.reason_json,attempt=excluded.attempt,
      checkpoint_json=excluded.checkpoint_json,continuation_task_id=excluded.continuation_task_id,decided_json=excluded.decided_json,updated_ms=excluded.updated_ms`)
      .run(taskId, RecoveryStatus.parse(value.status), JSON.stringify(RecoveryReason.parse(value.reason)), value.attempt,
        checkpoint === null ? null : JSON.stringify(RecoveryCheckpoint.parse(checkpoint)), continuation, decided === null ? null : JSON.stringify(RecoveryDecision.parse(decided)), Date.now());
  }
  /** Tasks currently in each open recovery status (for `GET /api/v1/status`). */
  counts(): { ready: number; reconciling: number; awaiting_decision: number; unsupported: number } {
    const rows = z.array(z.object({ status: z.string(), count: z.number().int() })).parse(this.db.prepare(`SELECT r.status, count(*) AS count FROM task_recovery r
      JOIN tasks t ON t.id=r.task_id WHERE (r.status IN ('ready','reconciling') AND t.state='running') OR r.status IN ('awaiting_decision','unsupported')
      GROUP BY r.status`).all());
    const count = (status: string) => rows.find(row => row.status === status)?.count ?? 0;
    return { ready: count('ready'), reconciling: count('reconciling'), awaiting_decision: count('awaiting_decision'), unsupported: count('unsupported') };
  }
}
