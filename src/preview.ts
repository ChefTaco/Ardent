import { z } from 'zod';
import type { Task, TaskStore } from './store.js';

/** Artifacts a preview produces expire after this long. */
export const PREVIEW_ARTIFACT_TTL_SECONDS = 24 * 3600;
const PREVIEW_EVENT = 'preview';

/** Unsaved changes to try out. Nothing here is written to the profile. */
export const PreviewOverrides = z.object({
  soul: z.string().min(1).max(128 * 1024).optional(),
  identity: z.string().min(1).max(128 * 1024).optional(),
  skills_enabled: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)).max(100).optional(),
  model: z.string().trim().min(1).max(200).optional()
}).strict();
export type PreviewOverrides = z.infer<typeof PreviewOverrides>;
export const PreviewSubmit = z.object({
  prompt: z.string().trim().min(1).max(16000),
  overrides: PreviewOverrides.default({}),
  session_id: z.string().guid().optional(),
  idempotency_key: z.string().min(1).max(128).optional()
}).strict();
export type PreviewSubmit = z.infer<typeof PreviewSubmit>;

/** Accept a preview task; its overrides are journaled atomically with it. */
export function acceptPreview(accept: (input: { prompt: string; sessionId?: string; idempotencyKey?: string; content: unknown;
  onAccepted: (task: Task) => void }) => Task, store: TaskStore, input: PreviewSubmit): Task {
  const overrides = PreviewOverrides.parse(input.overrides);
  return accept({ prompt: input.prompt, ...(input.session_id ? { sessionId: input.session_id } : {}),
    ...(input.idempotency_key ? { idempotencyKey: input.idempotency_key } : {}), content: { overrides },
    onAccepted: task => store.append(task.id, PREVIEW_EVENT, { overrides }) });
}

/** The overrides a preview task was accepted with. */
export function previewOverrides(store: TaskStore, taskId: string): PreviewOverrides {
  const row: unknown = store.db.prepare('SELECT detail_json FROM events WHERE task_id=? AND kind=? ORDER BY sequence LIMIT 1').get(taskId, PREVIEW_EVENT);
  if (!row) return {};
  return z.object({ overrides: PreviewOverrides }).parse(JSON.parse(z.object({ detail_json: z.string() }).parse(row).detail_json) as unknown).overrides;
}
