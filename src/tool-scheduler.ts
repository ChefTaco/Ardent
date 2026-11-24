import { createHash } from 'node:crypto';
import { frozenCopy, observePluginToolResult, pluginBeforeToolCall, runPluginObservers, type ArdentPlugin, type ArdentTaskPluginContext,
  type ArdentToolCall, type PluginHookFailureSink } from './plugins.js';
import type { TaskEvidence } from './runtime.js';
import { ToolCallLimitError, toolRunsInParallel, type ExecutionContext, type Tool, type ToolContext, type ToolRegistry, type ToolResult } from './tools.js';

/** One model tool call, bound to the id the model gave it. */
export type ScheduledToolCall = { id: string; name: string; arguments: unknown };
export type ScheduledToolOutcome = { call: ScheduledToolCall; result: ToolResult };
export type NotDispatchedReason = 'cancelled' | 'tool_call_limit' | 'batch_failed' | 'task_settled';

export type ToolSchedulerOptions = {
  taskId: string;
  context: ToolContext;
  tools: ToolRegistry;
  /** Parallel-eligible calls in flight at once (`execution.max_parallel_tool_calls`). */
  limit: number;
  /** Dispatches allowed for the whole task (`execution.max_tool_calls`). */
  maxToolCalls: number;
  signal: AbortSignal;
  /**
   * Append a task journal event. For `tool_attempt`, `tool_result` and
   * `tool_not_dispatched` the call is passed too, so the runtime writes its
   * execution checkpoint (`tool_invocations`, `execution_state`) in the same
   * transaction as the event.
   */
  journal(kind: string, detail: unknown, boundary?: ToolBoundary): void;
  /** Operator pause: resolves when the task may dispatch, rejects on abort. */
  pauseGate(signal: AbortSignal): Promise<void>;
  /** Team admission boundary, after the attempt is journaled and before invocation. */
  admissionGate(signal: AbortSignal): Promise<void>;
  /** The journal shape of the arguments (`compactToolArguments`). */
  journalArguments?(name: string, args: unknown): unknown;
  /** Runtime evidence recording, before plugin observers. */
  recordEvidence?(name: string, result: ToolResult): void;
  /** False once the task's terminal state is recorded; later results are not journaled. */
  accepting?(): boolean;
  plugins?: readonly ArdentPlugin[];
  pluginContext?: ArdentTaskPluginContext;
  evidence?: TaskEvidence;
  execution?: ExecutionContext;
  /** Dispatches already counted toward `maxToolCalls` (a resumed task's recorded tool count). */
  initialDispatched?: number;
  /** The idempotency key of a call carried over from an earlier attempt; default `toolIdempotencyKey(taskId, id)`. */
  idempotencyKeyFor?(callId: string): string | undefined;
  /** A recorded outcome to return instead of dispatching (a settled call reused on resume). It is never dispatched again. */
  reuse?(call: ScheduledToolCall): ToolResult | undefined;
};
/** The call a boundary journal event belongs to. `arguments` are the full (uncompacted) arguments. */
export type ToolBoundary = { call: ScheduledToolCall; effect: Tool['effect'] | undefined; idempotencyKey: string; result?: ToolResult };

type Waiter = { parallel: boolean; resolve: () => void; reject: (reason: NotDispatchedReason) => void };
type InFlight = { call: ArdentToolCall; tool: Tool | undefined };

/** The idempotency key a tool receives: `sha256("<taskId>:<callId>")`, stable for one model call. */
export function toolIdempotencyKey(taskId: string, callId: string): string {
  return createHash('sha256').update(`${taskId}:${callId}`).digest('hex');
}

/**
 * Dispatches one task's tool calls under a single policy for every backend.
 *
 * Calls are admitted strictly in arrival (emitted) order. A parallel-eligible
 * call (a `read` tool, or one declaring `concurrency: 'parallel'`) shares a
 * slot with the calls around it, at most `limit` at once. Any other call is a
 * barrier: it starts after every earlier call settled, and later calls wait for
 * it. Each dispatch pauses, checks the tool-call limit, journals the attempt,
 * passes team admission, asks plugins, invokes, journals the result and tells
 * observers, in that order. On abort, queued calls settle without dispatch;
 * calls already started keep their uncertainty.
 */
export class ToolScheduler {
  readonly #options: ToolSchedulerOptions;
  readonly #limit: number;
  readonly #queue: Waiter[] = [];
  readonly #inFlight = new Set<InFlight>();
  readonly #hooks = new Set<Promise<void>>();
  #hookChain: Promise<void> = Promise.resolve();
  #shared = 0;
  #exclusive = false;
  #dispatched = 0;
  #closed: NotDispatchedReason | undefined;
  constructor(options: ToolSchedulerOptions) {
    this.#options = options;
    this.#limit = Math.max(1, Math.min(16, Math.floor(options.limit)));
    this.#dispatched = Math.max(0, Math.floor(options.initialDispatched ?? 0));
    if (options.signal.aborted) this.#closed = 'cancelled';
    else options.signal.addEventListener('abort', () => this.#abort(), { once: true });
  }
  /** Calls journaled as attempted so far. */
  get dispatched(): number { return this.#dispatched; }

  /** Run one model turn's calls; results come back in emitted order. */
  async runBatch(calls: readonly ScheduledToolCall[]): Promise<ScheduledToolOutcome[]> {
    const settled = await Promise.allSettled(calls.map(call => this.dispatch(call)));
    return settled.map((item, index) => {
      if (item.status === 'rejected') throw settled.find(entry => entry.status === 'rejected')?.reason ?? item.reason;
      return { call: calls[index]!, result: item.value };
    });
  }

  /** Dispatch one call. Admission order is the order of `dispatch` calls. */
  dispatch(call: ScheduledToolCall): Promise<ToolResult> {
    // A settled call is reused, never dispatched again; it takes no slot and no tool-call budget.
    const reused = this.#options.reuse?.(call);
    if (reused) return Promise.resolve(reused);
    const tool = this.#options.tools.get(call.name, this.#options.context);
    // A question to the user ends the turn, so it never overlaps another call.
    const parallel = call.name !== 'team_ask_user' && toolRunsInParallel(tool);
    const admitted = this.#acquire(parallel);
    return this.#run(call, tool, parallel, admitted);
  }

  /** Wait for cancellation callbacks already started; call before per-task cleanup. */
  async quiesce(): Promise<void> {
    while (this.#hooks.size) await Promise.allSettled([...this.#hooks]);
  }

  #key(callId: string): string {
    return this.#options.idempotencyKeyFor?.(callId) ?? toolIdempotencyKey(this.#options.taskId, callId);
  }

  async #run(call: ScheduledToolCall, tool: Tool | undefined, parallel: boolean, admitted: Promise<void>): Promise<ToolResult> {
    const options = this.#options;
    try { await admitted; }
    catch (reason: unknown) { return this.#notDispatched(call, tool, this.#closed ?? (reason === 'tool_call_limit' || reason === 'batch_failed' || reason === 'task_settled' ? reason : 'cancelled')); }
    let entry: InFlight | undefined;
    try {
      try { await options.pauseGate(options.signal); }
      catch (error: unknown) { if (options.signal.aborted) return this.#notDispatched(call, tool, 'cancelled'); throw error; }
      if (this.#closed) return this.#notDispatched(call, tool, this.#closed);
      if (options.accepting && !options.accepting()) return this.#notDispatched(call, tool, 'task_settled');
      if (this.#dispatched >= options.maxToolCalls) {
        this.#close('tool_call_limit');
        this.#notDispatched(call, tool, 'tool_call_limit');
        throw new ToolCallLimitError();
      }
      this.#dispatched++;
      const idempotencyKey = this.#key(call.id);
      options.journal('tool_attempt', { id: call.id, name: call.name, args: options.journalArguments ? options.journalArguments(call.name, call.arguments) : call.arguments,
        ...(tool ? { effect: tool.effect } : {}) }, { call, effect: tool?.effect, idempotencyKey });
      entry = { call: this.#hookCall(call, tool, call.arguments, idempotencyKey), tool };
      this.#inFlight.add(entry);
      await options.admissionGate(options.signal);
      const prepared = options.tools.prepare(call.name, call.arguments, options.context);
      let result: ToolResult;
      if ('result' in prepared) result = prepared.result;
      else {
        entry.call = this.#hookCall(call, prepared.tool, prepared.input, idempotencyKey);
        const denial = options.plugins && options.pluginContext
          ? await pluginBeforeToolCall(options.plugins, options.pluginContext, entry.call, this.#failure) : undefined;
        if (denial) {
          options.journal('tool_denied_by_plugin', { id: call.id, name: call.name, plugin: denial.plugin, code: denial.code });
          result = { ok: false, code: denial.code, message: denial.message, effect: 'none' };
        } else result = await options.tools.invokePrepared(prepared, options.signal,
          { idempotencyKey, ...(options.execution ? { execution: options.execution } : {}) });
      }
      this.#inFlight.delete(entry);
      // Never append a late result to a task whose terminal state is recorded.
      if (options.accepting && !options.accepting()) return result;
      options.journal('tool_result', { id: call.id, name: call.name, result }, { call, effect: tool?.effect, idempotencyKey, result });
      options.recordEvidence?.(call.name, result);
      if (options.plugins && options.pluginContext) {
        if (options.evidence) observePluginToolResult(options.plugins, options.pluginContext, call.name, result, options.evidence, this.#failure);
        const view = entry.call;
        const context = options.pluginContext;
        await runPluginObservers(options.plugins, 'afterToolCall', plugin => plugin.afterToolCall?.(context, view, frozenCopy(result)), this.#failure);
      }
      return result;
    } catch (error: unknown) {
      if (entry) this.#inFlight.delete(entry);
      // A failed dispatch fails the turn: nothing queued behind it may start.
      if (!(error instanceof ToolCallLimitError)) this.#close(options.signal.aborted ? 'cancelled' : 'batch_failed');
      throw error;
    } finally { this.#release(parallel); }
  }

  #hookCall(call: ScheduledToolCall, tool: Tool | undefined, args: unknown, idempotencyKey: string): ArdentToolCall {
    let copied: unknown;
    try { copied = structuredClone(args); } catch { copied = null; }
    return frozenCopy({ task_id: this.#options.taskId, call_id: call.id, name: call.name, arguments: copied,
      effect: tool?.effect ?? 'read', idempotency_key: idempotencyKey, ...(this.#options.execution ? { execution: this.#options.execution } : {}) });
  }

  readonly #failure: PluginHookFailureSink = (plugin, hook) => {
    if (this.#options.accepting && !this.#options.accepting()) return;
    this.#options.journal('plugin_hook_failed', { plugin, hook });
  };

  #notDispatched(call: ScheduledToolCall, tool: Tool | undefined, reason: NotDispatchedReason): ToolResult {
    const result: ToolResult = { ok: false, code: 'CANCELLED',
      message: reason === 'tool_call_limit' ? 'Tool-call limit reached before this call was dispatched'
        : reason === 'batch_failed' ? 'An earlier call in this turn failed; this call was not dispatched'
          : 'Task stopped before this call was dispatched', effect: 'none' };
    if (!this.#options.accepting || this.#options.accepting())
      this.#options.journal('tool_not_dispatched', { id: call.id, name: call.name, reason, effect: 'none' }, { call, effect: tool?.effect, idempotencyKey: this.#key(call.id), result });
    if (reason === 'cancelled') this.#cancelled(this.#hookCall(call, tool, call.arguments, this.#key(call.id)), { dispatched: false, effect: 'none' });
    return result;
  }

  #cancelled(call: ArdentToolCall, outcome: { dispatched: boolean; effect: 'none' | 'unknown' }): void {
    const { plugins, pluginContext } = this.#options;
    if (!plugins?.some(plugin => plugin.toolCallCancelled) || !pluginContext) return;
    // One call's callbacks finish before the next call's start, in the order calls were stopped.
    const done = this.#hookChain.then(() => runPluginObservers(plugins, 'toolCallCancelled',
      plugin => plugin.toolCallCancelled?.(pluginContext, call, frozenCopy(outcome)), this.#failure, { reverse: true }));
    this.#hookChain = done;
    this.#hooks.add(done);
    void done.finally(() => this.#hooks.delete(done));
  }

  #abort(): void {
    this.#close('cancelled');
    // A started call keeps its uncertainty: only a read is known to have no effect.
    for (const entry of this.#inFlight) this.#cancelled(entry.call, { dispatched: true, effect: entry.tool?.effect === 'read' ? 'none' : 'unknown' });
  }

  #close(reason: NotDispatchedReason): void {
    this.#closed ??= reason;
    for (const waiter of this.#queue.splice(0)) waiter.reject(this.#closed);
  }

  #acquire(parallel: boolean): Promise<void> {
    if (this.#closed) return Promise.reject(this.#closed);
    return new Promise<void>((resolve, reject) => { this.#queue.push({ parallel, resolve, reject }); this.#drain(); });
  }

  #drain(): void {
    for (;;) {
      const next = this.#queue[0];
      if (!next || this.#exclusive) return;
      if (next.parallel) { if (this.#shared >= this.#limit) return; this.#shared++; }
      else { if (this.#shared > 0) return; this.#exclusive = true; }
      this.#queue.shift();
      next.resolve();
    }
  }

  #release(parallel: boolean): void {
    if (parallel) this.#shared--; else this.#exclusive = false;
    this.#drain();
  }
}
