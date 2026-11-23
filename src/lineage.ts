import { z } from 'zod';
import { ExecutionContextSchema, ExecutionSource, localTaskId, type TaskExecution } from './execution.js';
import type { TaskEvent, TaskStore } from './store.js';

const Related = z.object({ ref: z.string(), local_task_id: z.string(), source: ExecutionSource, created_ms: z.number().int() });
export const ToolLineageState = z.enum(['attempted', 'succeeded', 'failed', 'denied', 'not_dispatched']);
/** What Ardent knows locally about a task's place in its causal tree, rebuilt from SQLite. */
export const TaskLineageSchema = z.object({
  task_id: z.string(),
  /** Absent for a task accepted before execution ancestry was recorded. */
  execution: ExecutionContextSchema.optional(),
  source: ExecutionSource.optional(),
  /** The task trace (W3C); each model call is a child span. */
  traceparent: z.string().optional(),
  parent: z.object({ ref: z.string(), local_task_id: z.string().optional() }).optional(),
  /** Local tasks whose parent is this task (A2A children on this instance, team children). */
  children: z.array(Related),
  /** Local tasks that continue this one after an operator recovery decision. */
  continuations: z.array(Related),
  model_attempts: z.array(z.object({ step: z.number().int(), attempt: z.number().int(), backend: z.string().nullable(),
    request_id: z.string().nullable(), ref: z.string().nullable(), started_ms: z.number().int(), usage: z.unknown().nullable(),
    repair: z.boolean().optional() })),
  tools: z.array(z.object({ call_id: z.string(), name: z.string(), effect: z.string().nullable(), state: ToolLineageState })),
  artifacts: z.array(z.object({ sha256: z.string(), name: z.string(), mime: z.string().nullable(), size: z.number().int().nullable(),
    artifact_id: z.string().nullable(), source: z.enum(['artifact_registered', 'research_artifacts']), created_ms: z.number().int() }))
});
export type TaskLineage = z.infer<typeof TaskLineageSchema>;

const record = z.record(z.string(), z.unknown());
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
const integer = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
const MAX_EVENTS = 20_000;

function allEvents(store: TaskStore, taskId: string): TaskEvent[] {
  const events: TaskEvent[] = [];
  for (let after = 0; events.length < MAX_EVENTS;) {
    const page = store.events(taskId, after, 500);
    events.push(...page);
    if (page.length < 500) break;
    after = page[page.length - 1]!.sequence;
  }
  return events;
}

function related(value: TaskExecution): z.infer<typeof Related> {
  return { ref: value.self_ref, local_task_id: value.task_id, source: value.source, created_ms: value.created_ms };
}

/**
 * The lineage of a local task: its execution context and parent, local children
 * and continuations, model attempts with their request ids, tool calls and
 * artifacts. Model attempts, tools and artifacts come from the task journal, so
 * tasks accepted before ancestry was recorded still list them.
 */
export function taskLineage(store: TaskStore, instance: string, taskId: string): TaskLineage | undefined {
  if (!store.get(taskId)) return undefined;
  const execution = store.executions.get(taskId);
  const linked = execution ? store.executions.children(execution.self_ref) : [];
  const parentRef = execution?.parent_ref ?? undefined;
  const parentLocal = parentRef ? localTaskId(instance, parentRef) : undefined;
  const modelAttempts: TaskLineage['model_attempts'] = [];
  const tools = new Map<string, TaskLineage['tools'][number]>();
  const artifacts = new Map<string, TaskLineage['artifacts'][number]>();
  let open: TaskLineage['model_attempts'][number] | undefined;
  const ordinals = new Map<number, number>();
  for (const event of allEvents(store, taskId)) {
    const detail = record.safeParse(event.detail).data ?? {};
    if (event.kind === 'model_started') {
      const step = integer(detail.step) ?? 0;
      const ordinal = (ordinals.get(step) ?? 0) + 1;
      ordinals.set(step, ordinal);
      open = { step, attempt: integer(detail.attempt) ?? ordinal, backend: text(detail.backend), request_id: text(detail.request_id),
        ref: text(detail.ref), started_ms: event.created_ms, usage: null, ...(detail.repair === true ? { repair: true } : {}) };
      modelAttempts.push(open);
    } else if ((event.kind === 'model_result' || event.kind === 'model_repair_result') && open) {
      open.usage = detail.usage ?? null;
      open = undefined;
    } else if (event.kind === 'tool_attempt' || event.kind === 'tool_result' || event.kind === 'tool_not_dispatched' || event.kind === 'tool_denied_by_plugin') {
      const callId = text(detail.id);
      if (!callId) continue;
      const entry = tools.get(callId) ?? { call_id: callId, name: text(detail.name) ?? '', effect: null, state: 'attempted' as const };
      if (event.kind === 'tool_attempt') entry.effect = text(detail.effect) ?? entry.effect;
      else if (event.kind === 'tool_denied_by_plugin') entry.state = 'denied';
      else if (event.kind === 'tool_not_dispatched') entry.state = 'not_dispatched';
      else if (entry.state !== 'denied') entry.state = record.safeParse(detail.result).data?.ok === true ? 'succeeded' : 'failed';
      tools.set(callId, entry);
    } else if (event.kind === 'artifact_registered') {
      const sha256 = text(detail.sha256);
      if (sha256) artifacts.set(sha256, { sha256, name: text(detail.name) ?? '', mime: text(detail.mime), size: integer(detail.size),
        artifact_id: text(detail.artifact_id), source: 'artifact_registered', created_ms: event.created_ms });
    } else if (event.kind === 'research_artifacts') {
      for (const value of [detail.report, detail.markdown]) {
        const item = record.safeParse(value).data;
        const sha256 = text(item?.sha256);
        if (!item || !sha256 || artifacts.has(sha256)) continue;
        artifacts.set(sha256, { sha256, name: text(item.name) ?? '', mime: text(item.media_type), size: integer(item.bytes),
          artifact_id: null, source: 'research_artifacts', created_ms: event.created_ms });
      }
    }
  }
  return {
    task_id: taskId,
    ...(execution ? { execution: execution.context, source: execution.source, traceparent: execution.traceparent } : {}),
    ...(parentRef ? { parent: { ref: parentRef, ...(parentLocal && store.get(parentLocal) ? { local_task_id: parentLocal } : {}) } } : {}),
    children: linked.filter(item => item.source !== 'continuation').map(related),
    continuations: linked.filter(item => item.source === 'continuation').map(related),
    model_attempts: modelAttempts,
    tools: [...tools.values()],
    artifacts: [...artifacts.values()].sort((a, b) => a.created_ms - b.created_ms)
  };
}
