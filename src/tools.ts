import { z } from 'zod';
import type { ExecutionContext } from '@hivemagnus/hive-common/execution';
import { toJsonSchema } from './json-schema.js';
import type { TaskContext } from './store.js';

export type { ExecutionContext } from '@hivemagnus/hive-common/execution';

/** A task context in which a tool may run. Mission tools run only in `mission`. */
export type ToolContext = TaskContext;
export type ToolEffect = 'read' | 'artifact-write' | 'memory-write' | 'external-write';
/** Constructed only by first-party code after proving that an effect did not open. */
export class ProvenNoEffectError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}
/** The task reached `execution.max_tool_calls`; the call was not dispatched. */
export class ToolCallLimitError extends Error {
  constructor(message = 'Tool-call limit reached') { super(message); }
}
export const ToolResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown().optional() }).strict(),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string(), effect: z.enum(['none', 'unknown']) }).strict()
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

/**
 * Per-invocation identity passed to a tool. `idempotencyKey` is
 * `sha256("<taskId>:<callId>")` (hex): stable for one model call, so a tool
 * that forwards it to its service can make a repeated dispatch harmless.
 * `execution` is attribution only and never grants access.
 */
export type ToolInvocationContext = { idempotencyKey: string; execution?: ExecutionContext };
/** Identity a reconciliation hook receives for a call interrupted after dispatch. */
export type ToolReconcileContext = { taskId: string; callId: string; idempotencyKey: string; dispatchedMs: number; execution?: ExecutionContext };
/** What a tool's own service proves about an interrupted call. `unknown` keeps the call held. */
export type ToolReconcileResult = { status: 'applied'; value: unknown } | { status: 'not_applied' } | { status: 'unknown' };
export type ToolConcurrency = 'parallel' | 'serial';

export interface Tool {
  name: string;
  description: string;
  input: z.ZodType<unknown>;
  output: z.ZodType<unknown>;
  effect: ToolEffect;
  contexts: readonly ToolContext[];
  timeoutMs: number;
  /**
   * Repeating the call with identical arguments and idempotency key is safe.
   * Execution recovery re-dispatches an interrupted idempotent call (with the
   * same key) instead of holding it; declare it only when that is true.
   */
  idempotent?: boolean;
  /**
   * Scheduling within one model turn. By default a `read` tool may overlap
   * other parallel-eligible calls and every other effect is serial (a barrier).
   * `parallel` opts a non-read tool in; `serial` keeps a read tool exclusive.
   */
  concurrency?: ToolConcurrency;
  /**
   * Ask the tool's own service what happened to a call interrupted after
   * dispatch (a crash or restart before its result was recorded). Only an
   * outcome the service proves may be `applied` (its `value` must match
   * `output`; it becomes the call's result) or `not_applied` (the model is
   * told, and the call is not retried); anything else, a throw included, is
   * `unknown` and holds the task for an operator. Execution recovery calls it
   * before the task resumes, for a non-idempotent tool with a possible effect.
   */
  reconcile?(input: unknown, ctx: ToolReconcileContext, signal: AbortSignal): Promise<ToolReconcileResult>;
  invoke(input: unknown, signal: AbortSignal, ctx?: ToolInvocationContext): Promise<unknown>;
}

export function defineTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(definition: {
  name: string; description: string; input: I; output: O; effect: ToolEffect;
  contexts: readonly ToolContext[]; timeoutMs: number;
  idempotent?: boolean; concurrency?: ToolConcurrency;
  reconcile?: (input: z.infer<I>, ctx: ToolReconcileContext, signal: AbortSignal) => Promise<ToolReconcileResult>;
  handler: (input: z.infer<I>, signal: AbortSignal, ctx?: ToolInvocationContext) => Promise<z.infer<O>>;
}): Tool {
  const { handler, reconcile, ...rest } = definition;
  return { ...rest,
    ...(reconcile ? { reconcile: async (input: unknown, ctx: ToolReconcileContext, signal: AbortSignal) => reconcile(definition.input.parse(input), ctx, signal) } : {}),
    invoke: async (input: unknown, signal: AbortSignal, ctx?: ToolInvocationContext) => handler(definition.input.parse(input), signal, ctx) };
}

/** Whether a tool may overlap other parallel-eligible calls in one model turn. */
export function toolRunsInParallel(tool: Pick<Tool, 'effect' | 'concurrency'> | undefined): boolean {
  if (!tool) return false;
  return (tool.effect === 'read' && tool.concurrency !== 'serial') || tool.concurrency === 'parallel';
}

/** A call that passed context scoping and argument validation, ready to invoke. */
export type PreparedToolCall = { readonly tool: Tool; readonly input: unknown };

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();
  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.#tools.set(tool.name, tool);
  }
  /** The tool callable in this context, if any. */
  get(name: string, context: ToolContext): Tool | undefined {
    const tool = this.#tools.get(name);
    return tool?.contexts.includes(context) ? tool : undefined;
  }
  list(context: ToolContext): Tool[] { return [...this.#tools.values()].filter(tool => tool.contexts.includes(context)); }
  schemas(context: ToolContext): object[] {
    return this.list(context).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: toJsonSchema(tool.input, 'openapi-3.0') } }));
  }
  /** Scope and validate a call without invoking it. A refusal is a no-effect result. */
  prepare(name: string, args: unknown, context: ToolContext): PreparedToolCall | { result: ToolResult } {
    const tool = this.get(name, context);
    if (!tool) return { result: { ok: false, code: 'TOOL_DENIED', message: 'Tool is unavailable in this context', effect: 'none' } };
    const parsed = tool.input.safeParse(args);
    if (!parsed.success) return { result: { ok: false, code: 'INVALID_ARGUMENT', message: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), effect: 'none' } };
    return { tool, input: parsed.data };
  }
  async call(name: string, args: unknown, context: ToolContext, signal: AbortSignal, ctx?: ToolInvocationContext): Promise<ToolResult> {
    const prepared = this.prepare(name, args, context);
    return 'result' in prepared ? prepared.result : this.invokePrepared(prepared, signal, ctx);
  }
  /** Invoke a call returned by `prepare`, bounded by the tool's timeout and the caller's signal. */
  async invokePrepared({ tool, input }: PreparedToolCall, signal: AbortSignal, ctx?: ToolInvocationContext): Promise<ToolResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), tool.timeoutMs);
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) controller.abort();
      const value = await (ctx ? tool.invoke(input, controller.signal, ctx) : tool.invoke(input, controller.signal));
      return { ok: true, value: tool.output.parse(value) };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Tool failed';
      const domainCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'TOOL_FAILED';
      const provedNoEffect = error instanceof ProvenNoEffectError;
      return { ok: false, code: controller.signal.aborted && !provedNoEffect ? 'CANCELLED_OR_TIMEOUT' : domainCode,
        message, effect: tool.effect === 'read' || provedNoEffect ? 'none' : 'unknown' };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
    }
  }
}
