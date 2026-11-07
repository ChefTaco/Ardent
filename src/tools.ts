import { z } from 'zod';
import { toJsonSchema } from './json-schema.js';

export type ToolContext = 'direct' | 'peer' | 'scheduled';
export type ToolEffect = 'read' | 'artifact-write' | 'memory-write' | 'external-write';
/** Constructed only by first-party code after proving that an effect did not open. */
export class ProvenNoEffectError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}
export const ToolResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown().optional() }).strict(),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string(), effect: z.enum(['none', 'unknown']) }).strict()
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

export interface Tool {
  name: string;
  description: string;
  input: z.ZodType<unknown>;
  output: z.ZodType<unknown>;
  effect: ToolEffect;
  contexts: readonly ToolContext[];
  timeoutMs: number;
  invoke(input: unknown, signal: AbortSignal): Promise<unknown>;
}

export function defineTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(definition: {
  name: string; description: string; input: I; output: O; effect: ToolEffect;
  contexts: readonly ToolContext[]; timeoutMs: number;
  handler: (input: z.infer<I>, signal: AbortSignal) => Promise<z.infer<O>>;
}): Tool {
  return { ...definition, invoke: async (input: unknown, signal: AbortSignal) => definition.handler(definition.input.parse(input), signal) };
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();
  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.#tools.set(tool.name, tool);
  }
  list(context: ToolContext): Tool[] { return [...this.#tools.values()].filter(tool => tool.contexts.includes(context)); }
  schemas(context: ToolContext): object[] {
    return this.list(context).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: toJsonSchema(tool.input, 'openapi-3.0') } }));
  }
  async call(name: string, args: unknown, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    const tool = this.#tools.get(name);
    if (!tool || !tool.contexts.includes(context)) return { ok: false, code: 'TOOL_DENIED', message: 'Tool is unavailable in this context', effect: 'none' };
    const parsed = tool.input.safeParse(args);
    if (!parsed.success) return { ok: false, code: 'INVALID_ARGUMENT', message: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), effect: 'none' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), tool.timeoutMs);
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) controller.abort();
      const value = await tool.invoke(parsed.data, controller.signal);
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
