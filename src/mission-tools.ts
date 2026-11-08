import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { ArtifactMimeSchema, type ArtifactManifests, type ArtifactRecord } from './artifact-manifests.js';
import { formatBytes } from './artifacts.js';
import { DevelopmentNoteInput, type DevelopmentRecords } from './development.js';
import { MAX_RENDER_SOURCE_CHARS, renderDocx, renderPdf } from './document-render.js';
import type { Task, TaskStore } from './store.js';
import { defineTool, ProvenNoEffectError, type ToolContext, type ToolRegistry } from './tools.js';

/** Tools a mission may be granted with a `tool:<name>` resource. */
export const MISSION_TOOL_NAMES = ['team_handoff', 'team_ask_user', 'team_propose_decision', 'artifact_write', 'development_note', 'document_render'] as const;
export type MissionToolName = typeof MISSION_TOOL_NAMES[number];

export type MissionToolDeps = {
  task: Task; store: TaskStore; artifacts: ArtifactManifests; development: DevelopmentRecords;
  /** Directory `artifact_write.workspace_path` resolves inside (the profile's `workspace`). */
  workspaceDir: string;
};

const safeName = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/, 'Use 1-128 letters, digits, dots, dashes or underscores');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const line = (max: number) => z.string().trim().min(1).max(max);
const Recorded = z.object({ recorded: z.literal(true), event: z.string(), note: z.string() }).strict();
const Registered = z.object({ artifact_id: z.string(), sha256: digest, reference: z.string(), name: z.string(), mime: z.string(),
  size: z.number().int(), revision: z.number().int(), supersedes_sha256: digest.nullable() }).strict();

function registered(record: ArtifactRecord): z.infer<typeof Registered> {
  const manifest = record.manifest;
  return { artifact_id: manifest.artifact_id, sha256: manifest.sha256, reference: `ardent-artifact:${manifest.sha256}`, name: manifest.name,
    mime: manifest.mime, size: manifest.size, revision: manifest.revision, supersedes_sha256: manifest.supersedes_sha256 };
}

/** Read a regular file inside the workspace without following a final symlink. */
async function readWorkspaceFile(workspaceDir: string, path: string, maxBytes: number): Promise<Uint8Array> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new ProvenNoEffectError('workspace_path must be relative to the workspace', 'INVALID_PATH');
  let root: string;
  let target: string;
  try { root = await realpath(workspaceDir); target = await realpath(join(workspaceDir, path)); }
  catch { throw new ProvenNoEffectError('workspace_path does not exist', 'NOT_FOUND'); }
  const inside = relative(root, target);
  if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) throw new ProvenNoEffectError('workspace_path escapes the workspace', 'INVALID_PATH');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new ProvenNoEffectError('workspace_path is not a regular file', 'INVALID_PATH');
    if (stat.size > maxBytes) throw new ProvenNoEffectError(`Artifact exceeds ${formatBytes(maxBytes)}`, 'ARTIFACT_TOO_LARGE');
    return await file.readFile();
  } finally { await file.close(); }
}

/** `development_note`: a durable note about how the agent works. Direct tasks always have it; missions need `tool:development_note`. */
export function registerDevelopmentNoteTool(registry: ToolRegistry, deps: MissionToolDeps, contexts: readonly ToolContext[]): void {
  registry.register(defineTool({ name: 'development_note', description: 'Record a durable note about your own development: what you learned, how you work best, or a method you changed. Kinds such as self_understanding, method, lesson. Do not store secrets.',
    input: DevelopmentNoteInput, output: z.object({ id: z.string(), kind: z.string(), title: z.string() }).strict(),
    effect: 'artifact-write', contexts, timeoutMs: 5_000, handler: async input => {
      const record = deps.development.add({ ...input, author: 'agent', epistemic: 'agent_reported', taskId: deps.task.id });
      return { id: record.id, kind: record.kind, title: record.title };
    } }));
}

/**
 * Register the mission tools a mission grants. Coordination tools only record a
 * journal event: Ardent never acts on a handoff, question or proposal itself.
 */
export function registerMissionTools(registry: ToolRegistry, deps: MissionToolDeps, granted: ReadonlySet<string>): void {
  const has = (name: MissionToolName) => granted.has(`tool:${name}`);
  const record = (event: string, detail: unknown, note: string) => {
    deps.store.append(deps.task.id, event, detail);
    return { recorded: true as const, event, note };
  };
  const maxBytes = deps.artifacts.artifacts.maxBytes;
  if (has('team_handoff')) registry.register(defineTool({ name: 'team_handoff', description: 'Ask the team coordinator to hand work to another team role. This records the request; the coordinator decides whether to start it.',
    input: z.object({ to_role: line(128), objective: line(4000), deliverables: z.array(line(500)).max(16).optional(), note: line(2000).optional() }).strict(),
    output: Recorded, effect: 'artifact-write', contexts: ['mission'], timeoutMs: 5_000,
    handler: async input => record('team_handoff', input, 'Handoff request recorded for the coordinator. Ardent does not start other agents; continue or finish your turn.') }));
  if (has('team_ask_user')) registry.register(defineTool({ name: 'team_ask_user', description: 'Ask the user a question you cannot answer from the mission or tools. Your turn ends after this call and the task finishes as input_required.',
    input: z.object({ question: line(1200), options: z.array(line(300)).max(8).optional() }).strict(),
    output: Recorded, effect: 'artifact-write', contexts: ['mission'], timeoutMs: 5_000,
    handler: async input => record('team_ask_user', input, 'Question recorded. Finish now with one short sentence for the user; the task ends as input_required.') }));
  if (has('team_propose_decision')) registry.register(defineTool({ name: 'team_propose_decision', description: 'Propose a team decision for the user to accept. This records the proposal; only the user decides.',
    input: z.object({ title: line(200), statement: line(4000), rationale: line(4000).optional() }).strict(),
    output: Recorded, effect: 'artifact-write', contexts: ['mission'], timeoutMs: 5_000,
    handler: async input => record('team_propose_decision', input, 'Decision proposal recorded for the user.') }));
  if (has('artifact_write')) registry.register(defineTool({ name: 'artifact_write', description: `Save a deliverable file (Markdown, text, JSON, CSV, SVG, PNG, JPEG, WebP, PDF or DOCX; at most ${formatBytes(maxBytes)}). Give exactly one of text, base64 or workspace_path. Set revises_sha256 to replace an earlier version.`,
    input: z.object({ name: safeName, mime: ArtifactMimeSchema, text: z.string().min(1).max(maxBytes).optional(),
      base64: z.string().min(1).max(Math.ceil(maxBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional(),
      workspace_path: line(512).optional(), revises_sha256: digest.optional() }).strict()
      .refine(value => [value.text, value.base64, value.workspace_path].filter(item => item !== undefined).length === 1, 'Give exactly one of text, base64 or workspace_path'),
    output: Registered, effect: 'artifact-write', contexts: ['mission'], timeoutMs: 30_000, handler: async input => {
      const bytes = input.text !== undefined ? Buffer.from(input.text, 'utf8')
        : input.base64 !== undefined ? Buffer.from(input.base64, 'base64')
          : await readWorkspaceFile(deps.workspaceDir, input.workspace_path ?? '', maxBytes);
      return registered(await deps.artifacts.register({ taskId: deps.task.id, name: input.name, mime: input.mime, bytes,
        source: 'artifact_write', revisesSha256: input.revises_sha256 }));
    } }));
  if (has('development_note')) registerDevelopmentNoteTool(registry, deps, ['mission']);
  if (has('document_render')) registry.register(defineTool({ name: 'document_render', description: 'Render Markdown to a PDF or DOCX deliverable and save it as an artifact. ```svg blocks become vector figures in PDF only; images are embedded in DOCX only from PNG or JPEG data: URIs.',
    input: z.object({ source_markdown: z.string().min(1).max(MAX_RENDER_SOURCE_CHARS), format: z.enum(['pdf', 'docx']), name: safeName, revises_sha256: digest.optional() }).strict(),
    output: Registered, effect: 'artifact-write', contexts: ['mission'], timeoutMs: 60_000, handler: async input => {
      const extension = `.${input.format}`;
      const name = input.name.toLowerCase().endsWith(extension) ? input.name : `${input.name.slice(0, 128 - extension.length)}${extension}`;
      const title = name.slice(0, -extension.length);
      const bytes = input.format === 'pdf' ? await renderPdf(input.source_markdown, title) : await renderDocx(input.source_markdown, title);
      return registered(await deps.artifacts.register({ taskId: deps.task.id, name,
        mime: input.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes, source: 'document_render', revisesSha256: input.revises_sha256 }));
    } }));
}
