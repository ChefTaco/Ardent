import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type LoadedConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { createArdentApi } from '../src/api.js';
import { TeamResult } from '../src/team-contract.js';
import { initTestProfile } from './helpers.js';

type ModelRequest = { messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ function: { name: string } }> }>; tools?: Array<{ function: { name: string } }> };
type Turn = { text: string } | { calls: Array<{ name: string; args: unknown }> } | ((request: ModelRequest) => Turn);

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function body(request: IncomingMessage): Promise<string> {
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

/** A llama.cpp fixture that plays scripted turns and records every request. */
async function llama(turns: Turn[]): Promise<{ url: string; requests: ModelRequest[] }> {
  const requests: ModelRequest[] = [];
  const url = await listen(createServer((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    void body(request).then(text => {
      requests.push(JSON.parse(text) as ModelRequest);
      const scripted = turns[requests.length - 1] ?? { text: 'Done.' };
      const turn = typeof scripted === 'function' ? scripted(requests.at(-1)!) : scripted;
      if (typeof turn === 'function') throw new Error('Nested fixture turn');
      response.setHeader('Content-Type', 'text/event-stream');
      if ('text' in turn) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: turn.text } }] })}\n\n`);
      else turn.calls.forEach((call, index) => response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `call-${requests.length}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] })}\n\n`));
      response.end('data: [DONE]\n\n');
    });
  }));
  return { url, requests };
}

async function setup(modelUrl: string, edit?: (loaded: LoadedConfig) => void, env: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-mission-'));
  dirs.push(dir);
  await initTestProfile(dir);
  const loaded = await loadConfig(dir);
  loaded.config.providers.llamacpp.base_url = modelUrl;
  loaded.config.providers.llamacpp.model = 'fixture';
  loaded.config.research.enabled = false;
  edit?.(loaded);
  const runtime = new ArdentRuntime(dir, loaded.config, env);
  const app = createArdentApi(runtime, loaded, { ARDENT_API_TOKEN: 'fixture-token', ...env });
  const headers = { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' };
  return { dir, runtime, app, headers };
}

function mission(overrides: Record<string, unknown> = {}) {
  return { id: 'adventure-1', revision: 1, parent_task: null, constraints: ['Keep it short'], allowed_actions: ['observe', 'analyze', 'create_artifact'],
    resources: ['tool:team_handoff', 'tool:team_propose_decision', 'tool:artifact_write', 'tool:development_note'],
    deadline: Math.floor(Date.now() / 1000) + 600, acceptance_criteria: ['A map exists'], expected_artifacts: [], ...overrides };
}

async function waitDone(runtime: ArdentRuntime, id: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const state = runtime.store.get(id)?.state;
    if (state && !['queued', 'running'].includes(state)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Task did not finish');
}

describe('mission submission', () => {
  it('validates objective, context item and deadline limits and keeps idempotency', async () => {
    const { runtime, app, headers } = await setup('http://127.0.0.1:1/');
    try {
      const post = (value: unknown) => app.request('/api/v1/missions', { method: 'POST', headers, body: JSON.stringify(value) });
      const valid = { objective: 'Draw the map', mission: mission(), idempotency_key: 'm-1' };
      expect((await post({ ...valid, objective: 'x'.repeat(16001) })).status).toBe(400);
      expect((await post({ ...valid, idempotency_key: undefined })).status).toBe(400);
      expect((await post({ ...valid, context_items: [{ title: 'Lore', text: 'x'.repeat(64 * 1024) }] })).status).toBe(400);
      expect((await post({ ...valid, mission: mission({ deadline: Math.floor(Date.now() / 1000) - 1 }) })).status).toBe(400);
      expect((await post({ ...valid, mission: mission({ allowed_actions: ['fly'] }) })).status).toBe(400);
      const session = await (await app.request('/api/v1/sessions', { method: 'POST', headers, body: JSON.stringify({ key: 'chat' }) })).json() as { id: string };
      expect((await post({ ...valid, session_id: session.id })).status).toBe(400);
      // The fixture model is unreachable: the task is accepted, then fails without a model reply.
      const first = await post({ ...valid, context_items: [{ title: 'Lore', text: 'x'.repeat(60 * 1024) }] });
      expect(first.status).toBe(202);
      const { task_id: taskId } = await first.json() as { task_id: string };
      await waitDone(runtime, taskId);
      const again = await post({ ...valid, context_items: [{ title: 'Lore', text: 'x'.repeat(60 * 1024) }] });
      expect((await again.json() as { task_id: string }).task_id).toBe(taskId);
      expect((await post({ ...valid, mission: mission({ revision: 2 }) })).status).toBe(409);
      const task = runtime.store.get(taskId)!;
      expect(task.context).toBe('mission');
      expect(runtime.store.events(taskId).filter(event => event.kind === 'mission')).toHaveLength(1);
    } finally { runtime.close(); }
  });
});

describe('mission execution', () => {
  it('gates tools by mission resources and journals each mission tool', async () => {
    const model = await llama([
      { calls: [
        { name: 'team_handoff', args: { to_role: 'cartographer', objective: 'Ink the coastline', deliverables: ['coast.svg'] } },
        { name: 'team_propose_decision', args: { title: 'Scale', statement: 'Use 1:1000', rationale: 'Fits the table' } },
        { name: 'artifact_write', args: { name: 'map.md', mime: 'text/markdown', text: '# Map\n\nA ford.' } },
        { name: 'development_note', args: { kind: 'method', title: 'Sketch first', body: 'I sketch before inking.' } },
        { name: 'team_ask_user', args: { question: 'Denied?' } }
      ] },
      { text: 'The map is drafted and the coastline is handed off.' }
    ]);
    const { runtime, app, headers } = await setup(model.url);
    try {
      const session = await (await app.request('/api/v1/sessions', { method: 'POST', headers, body: JSON.stringify({ key: 'studio:p1:room:lead', context: 'mission' }) })).json() as { id: string; context: string };
      expect(session.context).toBe('mission');
      const submitted = await app.request('/api/v1/missions', { method: 'POST', headers, body: JSON.stringify({
        session_id: session.id, objective: 'Draw the map', mission: mission(), idempotency_key: 'm-2', labels: { project: 'p1' },
        context_items: [{ title: 'Brief', mime: 'text/markdown', text: 'The river runs north.' }] }) });
      expect(submitted.status).toBe(202);
      const { task_id: taskId } = await submitted.json() as { task_id: string };
      await waitDone(runtime, taskId);
      const offered = model.requests[0]!.tools!.map(tool => tool.function.name).sort();
      expect(offered).toEqual(['artifact_write', 'development_note', 'team_handoff', 'team_propose_decision']);
      expect(JSON.stringify(model.requests[0]!.messages)).toContain('The river runs north.');
      expect(model.requests[0]!.messages.some(message => message.tool_calls?.[0]?.function.name === 'mission_context_item')).toBe(true);
      const task = runtime.store.get(taskId)!;
      expect(task.state).toBe('completed');
      const result = TeamResult.parse(JSON.parse(task.result!) as unknown);
      expect(result).toMatchObject({ outcome: 'partial', task_id: taskId, mission_id: 'adventure-1', summary: 'The map is drafted and the coastline is handed off.' });
      expect(result.artifacts.map(item => item.name)).toEqual(['map.md']);
      const kinds = runtime.store.events(taskId, 0, 500).map(event => event.kind);
      for (const kind of ['team_handoff', 'team_propose_decision', 'artifact_registered', 'development_note', 'team_result']) expect(kinds).toContain(kind);
      expect(kinds).not.toContain('team_ask_user');
      const denied = runtime.store.events(taskId, 0, 500).find(event => event.kind === 'tool_result' && JSON.stringify(event.detail).includes('team_ask_user'));
      expect(JSON.stringify(denied?.detail)).toContain('TOOL_DENIED');
      const artifacts = await (await app.request(`/api/v1/tasks/${taskId}/artifacts`, { headers })).json() as { artifacts: Array<{ manifest: { sha256: string; name: string; provenance: { producer_task_id: string } } }> };
      expect(artifacts.artifacts).toHaveLength(1);
      expect(artifacts.artifacts[0]!.manifest.provenance.producer_task_id).toBe(taskId);
      const manifest = await app.request(`/api/v1/artifacts/${artifacts.artifacts[0]!.manifest.sha256}/manifest`, { headers });
      expect(manifest.status).toBe(200);
      expect(runtime.store.sessionMessages(session.id, 'management').at(-1)?.content).toBe(result.summary);
      expect(runtime.development.list().map(record => record.title)).toEqual(['Sketch first']);
    } finally { runtime.close(); }
  });

  it('ends the turn as input_required after team_ask_user', async () => {
    const model = await llama([{ calls: [{ name: 'team_ask_user', args: { question: 'Which coast?', options: ['North', 'South'] } }] }]);
    const { runtime, app, headers } = await setup(model.url);
    try {
      const submitted = await app.request('/api/v1/missions', { method: 'POST', headers, body: JSON.stringify({
        objective: 'Draw the map', mission: mission({ resources: ['tool:team_ask_user'] }), idempotency_key: 'm-3' }) });
      const { task_id: taskId } = await submitted.json() as { task_id: string };
      await waitDone(runtime, taskId);
      expect(model.requests).toHaveLength(1);
      const result = TeamResult.parse(JSON.parse(runtime.store.get(taskId)!.result!) as unknown);
      expect(result.outcome).toBe('input_required');
      expect(result.clarification).toEqual({ missing_fact: 'Which coast?', choices: [{ id: 'option-1', label: 'North' }, { id: 'option-2', label: 'South' }],
        blocked_task: taskId, intended_respondent: 'operator' });
      expect(runtime.store.events(taskId).some(event => event.kind === 'team_ask_user')).toBe(true);
    } finally { runtime.close(); }
  });

  it('accepts a validated completion and rejects an unsupported one', async () => {
    // The final reply claims completion with evidence: the real artifact digest, or a fabricated one.
    const claim = (fabricated: boolean) => (request: ModelRequest): Turn => {
      const taskId = /"task_id":"([0-9a-f-]{36})"|task_id:"([0-9a-f-]{36})"/.exec(String(request.messages[0]!.content))?.slice(1).find(Boolean) ?? '';
      const sha = fabricated ? 'a'.repeat(64) : /"sha256\\?":\\?"([a-f0-9]{64})/.exec(JSON.stringify(request.messages.at(-1)))?.[1] ?? '';
      return { text: JSON.stringify({ team_result: { version: '1.0', mission_id: 'adventure-1', mission_revision: 1, task_id: taskId,
        outcome: 'completed', summary: 'Map done.', checks: [{ criterion: 'A map exists', status: 'pass', evidence: [`ardent-artifact:${sha}`] }],
        artifacts: [], uncertain_effects: [] } }) };
    };
    const write: Turn = { calls: [{ name: 'artifact_write', args: { name: 'map.svg', mime: 'image/svg+xml', text: '<svg xmlns="http://www.w3.org/2000/svg"/>' } }] };
    const model = await llama([write, claim(false), write, claim(true)]);
    const { runtime, app, headers } = await setup(model.url);
    try {
      const submit = async (key: string) => (await (await app.request('/api/v1/missions', { method: 'POST', headers, body: JSON.stringify({
        objective: 'Draw the map', mission: mission({ resources: ['tool:artifact_write'] }), idempotency_key: key }) })).json() as { task_id: string }).task_id;
      const taskId = await submit('m-4');
      await waitDone(runtime, taskId);
      const result = TeamResult.parse(JSON.parse(runtime.store.get(taskId)!.result!) as unknown);
      expect(result.outcome).toBe('completed');
      expect(result.summary).toBe('Map done.');
      const sha = result.artifacts[0]?.sha256 ?? '';
      expect(result.artifacts).toEqual([{ name: 'map.svg', reference: `ardent-artifact:${sha}`, sha256: sha }]);
      const secondId = await submit('m-5');
      await waitDone(runtime, secondId);
      const rejected = TeamResult.parse(JSON.parse(runtime.store.get(secondId)!.result!) as unknown);
      expect(rejected.outcome).toBe('partial');
      expect(rejected.summary).toBe('Map done.');
      expect(runtime.store.events(secondId).some(event => event.kind === 'team_result_rejected')).toBe(true);
    } finally { runtime.close(); }
  });

  it('offers development_note, but no other mission tool, to direct tasks', async () => {
    const model = await llama([{ text: 'Hello.' }]);
    const { runtime, app, headers } = await setup(model.url);
    try {
      const submitted = await app.request('/api/v1/tasks', { method: 'POST', headers, body: JSON.stringify({ prompt: 'Hi' }) });
      const { task_id: taskId } = await submitted.json() as { task_id: string };
      await waitDone(runtime, taskId);
      const offered = model.requests[0]!.tools!.map(tool => tool.function.name);
      expect(offered).toContain('development_note');
      expect(offered.filter(name => name.startsWith('team_') || name === 'artifact_write' || name === 'document_render')).toEqual([]);
      expect(runtime.store.get(taskId)?.result).toBe('Hello.');
    } finally { runtime.close(); }
  });

  it('reads private memory and one granted project scope', async () => {
    const searches: unknown[] = [];
    const hivemem = await listen(createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/capabilities') { response.end(JSON.stringify({ retrieval: 'lexical', storage: 'sqlite' })); return; }
      void body(request).then(text => { searches.push(JSON.parse(text)); response.end(JSON.stringify({ results: [] })); });
    }));
    const model = await llama([{ text: 'Noted.' }]);
    const { runtime, app, headers } = await setup(model.url, loaded => {
      loaded.config.memory = { provider: 'hivemem', base_url: hivemem, token_env: 'HIVEMEM_TOKEN', agent_id: 'assistant', workspace_id: 'ws-1', default_scope: 'private' };
    }, { HIVEMEM_TOKEN: 'fixture-token' });
    try {
      const submitted = await app.request('/api/v1/missions', { method: 'POST', headers, body: JSON.stringify({
        objective: 'Recall the river', mission: mission({ resources: ['project:p1'] }), idempotency_key: 'm-6' }) });
      const { task_id: taskId } = await submitted.json() as { task_id: string };
      await waitDone(runtime, taskId);
      expect(searches).toMatchObject([{ scope: 'private', agent_filter: 'assistant' }, { scope: 'shared', filters: { project_id: 'p1' } }]);
      expect(model.requests[0]!.tools ?? []).toEqual([]);
      expect(runtime.store.events(taskId).some(event => event.kind === 'memory_stored')).toBe(false);
    } finally { runtime.close(); }
  });
});
