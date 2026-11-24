import { z } from 'zod';
import { codexThreadRecoveryLocked, codexThreadRecoveryProblem } from './codex-protocol.js';
import { InvalidCheckpointError, NO_EFFECT_STATES, PendingCall, RecoveryAction, RecoveryCheckpoint, RecoveryDecision, RecoveryReason, RecoveryStatus,
  SETTLED_STATES, type ExecutionState, type TaskRecoveryRow, type ToolInvocation } from './execution-state.js';
import type { Task, TaskStore } from './store.js';
import type { Tool } from './tools.js';

/**
 * Execution recovery: what happens to a task that was `running` when the
 * process stopped. The shared constraint is that an unknown effect needs
 * reconciliation; it is never permission to retry. A write is never repeated
 * merely because execution resumed.
 *
 * The planner runs before any queued work is admitted and applies these rules
 * in order to each interrupted task:
 *
 * 1. `cancel_requested` journaled: `cancelled` when no effect is uncertain,
 *    otherwise held (`CANCELLED_WITH_UNSETTLED_EFFECT`).
 * 2. Deadline passed during the outage: `failed` when no effect is uncertain,
 *    otherwise held. The deadline is never extended automatically.
 * 3. Recovery disabled: `unknown`, as before recovery existed (`RECOVERY_DISABLED`).
 * 4. An extension executor with a possible effect ran, or a preview task: held, unsupported.
 * 5. Codex: resume a verified durable thread, restart when no effectful tool
 *    was ever dispatched, otherwise held (`CODEX_THREAD_NOT_VERIFIABLE`).
 * 6. llama.cpp without a checkpoint: restart when no effectful tool was
 *    dispatched (nothing happened), otherwise held (`NO_EXECUTION_CHECKPOINT`).
 * 7. Every dispatched call settled, or the unsettled ones are reads or
 *    idempotent: `ready`, resuming at the next step; unsettled reads and
 *    idempotent calls are re-dispatched with their idempotency key.
 * 8. An unsettled call whose tool can reconcile: `reconciling`; reconciliation
 *    runs first when the task resumes.
 * 9. Any other unsettled effectful call: held, awaiting an operator decision
 *    (`UNSETTLED_EXTERNAL_WRITE`).
 *
 * A held task is `unknown`, which stays terminal; an operator decision
 * continues its work as a linked continuation task.
 */

export type RecoveryView = {
  status: RecoveryStatus; reason: RecoveryReason; attempt: number; checkpoint?: RecoveryCheckpoint;
  actions: RecoveryAction[]; continuation_task_id?: string; decided?: RecoveryDecision;
};
export const RecoveryViewSchema = z.object({
  status: RecoveryStatus, reason: RecoveryReason, attempt: z.number().int().min(1), checkpoint: RecoveryCheckpoint.optional(),
  actions: z.array(RecoveryAction).describe('Only the actions valid now'),
  continuation_task_id: z.string().optional(), decided: RecoveryDecision.optional()
}).describe('Execution recovery of a task interrupted by a crash or restart. Absent for a task that was never interrupted.');

/** `POST /api/v1/tasks/{id}/recovery`. */
export const RecoveryDecisionInput = z.object({
  action: RecoveryAction,
  /** The pending call the decision (and `result`) is about; defaults to every pending call. */
  call_id: z.string().min(1).max(256).optional(),
  /** `mark_applied` only: the call's result, at most 64 KiB, checked against the tool's output schema. */
  result: z.unknown().optional(),
  note: z.string().trim().min(1).max(2000).optional(),
  /** `retry_with_new_deadline` only: the continuation's deadline from now, at most `execution.recovery_max_new_deadline_seconds`. */
  deadline_seconds: z.number().int().min(1).max(86400).optional()
}).strict();
export type RecoveryDecisionInput = z.infer<typeof RecoveryDecisionInput>;
export const MAX_OPERATOR_RESULT_BYTES = 64 * 1024;

export const RECOVERY_REASONS = {
  CANCELLED_DURING_OUTAGE: 'Cancellation was requested before the restart and no effect was uncertain, so the task was cancelled.',
  CANCELLED_WITH_UNSETTLED_EFFECT: 'Cancellation was requested, but a tool call with a possible external effect had not settled. Confirm whether it applied.',
  DEADLINE_ELAPSED_DURING_OUTAGE: 'The task deadline passed while the runtime was stopped. It is never extended automatically.',
  RECOVERY_DISABLED: 'Execution recovery is disabled (execution.recovery.enabled: false); interrupted tasks are held as unknown.',
  EXTENSION_EXECUTION_NOT_RESUMABLE: 'An extension task executor with a possible external effect was running; extension execution is not resumable.',
  PREVIEW_NOT_RESUMABLE: 'Preview tasks are not resumed; submit the preview again.',
  RESTART_NO_EFFECT: 'The task stopped before any effectful tool was dispatched; it restarts from the beginning.',
  NO_EXECUTION_CHECKPOINT: 'The task has no execution checkpoint (it started before checkpoints were recorded, or stopped before the first one) and dispatched an effectful tool.',
  CHECKPOINT_INVALID: 'The execution checkpoint failed verification and is not used.',
  RESUME_FROM_CHECKPOINT: 'Every interrupted tool call is settled, a read or idempotent; the task resumes at its next step.',
  TOOL_CHECK_PENDING: 'An interrupted tool call is checked against its tool (idempotency or reconciliation) before the task resumes.',
  RECONCILE_INTERRUPTED_CALL: 'An interrupted tool call can be reconciled with its service before the task resumes.',
  UNSETTLED_EXTERNAL_WRITE: 'A tool call with a possible external effect was dispatched but its outcome was not recorded, and the tool cannot prove it. Confirm whether it applied.',
  RECONCILIATION_INCONCLUSIVE: 'Reconciliation could not prove whether an interrupted tool call applied. Confirm whether it applied.',
  CODEX_THREAD_RESUME: 'The durable Codex thread is resumed after thread/read verifies every tool call in it.',
  CODEX_RESTART_NO_EFFECT: 'The Codex task never dispatched an effectful tool; it restarts on a fresh thread.',
  CODEX_THREAD_NOT_VERIFIABLE: 'The Codex task dispatched an effectful tool and its thread cannot be verified for resumption.'
} as const;
export type RecoveryReasonCode = keyof typeof RECOVERY_REASONS;
export function reason(code: RecoveryReasonCode, detail?: string): RecoveryReason {
  return { code, message: detail ? `${RECOVERY_REASONS[code]} ${detail}`.slice(0, 1000) : RECOVERY_REASONS[code] };
}

/** How a resumed task treats one unsettled call, decided from its current tool definition. */
export type PendingVerdict = 'redispatch' | 'reconcile' | 'hold';
/** Classify an unsettled call. Read and idempotent calls are re-dispatched; reconcilable ones are asked; the rest are held. */
export function classifyPending(invocation: Pick<ToolInvocation, 'effect'>, tool: Pick<Tool, 'effect' | 'idempotent' | 'reconcile'> | undefined): PendingVerdict {
  if (invocation.effect === 'read') return 'redispatch';
  if (!tool) return 'hold';
  if (tool.effect === 'read' || tool.idempotent === true) return 'redispatch';
  return typeof tool.reconcile === 'function' ? 'reconcile' : 'hold';
}

type Plan =
  | { outcome: 'cancelled' | 'failed'; reason: RecoveryReason }
  | { outcome: 'held'; status: 'awaiting_decision' | 'unsupported'; reason: RecoveryReason; checkpoint: RecoveryCheckpoint }
  | { outcome: 'ready' | 'reconciling'; reason: RecoveryReason; checkpoint: RecoveryCheckpoint };

export type RecoveryPlanOptions = {
  enabled?: boolean;
  now?: number;
  /** The tool a task would call by this name now. Without it, calls that need a tool check stay `reconciling` until the runtime checks them. */
  toolFor?: (task: Task, name: string) => Tool | undefined;
};
export type RecoveryOutcome = { resumed: string[]; held: string[] };

function pendingCalls(invocations: readonly ToolInvocation[], legacy: ReturnType<TaskStore['executionState']['legacyAttempts']>,
  reconcilable: (invocation: ToolInvocation) => boolean): PendingCall[] {
  return [
    ...invocations.filter(item => item.state === 'dispatched').map(item => ({ call_id: item.call_id, tool: item.name, effect: item.effect,
      dispatched_at: item.dispatched_ms === null ? null : new Date(item.dispatched_ms).toISOString(), reconcilable: reconcilable(item) })),
    ...legacy.filter(item => !item.settled).map(item => ({ call_id: item.call_id ?? 'unknown', tool: item.name, effect: item.effect ?? 'unknown', dispatched_at: null, reconcilable: false }))
  ];
}

/** The attempt that was interrupted. */
export function interruptedAttempt(state: ExecutionState | undefined, recovery: TaskRecoveryRow | undefined): number {
  return Math.max(state?.attempt ?? 1, recovery?.status === 'resumed' ? recovery.attempt : 1);
}

function planTask(store: TaskStore, task: Task, options: RecoveryPlanOptions, now: number): Plan {
  const states = store.executionState;
  let state: ExecutionState | undefined;
  let invalid = false;
  try { state = states.get(task.id); } catch (error: unknown) { if (error instanceof InvalidCheckpointError) invalid = true; else throw error; }
  const invocations = states.invocations(task.id);
  const legacy = states.legacyAttempts(task.id);
  const unsettled = invocations.filter(item => item.state === 'dispatched');
  const uncertain = states.uncertain(task.id);
  const effectfulDispatched = invocations.some(item => item.effect !== 'read' && !NO_EFFECT_STATES.has(item.state)) || legacy.some(item => item.effect !== 'read');
  const verdicts = new Map(unsettled.map(item => [item.call_id, options.toolFor ? classifyPending(item, options.toolFor(task, item.name)) : item.effect === 'read' ? 'redispatch' as const : undefined]));
  const checkpoint: RecoveryCheckpoint = { step: state?.step ?? 0, completed_calls: invocations.filter(item => SETTLED_STATES.has(item.state)).length,
    pending_calls: pendingCalls(invocations, legacy, item => verdicts.get(item.call_id) === 'reconcile') };
  const held = (status: 'awaiting_decision' | 'unsupported', value: RecoveryReason): Plan => ({ outcome: 'held', status, reason: value, checkpoint });
  const events = (kind: string) => store.db.prepare('SELECT 1 FROM events WHERE task_id=? AND kind=? LIMIT 1').get(task.id, kind) !== undefined;

  if (events('cancel_requested')) return uncertain ? held('awaiting_decision', reason('CANCELLED_WITH_UNSETTLED_EFFECT')) : { outcome: 'cancelled', reason: reason('CANCELLED_DURING_OUTAGE') };
  if (task.deadline_ms <= now) return uncertain ? held('awaiting_decision', reason('DEADLINE_ELAPSED_DURING_OUTAGE')) : { outcome: 'failed', reason: reason('DEADLINE_ELAPSED_DURING_OUTAGE') };
  if (options.enabled === false) return held('unsupported', reason('RECOVERY_DISABLED'));
  const extension = store.db.prepare("SELECT 1 FROM events WHERE task_id=? AND kind='extension_execution_attempt' AND json_extract(detail_json,'$.effect')='possible' LIMIT 1").get(task.id);
  if (extension) return held('unsupported', reason('EXTENSION_EXECUTION_NOT_RESUMABLE'));
  if (task.context === 'preview') return held('unsupported', reason('PREVIEW_NOT_RESUMABLE'));
  if (invalid) return held('unsupported', reason('CHECKPOINT_INVALID'));

  if (task.backend === 'codex') {
    const effectfulUnsettled = unsettled.some(item => item.effect !== 'read') || legacy.some(item => !item.settled && item.effect !== 'read');
    const thread = state?.codex;
    if (!effectfulUnsettled && thread?.durable && codexThreadRecoveryLocked()) return { outcome: 'ready', reason: reason('CODEX_THREAD_RESUME'), checkpoint };
    if (!effectfulDispatched) return { outcome: 'ready', reason: reason('CODEX_RESTART_NO_EFFECT'), checkpoint };
    const why = effectfulUnsettled ? 'An effectful tool call is unsettled.' : !thread ? 'No thread was recorded.' : !thread.durable ? 'The thread was ephemeral (providers.codex.durable_threads: false).'
      : codexThreadRecoveryProblem(undefined) ?? 'The thread could not be verified.';
    return held('unsupported', reason('CODEX_THREAD_NOT_VERIFIABLE', why));
  }
  if (!state) return effectfulDispatched ? held('unsupported', reason('NO_EXECUTION_CHECKPOINT')) : { outcome: 'ready', reason: reason('RESTART_NO_EFFECT'), checkpoint };
  if (legacy.some(item => !item.settled && item.effect !== 'read')) return held('unsupported', reason('NO_EXECUTION_CHECKPOINT'));
  const values = [...verdicts.values()];
  if (values.every(value => value === 'redispatch')) return { outcome: 'ready', reason: reason('RESUME_FROM_CHECKPOINT'), checkpoint };
  if (values.some(value => value === 'hold')) {
    const missing = unsettled.find(item => verdicts.get(item.call_id) === 'hold' && !options.toolFor?.(task, item.name));
    return held('awaiting_decision', reason('UNSETTLED_EXTERNAL_WRITE', missing ? `Tool ${missing.name} is no longer available.` : undefined));
  }
  if (values.some(value => value === undefined)) return { outcome: 'reconciling', reason: reason('TOOL_CHECK_PENDING'), checkpoint };
  return { outcome: 'reconciling', reason: reason('RECONCILE_INTERRUPTED_CALL'), checkpoint };
}

/** Record one plan. Ready and reconciling tasks stay `running` under the same id. */
function applyPlan(store: TaskStore, task: Task, plan: Plan, attempt: number): void {
  const states = store.executionState;
  store.db.transaction(() => {
    if (plan.outcome === 'cancelled' || plan.outcome === 'failed') {
      store.setState(task.id, plan.outcome, null, plan.reason.message);
      states.setRecovery(task.id, { status: 'resolved', reason: plan.reason, attempt });
    } else if (plan.outcome === 'held') {
      store.setState(task.id, 'unknown', null, `Interrupted during execution: ${plan.reason.message}`.slice(0, 1000));
      states.setRecovery(task.id, { status: plan.status, reason: plan.reason, attempt, checkpoint: plan.checkpoint });
    } else if (plan.outcome === 'ready' || plan.outcome === 'reconciling') states.setRecovery(task.id, { status: plan.outcome, reason: plan.reason, attempt, checkpoint: plan.checkpoint });
    store.append(task.id, 'recovery_planned', { status: plan.outcome === 'held' ? plan.status : plan.outcome === 'ready' || plan.outcome === 'reconciling' ? plan.outcome : 'resolved',
      outcome: plan.outcome === 'held' ? 'unknown' : plan.outcome === 'ready' || plan.outcome === 'reconciling' ? 'running' : plan.outcome, reason: plan.reason, attempt });
  })();
}

/**
 * Plan every task that was `running`. Returns the ids left running for
 * resumption and the ids held as `unknown`.
 */
export function planRecovery(store: TaskStore, options: RecoveryPlanOptions = {}): RecoveryOutcome {
  const now = options.now ?? Date.now();
  const running = store.db.prepare("SELECT * FROM tasks WHERE state='running' ORDER BY created_ms").all().map(row => store.parseTask(row));
  const outcome: RecoveryOutcome = { resumed: [], held: [] };
  for (const task of running) {
    let state: ExecutionState | undefined;
    try { state = store.executionState.get(task.id); } catch { state = undefined; }
    const plan = planTask(store, task, options, now);
    applyPlan(store, task, plan, interruptedAttempt(state, store.executionState.recovery(task.id)));
    if (plan.outcome === 'ready' || plan.outcome === 'reconciling') outcome.resumed.push(task.id);
    else if (plan.outcome === 'held') outcome.held.push(task.id);
  }
  return outcome;
}

/**
 * Re-check a `reconciling` task whose calls still need a tool check, now that
 * its tools are known. Holds it when a call cannot be proven.
 */
export function refinePlan(store: TaskStore, task: Task, toolFor: (name: string) => Tool | undefined, enabled: boolean): 'ready' | 'reconciling' | 'held' | 'unchanged' {
  const row = store.executionState.recovery(task.id);
  if (task.state !== 'running' || !row || row.reason.code !== 'TOOL_CHECK_PENDING') return 'unchanged';
  let state: ExecutionState | undefined;
  try { state = store.executionState.get(task.id); } catch { state = undefined; }
  const plan = planTask(store, task, { enabled, toolFor: (_task, name) => toolFor(name) }, Date.now());
  applyPlan(store, task, plan, interruptedAttempt(state, row));
  return plan.outcome === 'held' ? 'held' : plan.outcome === 'ready' || plan.outcome === 'reconciling' ? plan.outcome : 'held';
}

/** Whether a continuation can be seeded from the task's checkpoint. */
export function continuable(store: TaskStore, task: Task): boolean {
  if (task.backend !== 'llamacpp' || task.context === 'preview') return false;
  try { return store.executionState.get(task.id) !== undefined; } catch { return false; }
}

/** The decisions valid now for a recovery. Only `awaiting_decision` takes a decision. */
export function validActions(store: TaskStore, task: Task, row: TaskRecoveryRow, now = Date.now()): RecoveryAction[] {
  if (row.status !== 'awaiting_decision' || task.state !== 'unknown') return [];
  if (row.reason.code === 'CANCELLED_WITH_UNSETTLED_EFFECT') return ['mark_applied', 'mark_not_applied', 'abandon'];
  if (!continuable(store, task)) return ['abandon'];
  return [...(task.deadline_ms > now ? ['mark_applied', 'mark_not_applied'] as const : []), 'retry_with_new_deadline', 'abandon'];
}

/** The C3 recovery object of a task, when it was ever interrupted. */
export function recoveryView(store: TaskStore, task: Task, row = store.executionState.recovery(task.id), now = Date.now()): RecoveryView | undefined {
  if (!row) return undefined;
  return { status: row.status, reason: row.reason, attempt: row.attempt, ...(row.checkpoint ? { checkpoint: row.checkpoint } : {}),
    actions: validActions(store, task, row, now), ...(row.continuation_task_id ? { continuation_task_id: row.continuation_task_id } : {}),
    ...(row.decided ? { decided: row.decided } : {}) };
}
