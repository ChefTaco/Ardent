import {
  childExecution, EXECUTION_METADATA_KEY, executionHeaders, formatExecutionRef, parseExecutionContext, parseExecutionRef,
  type ExecutionContext
} from '@hivemagnus/hive-common/execution';
import {
  childTraceparent, formatTraceparent, generateRequestId, generateTraceparent, isValidRequestId, parseTraceparent
} from '@hivemagnus/hive-common/context';
import { z } from 'zod';
import type Database from './sqlite.js';

/**
 * Durable execution ancestry (execution context v1, `@hivemagnus/hive-common/execution`).
 *
 * Ancestry is attribution only. Tool, memory, mission, team-child and artifact
 * selection never read `task_execution`; they re-derive scope from their owning
 * stores. A context a caller supplies is never rejected: an invalid or absent one
 * is replaced by a root minted for the task.
 */
export { EXECUTION_METADATA_KEY, type ExecutionContext };

/** The environment variable naming this runtime instance in qualified references. */
export const INSTANCE_REF_ENV = 'ARDENT_INSTANCE_REF';
const INSTANCE = /^[A-Za-z0-9._-]{1,96}$/;
const REF = /^hx1:[a-z][a-z0-9-]{1,31}:[A-Za-z0-9._-]{1,96}:[a-z]+:[A-Za-z0-9._:/-]{1,128}$/;

/** Where a task's execution context came from. */
export const ExecutionSource = z.enum(['caller', 'a2a', 'minted', 'continuation']);
export type ExecutionSource = z.infer<typeof ExecutionSource>;

const QualifiedRef = z.string().max(256).regex(REF).describe('Qualified reference hx1:<product>:<instance>:<kind>:<id>');
/** Execution context v1 as Ardent reports it. Parsing always goes through hive-common, which never throws. */
export const ExecutionContextSchema = z.object({
  v: z.literal(1),
  request_id: z.string().max(128).optional(),
  root: QualifiedRef,
  parent: QualifiedRef.optional(),
  self: QualifiedRef.optional(),
  inputs: z.array(QualifiedRef).max(16).readonly().optional(),
  attempt: z.number().int().min(1).optional(),
  deadline_ms: z.number().int().min(0).optional()
}).describe('Execution context v1. Attribution only: it never grants a tool, memory scope or artifact. An invalid value is treated as absent and never rejected.');

/** A request-body `execution` field: documented as a context, accepted as anything. */
export const ExecutionInput = z.unknown();

/**
 * The instance part of this runtime's references: `ARDENT_INSTANCE_REF`
 * (`<magnus node>.<profile>` under Magnus), else `local.<profile>`.
 */
export function executionInstance(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[INSTANCE_REF_ENV];
  if (value === undefined || value === '') return `local.${profile}`;
  if (!INSTANCE.test(value)) throw new Error(`${INSTANCE_REF_ENV} must be 1 to 96 characters of A-Z, a-z, 0-9, '.', '_' or '-'`);
  return value;
}

/** The problem with `ARDENT_INSTANCE_REF`, if any. */
export function instanceRefProblem(env: NodeJS.ProcessEnv): string | undefined {
  try { executionInstance('profile', env); return undefined; }
  catch (error: unknown) { return error instanceof Error ? error.message : `${INSTANCE_REF_ENV} is invalid`; }
}

export function taskRef(instance: string, taskId: string): string {
  return formatExecutionRef({ product: 'ardent', instance, kind: 'task', id: taskId });
}
/** One model call: `hx1:ardent:<instance>:attempt:<task>/<step>/<n>`. */
export function attemptRef(instance: string, taskId: string, step: number, attempt: number): string {
  return formatExecutionRef({ product: 'ardent', instance, kind: 'attempt', id: `${taskId}/${step}/${attempt}` });
}

/** The local task id a reference names, when it is a task of this instance. */
export function localTaskId(instance: string, ref: string | null | undefined): string | undefined {
  const parts = parseExecutionRef(ref);
  return parts && parts.product === 'ardent' && parts.instance === instance && parts.kind === 'task' ? parts.id : undefined;
}

/**
 * What an accept path knows about the work's ancestry. `context` is the raw
 * supplied value (a body field, A2A metadata or a decoded header); anything
 * invalid is treated as absent. `continuation` is for a task that continues
 * another one (execution recovery): pass the original's context and the next attempt.
 */
export type ExecutionAcceptance = {
  context?: unknown;
  source?: Exclude<ExecutionSource, 'minted'>;
  /** The inbound `x-request-id`, used when the context carries none. */
  requestId?: string | undefined;
  /** The inbound `traceparent`; the task trace becomes its child. */
  traceparent?: string | undefined;
  attempt?: number;
  inputs?: readonly string[];
};

/** The row `task_execution` keeps for a task. */
export type TaskExecution = {
  task_id: string;
  self_ref: string;
  root_ref: string;
  parent_ref: string | null;
  inputs: string[];
  context: ExecutionContext;
  /** The task trace (W3C `traceparent`); model calls are its child spans. */
  traceparent: string;
  source: ExecutionSource;
  created_ms: number;
};

/** Build the execution context of a newly accepted task. Self is always this task. */
export function buildTaskExecution(instance: string, task: { id: string; deadline_ms: number; created_ms: number },
  acceptance: ExecutionAcceptance = {}): TaskExecution {
  const supplied = parseExecutionContext(acceptance.context);
  const self = taskRef(instance, task.id);
  const inbound = isValidRequestId(acceptance.requestId) ? acceptance.requestId : undefined;
  const requestId = supplied?.request_id ?? inbound ?? generateRequestId();
  const context = childExecution(supplied, self, { requestId, deadlineMs: task.deadline_ms,
    ...(acceptance.attempt !== undefined ? { attempt: acceptance.attempt } : {}),
    ...(acceptance.inputs?.length ? { inputs: acceptance.inputs } : supplied?.inputs?.length ? { inputs: supplied.inputs } : {}) });
  const parentTrace = parseTraceparent(acceptance.traceparent);
  const trace = parentTrace ? childTraceparent(parentTrace) : generateTraceparent();
  return { task_id: task.id, self_ref: self, root_ref: context.root, parent_ref: context.parent ?? null, inputs: [...(context.inputs ?? [])],
    context, traceparent: formatTraceparent(trace), source: supplied ? acceptance.source ?? 'caller' : 'minted', created_ms: task.created_ms };
}

const Row = z.object({ task_id: z.string(), self_ref: z.string(), root_ref: z.string(), parent_ref: z.string().nullable(),
  inputs_json: z.string(), context_json: z.string(), source: ExecutionSource, created_ms: z.number().int() });
const StoredContext = z.object({ execution: z.unknown(), traceparent: z.string() });

/**
 * The `task_execution` table: one row per task accepted since ancestry was
 * added. Tasks accepted before have no row and report no `execution`.
 */
export class TaskExecutions {
  constructor(readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS task_execution (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id), self_ref TEXT NOT NULL, root_ref TEXT NOT NULL, parent_ref TEXT,
      inputs_json TEXT NOT NULL, context_json TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('caller','a2a','minted','continuation')), created_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS task_execution_root ON task_execution(root_ref, created_ms);
      CREATE INDEX IF NOT EXISTS task_execution_parent ON task_execution(parent_ref, created_ms);`);
  }
  /** Record a task's context. Call inside the accept transaction. */
  insert(value: TaskExecution): void {
    this.db.prepare(`INSERT INTO task_execution(task_id,self_ref,root_ref,parent_ref,inputs_json,context_json,source,created_ms)
      VALUES (?,?,?,?,?,?,?,?)`).run(value.task_id, value.self_ref, value.root_ref, value.parent_ref, JSON.stringify(value.inputs),
      JSON.stringify({ execution: value.context, traceparent: value.traceparent }), value.source, value.created_ms);
  }
  get(taskId: string): TaskExecution | undefined {
    const raw = this.db.prepare('SELECT * FROM task_execution WHERE task_id=?').get(taskId);
    return raw ? this.#record(raw) : undefined;
  }
  /** Contexts for several tasks at once (task lists). */
  many(taskIds: readonly string[]): Map<string, TaskExecution> {
    const found = new Map<string, TaskExecution>();
    if (!taskIds.length) return found;
    const rows = this.db.prepare(`SELECT * FROM task_execution WHERE task_id IN (${taskIds.map(() => '?').join(',')})`).all(...taskIds);
    for (const raw of rows) { const record = this.#record(raw); if (record) found.set(record.task_id, record); }
    return found;
  }
  /** Local tasks whose causal parent is `ref`, oldest first. */
  children(ref: string, limit = 200): TaskExecution[] {
    return this.db.prepare('SELECT * FROM task_execution WHERE parent_ref=? ORDER BY created_ms, task_id LIMIT ?')
      .all(ref, Math.max(1, Math.min(limit, 500))).flatMap(raw => this.#record(raw) ?? []);
  }
  #record(raw: unknown): TaskExecution | undefined {
    const row = Row.parse(raw);
    let stored: z.infer<typeof StoredContext>;
    let inputs: string[];
    try {
      stored = StoredContext.parse(JSON.parse(row.context_json) as unknown);
      inputs = z.array(z.string()).parse(JSON.parse(row.inputs_json) as unknown);
    } catch { return undefined; }
    const context = parseExecutionContext(stored.execution);
    if (!context) return undefined;
    return { task_id: row.task_id, self_ref: row.self_ref, root_ref: row.root_ref, parent_ref: row.parent_ref, inputs, context,
      traceparent: stored.traceparent, source: row.source, created_ms: row.created_ms };
  }
}

/** What one model call sends and journals. */
export type ModelAttempt = { ref: string; attempt: number; request_id: string; traceparent: string; headers: Record<string, string> };

/**
 * Outbound propagation for one running task: llama.cpp request headers
 * (`x-request-id`, `traceparent`, `x-hive-execution`) and A2A metadata.
 */
export class TaskPropagation {
  readonly #trace: ReturnType<typeof generateTraceparent>;
  constructor(readonly instance: string, readonly task: { id: string; deadline_ms: number }, readonly context: ExecutionContext,
    traceparent?: string) {
    this.#trace = parseTraceparent(traceparent) ?? generateTraceparent();
  }
  /**
   * A task without a stored row (accepted before ancestry was added) still
   * propagates, as a root at its own reference that is not persisted.
   */
  static forTask(instance: string, task: { id: string; deadline_ms: number }, record: TaskExecution | undefined): TaskPropagation {
    return new TaskPropagation(instance, task, record?.context ?? childExecution(undefined, taskRef(instance, task.id), { deadlineMs: task.deadline_ms }),
      record?.traceparent);
  }
  /** Headers for a model call that is not a completion (token counting): the task context. */
  headers(): Record<string, string> {
    return { 'x-request-id': generateRequestId(), traceparent: formatTraceparent(childTraceparent(this.#trace)), ...executionHeaders(this.context) };
  }
  /** One model completion: its attempt reference, a new request id and a child span. */
  modelAttempt(step: number, attempt: number): ModelAttempt {
    const ref = attemptRef(this.instance, this.task.id, step, attempt);
    const requestId = generateRequestId();
    const traceparent = formatTraceparent(childTraceparent(this.#trace));
    const context = childExecution(this.context, ref, { attempt, deadlineMs: this.task.deadline_ms });
    return { ref, attempt, request_id: requestId, traceparent, headers: { 'x-request-id': requestId, traceparent, ...executionHeaders(context) } };
  }
}

