import { z } from 'zod';
import { ToolResultSchema } from './tools.js';

export const BackendEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started'), backend: z.enum(['llamacpp', 'codex']) }).strict(),
  z.object({ kind: z.literal('text_delta'), backend: z.enum(['llamacpp', 'codex']), text: z.string() }).strict(),
  z.object({ kind: z.literal('tool_result'), backend: z.enum(['llamacpp', 'codex']), name: z.string(), result: ToolResultSchema }).strict(),
  z.object({ kind: z.literal('completed'), backend: z.enum(['llamacpp', 'codex']), output_chars: z.number().int().nonnegative(), tool_calls: z.number().int().nonnegative(), reasoning_chars: z.number().int().nonnegative(), usage: z.object({ promptTokens: z.number().optional(), completionTokens: z.number().optional() }).nullable() }).strict()
]);
export type BackendEvent = z.infer<typeof BackendEventSchema>;
export type BackendEventSink = (event: BackendEvent) => void;
