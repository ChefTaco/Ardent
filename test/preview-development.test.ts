import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type LoadedConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { createArdentApi } from '../src/api.js';
import { decodeDevelopmentCursor, DevelopmentRecordSchema, encodeDevelopmentCursor } from '../src/development.js';
import { developmentQuery, missionSubmitInput, previewInput } from '../src/cli-commands.js';
import { initTestProfile } from './helpers.js';

type ModelRequest = { model: string; messages: Array<{ role: string; content: string | null }>; tools?: Array<{ function: { name: string } }> };
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function read(request: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return text;
}
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return `http://127.0.0.1:${address.port}/`;
}

async function setup(edit?: (loaded: LoadedConfig) => void, env: NodeJS.ProcessEnv = {}) {
  const requests: ModelRequest[] = [];
  const url = await listen(createServer((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    void read(request).then(text => {
      requests.push(JSON.parse(text) as ModelRequest);
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Previewed reply.' } }] })}\n\ndata: [DONE]\n\n`);
    });
  }));
  const dir = await mkdtemp(join(tmpdir(), 'ardent-preview-'));
  dirs.push(dir);
  await initTestProfile(dir);
  const loaded = await loadConfig(dir);
  loaded.config.providers.llamacpp.base_url = url;
  loaded.config.providers.llamacpp.model = 'fixture';
  loaded.config.research.enabled = false;
  edit?.(loaded);
  const runtime = new ArdentRuntime(dir, loaded.config, env);
  const app = createArdentApi(runtime, loaded, { ARDENT_API_TOKEN: 'fixture-token', ...env });
  const headers = { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' };
  return { dir, runtime, app, headers, requests };
}

async function waitDone(runtime: ArdentRuntime, id: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (!['queued', 'running'].includes(runtime.store.get(id)?.state ?? 'queued')) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Task did not finish');
}

describe('preview tasks', () => {
  it('apply overrides for one task without side effects', async () => {
    const hivemem: string[] = [];
    const memoryUrl = await listen(createServer((request, response) => {
      hivemem.push(`${request.method} ${request.url}`);
      response.setHeader('Content-Type', 'application/json');
      response.end(request.url === '/v1/capabilities' ? JSON.stringify({ retrieval: 'lexical', storage: 'sqlite' }) : JSON.stringify({ results: [] }));
    }));
    const { dir, runtime, app, headers, requests } = await setup(loaded => {
      loaded.config.memory = { provider: 'hivemem', base_url: memoryUrl, token_env: 'HIVEMEM_TOKEN', agent_id: 'assistant', workspace_id: 'ws-1', default_scope: 'private' };
    }, { HIVEMEM_TOKEN: 'fixture-token' });
    try {
      const soulBefore = await readFile(join(dir, 'SOUL.md'), 'utf8');
      const configBefore = await readFile(join(dir, 'config.yaml'), 'utf8');
      const session = await (await app.request('/api/v1/sessions', { method: 'POST', headers, body: JSON.stringify({ key: 'try', context: 'preview' }) })).json() as { id: string };
      const submitted = await app.request('/api/v1/preview/tasks', { method: 'POST', headers, body: JSON.stringify({ prompt: 'Introduce yourself', session_id: session.id,
        overrides: { soul: '# Soul\nYou are a terse lighthouse keeper.', identity: '# Identity\nKeeper of the north light.', skills_enabled: [], model: 'preview-model' } }) });
      expect(submitted.status).toBe(202);
      const { task_id: id } = await submitted.json() as { task_id: string };
      await waitDone(runtime, id);
      const task = runtime.store.get(id)!;
      expect(task).toMatchObject({ context: 'preview', state: 'completed', result: 'Previewed reply.' });
      const request = requests[0]!;
      expect(request.model).toBe('preview-model');
      expect(request.messages[0]!.content).toContain('terse lighthouse keeper');
      expect(request.messages[0]!.content).toContain('Keeper of the north light');
      const offered = (request.tools ?? []).map(tool => tool.function.name);
      expect(offered.filter(name => /^(hivemem_|team_|artifact_write|document_render|development_note)/.test(name))).toEqual([]);
      expect(await readFile(join(dir, 'SOUL.md'), 'utf8')).toBe(soulBefore);
      expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toBe(configBefore);
      await expect(stat(join(dir, 'state', 'identity-history'))).rejects.toThrow();
      expect(runtime.development.list()).toEqual([]);
      expect(hivemem.filter(entry => !entry.startsWith('GET /v1/capabilities') && entry !== 'POST /v1/memories/search')).toEqual([]);
      expect(runtime.store.events(id).some(event => event.kind === 'memory_stored')).toBe(false);
      expect(runtime.store.sessionMessages(session.id, 'management').map(message => message.role)).toEqual(['user', 'assistant']);
      const direct = await (await app.request('/api/v1/sessions', { method: 'POST', headers, body: JSON.stringify({ key: 'chat' }) })).json() as { id: string };
      expect((await app.request('/api/v1/preview/tasks', { method: 'POST', headers, body: JSON.stringify({ prompt: 'x', session_id: direct.id }) })).status).toBe(400);
      expect((await app.request('/api/v1/preview/tasks', { method: 'POST', headers, body: JSON.stringify({ prompt: 'x', overrides: { soul: '' } }) })).status).toBe(400);
    } finally { runtime.close(); }
  });

  it('expires preview artifacts and deletes their bytes unless other work refers to them', async () => {
    const { runtime } = await setup();
    try {
      const preview = runtime.acceptPreview({ prompt: 'Try it', overrides: {} });
      const temporary = await runtime.artifactManifests.register({ taskId: preview.id, name: 'draft.md', mime: 'text/markdown', bytes: Buffer.from('# Draft'), source: 'research', ttlSeconds: 24 * 3600 });
      const shared = await runtime.artifactManifests.register({ taskId: preview.id, name: 'shared.md', mime: 'text/markdown', bytes: Buffer.from('# Shared'), source: 'research', ttlSeconds: 24 * 3600 });
      expect(temporary.manifest.expires_at - temporary.manifest.created_at).toBe(24 * 3600);
      const kept = runtime.accept('Keep it', 'management');
      runtime.store.append(kept.id, 'note', { sha256: shared.manifest.sha256 });
      expect(await runtime.artifactManifests.sweepExpired()).toEqual({ deleted: [], retained: [] });
      const later = Date.now() + 25 * 3600 * 1000;
      const swept = await runtime.artifactManifests.sweepExpired(later);
      expect(swept).toEqual({ deleted: [temporary.manifest.sha256], retained: [shared.manifest.sha256] });
      await expect(runtime.artifacts.get(temporary.manifest.sha256)).rejects.toThrow();
      expect(await runtime.artifacts.get(shared.manifest.sha256)).toBeTruthy();
      expect(await runtime.artifactManifests.sweepExpired(later)).toEqual({ deleted: [], retained: [] });
    } finally { runtime.close(); }
  });
});

describe('development history', () => {
  it('merges notes, skill changes, identity edits and reflections with cursor pagination', async () => {
    const { runtime, app, headers } = await setup();
    try {
      const posted = await app.request('/api/v1/development', { method: 'POST', headers, body: JSON.stringify({ kind: 'lesson', title: 'Ask early', body: 'Clarify scope first.' }) });
      expect(posted.status).toBe(201);
      expect(await posted.json()).toMatchObject({ author: 'operator', epistemic: 'operator_reported', agent_ref: 'assistant' });
      await app.request('/api/v1/development', { method: 'POST', headers, body: JSON.stringify({ kind: 'self_understanding', title: 'Pacing', body: 'Slow is smooth.', author: 'agent' }) });
      const soul = await (await app.request('/api/v1/identity/soul', { headers })).json() as { revision: string };
      const saved = await (await app.request('/api/v1/identity/soul', { method: 'PUT', headers, body: JSON.stringify({ text: '# Soul\nCalmer.', revision: soul.revision }) })).json() as { revision: string };
      const config = await (await app.request('/api/v1/config', { headers })).json() as { revision: string };
      expect((await app.request('/api/v1/skills/grounded-answers', { method: 'PUT', headers, body: JSON.stringify({ enabled: true, revision: config.revision }) })).status).toBe(200);
      const task = runtime.accept('Research', 'management');
      runtime.store.append(task.id, 'method_reflection', { category: 'source_selection', observation: 'Prefer dated originals.', extracted_sources: 1 });
      const seen: Array<{ id: string; kind: string; [key: string]: unknown }> = [];
      let cursor: string | null = null;
      do {
        const page = await (await app.request(`/api/v1/development?limit=2${cursor ? `&after=${cursor}` : ''}`, { headers })).json() as { records: unknown[]; next: string | null };
        expect(page.records.length).toBeLessThanOrEqual(2);
        for (const record of page.records) seen.push(DevelopmentRecordSchema.parse(record));
        cursor = page.next;
      } while (cursor);
      expect(seen.map(record => record.kind).sort()).toEqual(['identity_change', 'lesson', 'method_reflection', 'self_understanding', 'skill_change']);
      expect(new Set(seen.map(record => record.id)).size).toBe(5);
      const times = seen.map(record => Date.parse(String(record.created_at)));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(seen.find(record => record.kind === 'identity_change')).toMatchObject({ before_sha256: soul.revision, after_sha256: saved.revision, epistemic: 'observed' });
      expect(seen.find(record => record.kind === 'skill_change')).toMatchObject({ title: 'Skill grounded-answers enabled', before_sha256: config.revision, author: 'operator' });
      expect(seen.find(record => record.kind === 'self_understanding')).toMatchObject({ author: 'agent', epistemic: 'agent_reported' });
      expect(seen.find(record => record.kind === 'method_reflection')).toMatchObject({ body: 'Prefer dated originals.', sources: [{ kind: 'task', ref: task.id }] });
      const filtered = await (await app.request('/api/v1/development?kind=lesson', { headers })).json() as { records: Array<{ title: string }>; next: string | null };
      expect(filtered).toEqual({ records: [expect.objectContaining({ title: 'Ask early' })], next: null });
      expect((await app.request('/api/v1/development?after=not-a-cursor', { headers })).status).toBe(400);
      expect((await app.request('/api/v1/development?limit=0', { headers })).status).toBe(400);
      expect((await app.request('/api/v1/development', { method: 'POST', headers, body: JSON.stringify({ kind: 'lesson', title: '', body: 'x' }) })).status).toBe(400);
    } finally { runtime.close(); }
  });

  it('encodes cursors losslessly', () => {
    expect(decodeDevelopmentCursor(encodeDevelopmentCursor({ ms: 42, id: 'dev_x' }))).toEqual({ ms: 42, id: 'dev_x' });
    expect(() => decodeDevelopmentCursor('e30')).toThrow(/Invalid development cursor/);
  });
});

describe('CLI command parsing', () => {
  const files = new Map<string, string>([
    ['/m.json', JSON.stringify({ objective: 'From file', idempotency_key: 'file-key', mission: { id: 'm', revision: 1, parent_task: null, constraints: [], allowed_actions: ['observe'],
      resources: ['tool:artifact_write'], deadline: 4102444800, acceptance_criteria: ['Done'], expected_artifacts: [] } })],
    ['/soul.md', '# Soul\nNew'], ['/bad.json', '{']
  ]);
  const readText = async (path: string) => { const text = files.get(path); if (text === undefined) throw new Error('missing'); return text; };
  it('reads a mission file and applies flag overrides', async () => {
    const input = await missionSubmitInput(new Map([['mission-file', '/m.json'], ['prompt', 'From flag'], ['idempotency-key', 'flag-key']]), readText);
    expect(input).toMatchObject({ objective: 'From flag', idempotency_key: 'flag-key', mission: { id: 'm' } });
    await expect(missionSubmitInput(new Map(), readText)).rejects.toThrow(/--mission-file/);
    await expect(missionSubmitInput(new Map([['mission-file', '/bad.json']]), readText)).rejects.toThrow(/JSON/);
    await expect(missionSubmitInput(new Map([['mission-file', '/m.json'], ['session-id', 'nope']]), readText)).rejects.toThrow(/Invalid mission/);
  });
  it('builds preview overrides from files and flags', async () => {
    expect(await previewInput(new Map<string, string | true>([['prompt', 'Hi'], ['soul-file', '/soul.md'], ['skills', 'a, b'], ['model', 'm2']]), readText))
      .toEqual({ prompt: 'Hi', overrides: { soul: '# Soul\nNew', skills_enabled: ['a', 'b'], model: 'm2' } });
    expect((await previewInput(new Map<string, string | true>([['prompt', 'Hi'], ['no-skills', true]]), readText)).overrides).toEqual({ skills_enabled: [] });
    await expect(previewInput(new Map(), readText)).rejects.toThrow(/--prompt/);
  });
  it('validates development list options', () => {
    expect(developmentQuery(new Map([['limit', '20'], ['kind', 'lesson'], ['after', 'abc']]))).toEqual({ limit: 20, kind: 'lesson', after: 'abc' });
    expect(developmentQuery(new Map())).toEqual({});
    expect(() => developmentQuery(new Map([['limit', '500']]))).toThrow(/--limit/);
    expect(() => developmentQuery(new Map([['kind', 'Bad']]))).toThrow(/development list/);
  });
});
