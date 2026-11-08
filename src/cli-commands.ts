import { z } from 'zod';
import { MissionSubmit } from './missions.js';
import { PreviewSubmit } from './preview.js';
import { DevelopmentKind } from './development.js';

/** Options as parsed by the CLI: `--name value` or a bare `--flag`. */
export type CliOptions = ReadonlyMap<string, string | true>;
type ReadText = (path: string) => Promise<string>;

function option(options: CliOptions, name: string): string | undefined {
  const found = options.get(name);
  return typeof found === 'string' ? found : undefined;
}

/**
 * `ardent mission submit --mission-file FILE [--prompt TEXT] [--idempotency-key KEY] [--session-id UUID]`.
 * The file holds a `POST /api/v1/missions` body; flags replace its objective, key and session.
 */
export async function missionSubmitInput(options: CliOptions, read: ReadText): Promise<MissionSubmit> {
  const file = option(options, 'mission-file');
  if (!file) throw new Error('Use mission submit --mission-file FILE [--prompt TEXT] [--idempotency-key KEY]');
  const text = await read(file);
  if (Buffer.byteLength(text) > 200 * 1024) throw new Error('Mission file exceeds 200 KiB');
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { throw new Error('Mission file must be JSON'); }
  const body = z.record(z.string(), z.unknown()).parse(value);
  const prompt = option(options, 'prompt');
  const key = option(options, 'idempotency-key');
  const session = option(options, 'session-id');
  const parsed = MissionSubmit.safeParse({ ...body, ...(prompt ? { objective: prompt } : {}), ...(key ? { idempotency_key: key } : {}),
    ...(session ? { session_id: session } : {}) });
  if (!parsed.success) throw new Error(`Invalid mission: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}

/**
 * `ardent preview --prompt TEXT [--soul-file FILE] [--identity-file FILE] [--skills a,b | --no-skills] [--model NAME]`.
 * Override files are read only to build the preview; the profile is not changed.
 */
export async function previewInput(options: CliOptions, read: ReadText): Promise<PreviewSubmit> {
  const prompt = option(options, 'prompt');
  if (!prompt) throw new Error('Use preview --prompt TEXT [--soul-file FILE] [--identity-file FILE] [--skills a,b] [--model NAME]');
  const soulFile = option(options, 'soul-file');
  const identityFile = option(options, 'identity-file');
  const skills = option(options, 'skills');
  const model = option(options, 'model');
  const parsed = PreviewSubmit.safeParse({ prompt, overrides: {
    ...(soulFile ? { soul: await read(soulFile) } : {}),
    ...(identityFile ? { identity: await read(identityFile) } : {}),
    ...(skills !== undefined ? { skills_enabled: skills.split(',').map(item => item.trim()).filter(Boolean) } : options.has('no-skills') ? { skills_enabled: [] } : {}),
    ...(model ? { model } : {})
  } });
  if (!parsed.success) throw new Error(`Invalid preview: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}

/** `ardent development list [--after CURSOR] [--limit N] [--kind KIND]`. */
export function developmentQuery(options: CliOptions): { after?: string; limit?: number; kind?: string } {
  const after = option(options, 'after');
  const limit = option(options, 'limit');
  const kind = option(options, 'kind');
  if (limit !== undefined && !/^\d{1,3}$/.test(limit)) throw new Error('--limit must be a number from 1 to 200');
  const parsed = z.object({ after: z.string().min(1).max(400).optional(), limit: z.number().int().min(1).max(200).optional(), kind: DevelopmentKind.optional() })
    .safeParse({ after, limit: limit === undefined ? undefined : Number(limit), kind });
  if (!parsed.success) throw new Error('Use development list [--after CURSOR] [--limit 1-200] [--kind KIND]');
  return { ...(parsed.data.after ? { after: parsed.data.after } : {}), ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
    ...(parsed.data.kind ? { kind: parsed.data.kind } : {}) };
}
