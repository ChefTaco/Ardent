import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

const Model = z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/);
const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export const ModelPolicySchema = z.object({
  schema_version: z.literal(1),
  revision: z.number().int().positive(),
  primary: z.object({
    codex: z.object({ model: Model, reasoning_effort: Effort }).strict(),
    llamacpp: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('profile') }).strict(),
      z.object({ mode: z.literal('policy'), model: Model }).strict()
    ])
  }).strict(),
  compaction: z.object({
    enabled: z.boolean(),
    routes: z.array(z.object({ backend: z.literal('codex'), model: Model, reasoning_effort: Effort }).strict()).min(1).max(2),
    prompt_budget_tokens: z.number().int().min(8192).max(250000),
    output_reserve_tokens: z.number().int().min(1024).max(32768),
    checkpoint_max_tokens: z.number().int().min(512).max(12000),
    recent_max_tokens: z.number().int().min(1024).max(32000),
    trigger_ratio: z.number().min(0.5).max(0.9)
  }).strict(),
  /** Accepted for compatibility with older policy files; Ardent itself does not read it. */
  coding: z.object({ model: Model, reasoning_effort: Effort }).strict().optional()
}).strict().superRefine((value, ctx) => {
  if (new Set(value.compaction.routes.map(route => route.model)).size !== value.compaction.routes.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['compaction', 'routes'], message: 'Compaction route models must differ' });
  if (value.compaction.output_reserve_tokens + value.compaction.checkpoint_max_tokens + value.compaction.recent_max_tokens >= value.compaction.prompt_budget_tokens)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['compaction'], message: 'Compaction reserves exceed the prompt budget' });
});
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;
export type LoadedModelPolicy = { policy: ModelPolicy; sha256: string; path: string };

export function modelPolicyPath(profileDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.ARDENT_HOME ? resolve(env.ARDENT_HOME) : dirname(dirname(resolve(profileDir)));
  return join(home, 'model-policy', 'active.json');
}

export function parseModelPolicy(bytes: string): { policy: ModelPolicy; sha256: string } {
  if (Buffer.byteLength(bytes) > 64 * 1024) throw new Error('Model policy exceeds 64 KiB');
  const policy = ModelPolicySchema.parse(JSON.parse(bytes) as unknown);
  return { policy, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function loadModelPolicy(profileDir: string, env: NodeJS.ProcessEnv = process.env): Promise<LoadedModelPolicy | null> {
  const path = modelPolicyPath(profileDir, env);
  const stat = await lstat(path).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 || (stat.mode & 0o077) !== 0)
    throw new Error('Model policy must be an owner-only regular file');
  return { ...parseModelPolicy(await readFile(path, 'utf8')), path };
}
