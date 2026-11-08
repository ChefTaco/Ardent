import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { createArdentApi } from '../src/api.js';
import { ArtifactManifestSchema } from '../src/artifact-manifests.js';
import { registerMissionTools } from '../src/mission-tools.js';
import { markdownToPdfContent } from '../src/document-render.js';
import { ToolRegistry } from '../src/tools.js';
import { MISSION_TOOL_NAMES } from '../src/mission-tools.js';
import { initTestProfile } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture(maxBytes?: number) {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-artifacts-'));
  dirs.push(dir);
  await initTestProfile(dir);
  const loaded = await loadConfig(dir);
  loaded.config.research.enabled = false;
  if (maxBytes) loaded.config.artifacts.max_bytes = maxBytes;
  const runtime = new ArdentRuntime(dir, loaded.config, {});
  const task = runtime.accept('Produce deliverables', 'management', 'mission');
  const tools = new ToolRegistry();
  registerMissionTools(tools, { task, store: runtime.store, artifacts: runtime.artifactManifests, development: runtime.development,
    workspaceDir: join(dir, 'workspace') }, new Set(MISSION_TOOL_NAMES.map(name => `tool:${name}`)));
  const call = (name: string, args: unknown) => tools.call(name, args, 'mission', new AbortController().signal);
  return { dir, loaded, runtime, task, call };
}

describe('artifact store configuration', () => {
  it('defaults to 2 MiB and allows at most 64 MiB', () => {
    const base = 'schema_version: 1\nprofile: assistant\nname: Assistant\nexecution: { backend: llamacpp, max_model_steps: 1, max_tool_calls: 0, max_parallel_tools: 1, deadline_seconds: 10, max_delegation_depth: 0 }\nproviders:\n  llamacpp: { base_url: "http://127.0.0.1:1/", model: m, api_key_env: K, request_timeout_seconds: 5 }\n  codex: { command: codex, model: m, approval_policy: never, sandbox: read-only }\n';
    expect(parseConfig(base).artifacts.max_bytes).toBe(2 * 1024 * 1024);
    expect(parseConfig(`${base}artifacts: { max_bytes: 67108864 }\n`).artifacts.max_bytes).toBe(64 * 1024 * 1024);
    expect(() => parseConfig(`${base}artifacts: { max_bytes: 67108865 }\n`)).toThrow(/artifacts\.max_bytes/);
  });
});

describe('artifact_write', () => {
  it('enforces the size limit and the media type allowlist with no effect', async () => {
    const { runtime, task, call } = await fixture(4096);
    try {
      const big = await call('artifact_write', { name: 'big.txt', mime: 'text/plain', base64: Buffer.alloc(4097, 97).toString('base64') });
      expect(big).toMatchObject({ ok: false, effect: 'none' });
      expect(await call('artifact_write', { name: 'x.gif', mime: 'image/gif', text: 'GIF89a' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
      expect(await call('artifact_write', { name: 'x.png', mime: 'image/png', text: 'not a png' })).toMatchObject({ ok: false, code: 'INVALID_ARTIFACT', effect: 'none' });
      expect(await call('artifact_write', { name: 'x.json', mime: 'application/json', text: '{oops' })).toMatchObject({ ok: false, code: 'INVALID_ARTIFACT' });
      expect(await call('artifact_write', { name: 'two.md', mime: 'text/markdown', text: '# a', base64: 'IyBh' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
      expect(await call('artifact_write', { name: 'x.png', mime: 'image/png', base64: png.toString('base64') })).toMatchObject({ ok: true });
      expect(runtime.artifactManifests.forTask(task.id)).toHaveLength(1);
    } finally { runtime.close(); }
  });

  it('records full manifests and supersession through revises_sha256', async () => {
    const { runtime, task, call, loaded } = await fixture();
    const app = createArdentApi(runtime, loaded, { ARDENT_API_TOKEN: 'fixture-token' });
    const headers = { Authorization: 'Bearer fixture-token' };
    try {
      const first = await call('artifact_write', { name: 'chapter.md', mime: 'text/markdown', text: '# One' });
      if (!first.ok) throw new Error(first.message);
      const firstSha = (first.value as { sha256: string }).sha256;
      expect(await call('artifact_write', { name: 'chapter.md', mime: 'text/markdown', text: '# One', revises_sha256: firstSha })).toMatchObject({ ok: false, code: 'INVALID_ARTIFACT' });
      expect(await call('artifact_write', { name: 'chapter.md', mime: 'text/markdown', text: '# Two', revises_sha256: 'b'.repeat(64) })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      const second = await call('artifact_write', { name: 'chapter.md', mime: 'text/markdown', text: '# One, revised', revises_sha256: firstSha });
      expect(second).toMatchObject({ ok: true, value: { revision: 2, supersedes_sha256: firstSha } });
      const records = runtime.artifactManifests.forTask(task.id);
      expect(records.map(record => record.manifest.revision)).toEqual([1, 2]);
      for (const record of records) ArtifactManifestSchema.parse(record.manifest);
      expect(records[0]!.superseded_by_sha256).toBe(records[1]!.manifest.sha256);
      expect(records[1]).toMatchObject({ task_id: task.id, superseded_by_sha256: null, manifest: { acceptance_status: 'unreviewed', visibility: 'private',
        preview: { mode: 'inline', mime: 'text/markdown' }, provenance: { producer: 'ardent:assistant', source_id: 'artifact_write', producer_task_id: task.id } } });
      const events = runtime.store.events(task.id).filter(event => event.kind === 'artifact_registered');
      expect(events).toHaveLength(2);
      const listed = await app.request(`/api/v1/tasks/${task.id}/artifacts`, { headers });
      expect((await listed.json() as { artifacts: unknown[] }).artifacts).toHaveLength(2);
      const manifest = await app.request(`/api/v1/artifacts/${firstSha}/manifest`, { headers });
      expect(await manifest.json()).toMatchObject({ superseded_by_sha256: records[1]!.manifest.sha256, manifest: { sha256: firstSha } });
      expect((await app.request(`/api/v1/artifacts/${'c'.repeat(64)}/manifest`, { headers })).status).toBe(404);
      expect((await app.request('/api/v1/tasks/absent/artifacts', { headers })).status).toBe(404);
      expect(() => runtime.store.db.prepare('UPDATE artifact_manifests SET name=?').run('x')).toThrow(/immutable/);
    } finally { runtime.close(); }
  });

  it('reads workspace files without escaping the workspace', async () => {
    const { dir, runtime, call } = await fixture();
    try {
      await mkdir(join(dir, 'workspace', 'out'), { recursive: true });
      await writeFile(join(dir, 'workspace', 'out', 'table.csv'), 'a,b\n1,2\n');
      await writeFile(join(dir, 'secret.txt'), 'outside');
      await symlink(join(dir, 'secret.txt'), join(dir, 'workspace', 'link.txt'));
      expect(await call('artifact_write', { name: 'table.csv', mime: 'text/csv', workspace_path: 'out/table.csv' })).toMatchObject({ ok: true, value: { size: 8 } });
      expect(await call('artifact_write', { name: 'x.txt', mime: 'text/plain', workspace_path: '../secret.txt' })).toMatchObject({ ok: false, code: 'INVALID_PATH', effect: 'none' });
      expect(await call('artifact_write', { name: 'x.txt', mime: 'text/plain', workspace_path: 'link.txt' })).toMatchObject({ ok: false, code: 'INVALID_PATH' });
      expect(await call('artifact_write', { name: 'x.txt', mime: 'text/plain', workspace_path: join(dir, 'secret.txt') })).toMatchObject({ ok: false, code: 'INVALID_PATH' });
    } finally { runtime.close(); }
  });
});

describe('document_render', () => {
  it('renders Markdown to PDF and reports DOCX as unavailable with no effect', async () => {
    const { runtime, task, call } = await fixture();
    try {
      const pdf = await call('document_render', { source_markdown: '# Report\n\nSome **bold** text.\n\n- one\n- two\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>\n```\n', format: 'pdf', name: 'report' });
      expect(pdf).toMatchObject({ ok: true, value: { name: 'report.pdf', mime: 'application/pdf' } });
      const sha = (pdf as { value: { sha256: string } }).value.sha256;
      expect(Buffer.from(await runtime.artifacts.get(sha)).subarray(0, 5).toString()).toBe('%PDF-');
      expect(runtime.artifactManifests.forTask(task.id)[0]!.manifest).toMatchObject({ preview: { mode: 'download_only' }, provenance: { source_id: 'document_render' } });
      expect(await call('document_render', { source_markdown: '# Report', format: 'docx', name: 'report' }))
        .toEqual({ ok: false, code: 'DOCX_UNAVAILABLE', message: 'DOCX rendering is not available in this build', effect: 'none' });
    } finally { runtime.close(); }
  });

  it('maps Markdown blocks to document content', () => {
    const content = markdownToPdfContent('## Title\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n1. first\n2. second\n\n> quoted\n\n---\n\n[site](https://example.com) and ![alt](https://example.com/x.png)');
    expect(content).toHaveLength(6);
    expect(content[1]).toMatchObject({ table: { headerRows: 1, body: [[{ bold: true }, { bold: true }], [{}, {}]] } });
    expect(content[2]).toMatchObject({ ol: [{}, {}] });
    expect(JSON.stringify(content[5])).toContain('"link":"https://example.com"');
    expect(JSON.stringify(content[5])).not.toContain('x.png');
  });
});

describe('development_note', () => {
  it('stores immutable agent-reported records', async () => {
    const { runtime, call } = await fixture();
    try {
      expect(await call('development_note', { kind: 'self_understanding', title: 'Pacing', body: 'I write better after an outline.', sources: [{ kind: 'url', ref: 'https://example.com/notes' }] }))
        .toMatchObject({ ok: true, value: { kind: 'self_understanding', title: 'Pacing' } });
      const [record] = runtime.development.list();
      expect(record).toMatchObject({ agent_ref: 'assistant', author: 'agent', epistemic: 'agent_reported', before_sha256: null });
      expect(record!.sources.map(source => source.kind)).toEqual(['task', 'url']);
      expect(() => runtime.store.db.prepare('DELETE FROM development_records').run()).toThrow(/immutable/);
      expect(await call('development_note', { kind: 'Bad Kind', title: 'x', body: 'y' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    } finally { runtime.close(); }
  });
});
