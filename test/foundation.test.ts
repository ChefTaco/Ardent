import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProfile, loadConfig, saveConfig } from '../src/config.js';
import { initTestProfile } from './helpers.js';
import { ArtifactStore } from '../src/artifacts.js';
import { ToolRegistry } from '../src/tools.js';
import { registerNewsTools } from '../src/news.js';
import { sseData } from '../src/llamacpp.js';
import { TaskStore } from '../src/store.js';
import { ArdentRuntime } from '../src/runtime.js';
import { createHash } from 'node:crypto';
import { createArdentApi } from '../src/api.js';
import { CodexHarnessBackend } from '../src/codex.js';
import { defineTool } from '../src/tools.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { SqliteA2ATaskStore } from '../src/a2a-store.js';
import { Role as A2ARole, TaskState as A2ATaskState, type Task as A2ATask } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { createA2ASurface } from '../src/a2a-server.js';
import { ArdentA2AClient } from '../src/a2a-client.js';
import { ClientFactory, ClientFactoryOptions } from '@a2a-js/sdk/client';
import { GrpcTransportFactory } from '@a2a-js/sdk/client/grpc';
import { ServerCredentials } from '@grpc/grpc-js';
import { validateTeamEnvelope, validateTeamResult } from '../src/team-contract.js';
import { readPeersConfig, savePeersConfig } from '../src/a2a-peers.js';
import { TeamControlService } from '../src/team-control.js';
import { createArdentManagementClient } from './ardent-client.js';

const dirs: string[] = [];
const servers: Server[] = [];
async function temp(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'ardent-test-')); dirs.push(dir); return dir; }
async function fixture(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return `http://127.0.0.1:${address.port}/`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('profile and durable tasks', () => {
  it('preserves comments, revisions, and private profile files', async () => {
    const dir = await temp();
    await initTestProfile(dir);
    const before = await loadConfig(dir);
    expect(before.text).toContain('# Ardent profile, schema 1');
    expect(await readFile(join(dir, '.env'), 'utf8')).toMatch(/^ARDENT_API_TOKEN=[a-f0-9]{64}\n$/);
    expect(await readFile(join(dir, 'skills', 'grounded-answers', 'SKILL.md'), 'utf8')).toContain('# Grounded answers');
    const changed = before.text.replace('name: Assistant', 'name: Assistant Research');
    const next = await saveConfig(dir, changed, before.revision);
    expect((await loadConfig(dir)).config.name).toBe('Assistant Research');
    expect(next).not.toBe(before.revision);
    await expect(saveConfig(dir, before.text, before.revision)).rejects.toThrow('revision conflict');
    const current = await loadConfig(dir);
    const concurrent = await Promise.allSettled([
      saveConfig(dir, current.text.replace('Assistant Research', 'Assistant One'), current.revision),
      saveConfig(dir, current.text.replace('Assistant Research', 'Assistant Two'), current.revision),
    ]);
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter(result => result.status === 'rejected')).toHaveLength(1);
  });
  it('initializes a named profile on its assigned management port without exposing its token', async () => {
    const dir = await temp();
    await initProfile(dir, { profile: 'research2', apiPort: 19911 });
    const loaded = await loadConfig(dir);
    expect(loaded.config.profile).toBe('research2');
    expect(loaded.config.name).toBe('research2');
    expect(loaded.config.memory).toEqual({ provider: 'none' });
    expect(loaded.config.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    expect(loaded.config.api.port).toBe(19911);
    expect(loaded.config.a2a.enabled).toBe(false);
    expect(loaded.text).not.toContain('ARDENT_API_TOKEN=');
    await expect(initProfile(dir, { profile: 'research2', apiPort: 19911 })).rejects.toThrow();
  });
  it('rejects changed or redirected artifact bytes during retrieval', async () => {
    const dir = await temp();
    const artifacts = new ArtifactStore(join(dir, 'artifacts'));
    const item = await artifacts.put('packet.json', 'application/json', Buffer.from('{"ok":true}'));
    expect(Buffer.from(await artifacts.get(item.id)).toString()).toBe('{"ok":true}');
    await writeFile(join(dir, 'artifacts', item.id), 'changed');
    await expect(artifacts.get(item.id)).rejects.toThrow('differ');
    await unlink(join(dir, 'artifacts', item.id));
    await symlink(join(dir, 'outside'), join(dir, 'artifacts', item.id));
    await expect(artifacts.get(item.id)).rejects.toThrow();
  });
  it('validates authorized peer edits with a revision and preserves comments', async () => {
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    const current = await readPeersConfig(dir, config);
    const next = `# Approved peer route\nschema_version: 1\npeers:\n  - id: coordinator\n    url: https://coordinator.example.test:9900/\n    token_env: ARDENT_A2A_PEER_COORDINATOR_TOKEN\n    enabled: false\n`;
    const revision = await savePeersConfig(dir, config, next, current.revision);
    expect((await readPeersConfig(dir, config)).text).toContain('# Approved peer route');
    expect(revision).not.toBe(current.revision);
    await expect(savePeersConfig(dir, config, next, current.revision)).rejects.toThrow('revision conflict');
    await expect(savePeersConfig(dir, config, next.replace('coordinator.example.test', 'user:secret@coordinator.example.test'), revision)).rejects.toThrow('Invalid A2A peer URL');
  });
  it('binds idempotency to caller and content, and marks interrupted work unknown', async () => {
    const dir = await temp();
    const store = new TaskStore(join(dir, 'state', 'ardent.sqlite'));
    const input = { caller: 'alice', context: 'direct' as const, prompt: 'Research X', idempotencyKey: 'update-1', backend: 'llamacpp' as const, deadlineMs: Date.now() + 10000 };
    const first = store.accept(input);
    expect(store.accept(input).id).toBe(first.id);
    expect(store.accept({ ...input, deadlineMs: input.deadlineMs + 5000 }).id).toBe(first.id);
    expect(() => store.accept({ ...input, prompt: 'Different request' })).toThrow('different task content');
    expect(store.accept({ ...input, caller: 'bob' }).id).not.toBe(first.id);
    store.setState(first.id, 'running');
    store.close();
    const restarted = new TaskStore(join(dir, 'state', 'ardent.sqlite'));
    expect(restarted.recover().interrupted).toBe(1);
    expect(restarted.get(first.id)?.state).toBe('unknown');
    restarted.close();
  });
  it('persists conversation turns and keeps sessions scoped to their caller', async () => {
    const dir = await temp();
    const path = join(dir, 'state', 'ardent.sqlite');
    const store = new TaskStore(path);
    const session = store.session('alice', 'direct', 'cli');
    const task = store.accept({ caller: 'alice', context: 'direct', sessionId: session.id, prompt: 'First question', backend: 'llamacpp', deadlineMs: Date.now() + 10000 });
    store.appendAssistant(task, 'First answer');
    expect(store.sessionMessages(session.id, 'alice').map(message => message.content)).toEqual(['First question', 'First answer']);
    expect(() => store.sessionMessages(session.id, 'bob')).toThrow('Session not found');
    expect(() => store.accept({ caller: 'bob', context: 'direct', sessionId: session.id, prompt: 'Steal context', backend: 'llamacpp', deadlineMs: Date.now() + 10000 })).toThrow('mismatch');
    store.close();
    const reopened = new TaskStore(path);
    expect(reopened.sessionMessages(session.id, 'alice')).toHaveLength(2);
    const next = reopened.resetSession('alice', 'direct', 'cli');
    expect(next.id).not.toBe(session.id);
    expect(reopened.sessionMessages(next.id, 'alice')).toEqual([]);
    expect(reopened.sessionMessages(session.id, 'alice')).toHaveLength(2);
    reopened.close();
  });
});

describe('A2A durable task storage', () => {
  it('persists task envelopes and scopes listing to the authenticated caller', async () => {
    const dir = await temp();
    const path = join(dir, 'state', 'ardent.sqlite');
    const operational = new TaskStore(path);
    const tasks = new SqliteA2ATaskStore(operational.db);
    const caller = (name: string) => new ServerCallContext({ tenant: 'team', user: { isAuthenticated: true, userName: name } });
    const task: A2ATask = { id: 'a2a-1', contextId: 'research', status: { state: A2ATaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() }, artifacts: [], history: [], metadata: {} };
    await tasks.save(task, caller('coordinator'));
    expect((await tasks.load(task.id, caller('coordinator')))?.id).toBe(task.id);
    expect(await tasks.load(task.id, caller('other'))).toBeUndefined();
    expect((await tasks.list({ pageSize: 10 }, caller('coordinator'))).totalSize).toBe(1);
    expect((await tasks.list({ pageSize: 10 }, caller('other'))).totalSize).toBe(0);
    await expect(tasks.save({ ...task, status: { ...task.status, state: A2ATaskState.TASK_STATE_COMPLETED } }, caller('other'))).rejects.toThrow('owner mismatch');
    operational.close();
    const reopened = new TaskStore(path);
    expect((await new SqliteA2ATaskStore(reopened.db).load(task.id, caller('coordinator')))?.status?.state).toBe(A2ATaskState.TASK_STATE_WORKING);
    reopened.close();
  });
});

describe('Hermes team lifecycle admission', () => {
  it('blocks model work while paused, resumes on a newer control, and fences cancellation', async () => {
    let modelCalls = 0;
    const model = await fixture((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      modelCalls++;
      response.setHeader('Content-Type', 'text/event-stream');
      response.end('data: {"choices":[{"delta":{"content":"Observed answer"}}]}\n\ndata: [DONE]\n\n');
    });
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = model;
    config.providers.llamacpp.model = 'fixture';
    const runtime = new ArdentRuntime(dir, config);
    const a2aStore = new SqliteA2ATaskStore(runtime.store.db);
    const control = new TeamControlService(runtime);
    runtime.store.db.exec('CREATE TABLE a2a_team_missions (a2a_task_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, caller TEXT NOT NULL, envelope_json TEXT NOT NULL); CREATE TABLE a2a_operation_map (a2a_task_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, tenant TEXT NOT NULL, caller TEXT NOT NULL)');
    const caller = new ServerCallContext({ tenant: '', user: { isAuthenticated: true, userName: 'coordinator' } });
    const bind = async (id: string) => {
      const operation = runtime.accept('Research a topic', 'a2a::coordinator', 'peer', id);
      await a2aStore.save({ id, contextId: `context-${id}`, status: { state: A2ATaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: undefined }, artifacts: [], history: [], metadata: {} }, caller);
      const envelope = { version: '1.0', caller: 'coordinator', task_id: id, objective: 'Research a topic', mission: { id: `mission-${id}`, revision: 1, parent_task: null, constraints: [], allowed_actions: ['observe'], resources: ['public:news'], deadline: Math.floor(Date.now() / 1000) + 3600, acceptance_criteria: ['Cite a source'], expected_artifacts: [] } };
      runtime.store.db.prepare('INSERT INTO a2a_team_missions VALUES (?,?,?,?)').run(id, '', 'coordinator', JSON.stringify(envelope));
      runtime.store.db.prepare('INSERT INTO a2a_operation_map VALUES (?,?,?,?)').run(id, operation.id, '', 'coordinator');
      runtime.store.db.prepare('INSERT INTO a2a_operation_links VALUES (?,?)').run(id, operation.id);
      return operation;
    };
    try {
      const first = await bind('native-paused');
      const apply = (id: string, action: 'pause' | 'resume' | 'cancel', version: number) => control.handle({ version: '1.0', action: 'task_control', key: `${id}-${action}`, payload: { native_task_id: id, task_id: id, mission_revision: 1, control_id: `${id}-${action}`, control_version: version, action } }, '', 'coordinator');
      apply('native-paused', 'pause', 1);
      const running = runtime.run(first.id);
      for (let attempts = 0; attempts < 50 && !runtime.store.events(first.id).some(event => event.kind === 'team_waiting_for_resume'); attempts++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(runtime.store.events(first.id).some(event => event.kind === 'team_waiting_for_resume')).toBe(true);
      expect(modelCalls).toBe(0);
      runtime.store.append(first.id, 'oversized_fixture', { text: 'x'.repeat(40_000) });
      const large = control.handle({ version: '1.0', action: 'task_events', key: 'events-large', payload: { native_task_id: 'native-paused', after_cursor: 0, limit: 100 } }, '', 'coordinator') as { data: { next_cursor: number } };
      expect(large.data.next_cursor).toBe(runtime.store.events(first.id).at(-1)?.sequence);
      apply('native-paused', 'resume', 2);
      expect((await running).task.state).toBe('completed');
      expect(modelCalls).toBe(1);
      const second = await bind('native-cancelled');
      apply('native-cancelled', 'pause', 1);
      const cancelled = runtime.run(second.id);
      for (let attempts = 0; attempts < 50 && !runtime.store.events(second.id).some(event => event.kind === 'team_waiting_for_resume'); attempts++) await new Promise(resolve => setTimeout(resolve, 10));
      apply('native-cancelled', 'cancel', 2);
      await expect(cancelled).rejects.toThrow();
      expect(runtime.store.get(second.id)?.state).toBe('cancelled');
      expect(modelCalls).toBe(1);
      expect(() => apply('native-cancelled', 'resume', 3)).toThrow('cannot be reopened');
    } finally { runtime.close(); }
  });
});

describe('Codex research failure boundary', () => {
  it('returns a partial empty-source packet when a failed search ends in prose', async () => {
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.execution.backend = 'codex';
    config.providers.codex.command = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
    config.providers.codex.model = 'fixture-model';
    const env = { ARDENT_FIXTURE_TOOL: 'news_search' };
    const runtime = new ArdentRuntime(dir, config, env);
    try {
      const task = runtime.accept('Find a current cybersecurity headline');
      const result = await runtime.run(task.id, env);
      expect(result.task.state).toBe('partial');
      expect(result.brief?.claims).toEqual([]);
      expect(result.brief?.coverage_gaps.length).toBeGreaterThan(0);
      expect(runtime.store.events(task.id).some(event => event.kind === 'research_partial_fallback')).toBe(true);
      expect(runtime.store.events(task.id).some(event => event.kind === 'research_artifacts')).toBe(true);
    } finally { runtime.close(); }
  });
});

describe('A2A server transport', () => {
  it('keeps team identity on the authenticated team card and the public v1 card protobuf-valid', async () => {
    const dir = await temp();
    await initTestProfile(dir);
    await writeFile(join(dir, 'peers.yaml'), 'schema_version: 1\npeers: []\n');
    const config = (await loadConfig(dir)).config;
    config.a2a.public_url = 'https://agent.example.com:9943';
    config.a2a.hermes_compat = true;
    const runtime = new ArdentRuntime(dir, config);
    try {
      const surface = await createA2ASurface(runtime, config);
      const server = surface.app.listen(0, '127.0.0.1');
      servers.push(server);
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No card fixture address');
      const response = await fetch(`http://127.0.0.1:${address.port}/.well-known/agent-card.json`);
      const card = await response.json() as { name?: string; metadata?: unknown };
      expect(response.status).toBe(200);
      expect(card.name).toBe(config.name);
      expect(card).not.toHaveProperty('metadata');
      const teamCard = await fetch(`http://127.0.0.1:${address.port}/.well-known/hermes-team-card.json`);
      expect(teamCard.status).toBe(401);
      surface.grpcServer.forceShutdown();
    } finally { runtime.close(); }
  });
  it('keeps the local listener distinct from the advertised public origin', async () => {
    const dir = await temp();
    await initTestProfile(dir);
    await writeFile(join(dir, 'peers.yaml'), 'schema_version: 1\npeers: []\n');
    const config = (await loadConfig(dir)).config;
    config.a2a.public_url = 'https://assistant.example.com:9943';
    config.a2a.listen_port = 9900;
    const runtime = new ArdentRuntime(dir, config);
    try {
      const surface = await createA2ASurface(runtime, config);
      expect(surface.grpcListenPort).toBe(9901);
      expect(surface.card.supportedInterfaces.some(item => item.url === 'https://assistant.example.com:9943/a2a/jsonrpc')).toBe(true);
      expect(surface.card.supportedInterfaces.some(item => item.url === 'assistant.example.com:9944')).toBe(true);
      surface.grpcServer.forceShutdown();
    } finally { runtime.close(); }
  });
  it('authenticates a peer and executes a canonical v1 REST request', async () => {
    let modelCalls = 0;
    const model = await fixture((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.statusCode = 404; response.end(); return; }
      modelCalls++;
      response.setHeader('Content-Type', 'text/event-stream');
      response.end('data: {"choices":[{"delta":{"content":"A2A_OK"}}]}\n\ndata: [DONE]\n\n');
    });
    const dir = await temp();
    await initTestProfile(dir);
    await writeFile(join(dir, 'peers.yaml'), 'schema_version: 1\npeers:\n  - id: coordinator\n    url: http://127.0.0.1:9900\n    token_env: ARDENT_TEST_PEER_TOKEN\n    transport_ports: [9901]\n');
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = model;
    config.providers.llamacpp.model = 'fixture';
    config.a2a.public_url = 'http://127.0.0.1:9900';
    // This test also covers the optional Hermes slash-method aliases.
    config.a2a.hermes_compat = true;
    const env = { ARDENT_TEST_PEER_TOKEN: 'fixture-token-1234567890' };
    const runtime = new ArdentRuntime(dir, config, env);
    try {
      const surface = await createA2ASurface(runtime, config, env);
      const server = surface.app.listen(0, '127.0.0.1');
      servers.push(server);
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No A2A fixture address');
      for (const iface of surface.card.supportedInterfaces) if (iface.protocolBinding !== 'GRPC') iface.url = `http://127.0.0.1:${address.port}/${iface.protocolBinding === 'JSONRPC' ? 'a2a/jsonrpc' : 'a2a/rest'}`;
      await writeFile(join(dir, 'peers.yaml'), `schema_version: 1\npeers:\n  - id: coordinator\n    url: http://127.0.0.1:${address.port}\n    token_env: ARDENT_TEST_PEER_TOKEN\n    transport_ports: [9901]\n`);
      const url = `http://127.0.0.1:${address.port}/a2a/rest/message:send`;
      const body = { message: { role: 'ROLE_USER', messageId: 'request-1', parts: [{ text: 'Return fixture answer' }] } };
      const denied = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0' }, body: JSON.stringify(body) });
      expect(denied.status).toBe(401);
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify(body) });
      const result = await response.json() as { task?: { id: string; status?: { state?: string }; artifacts?: { parts: { text?: string }[] }[] }; error?: unknown };
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result.task?.status?.state).toBe('TASK_STATE_COMPLETED');
      expect(result.task?.artifacts?.[0]?.parts[0]?.text).toContain('A2A_OK');
      const list = await fetch(`http://127.0.0.1:${address.port}/a2a/rest/tasks`, { headers: { 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' } });
      const listed = await list.json() as { tasks?: { id: string }[] };
      expect(list.status).toBe(200);
      expect(listed.tasks?.some(task => task.id === result.task?.id)).toBe(true);
      const get = await fetch(`http://127.0.0.1:${address.port}/a2a/rest/tasks/${result.task?.id}`, { headers: { 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' } });
      expect(get.status).toBe(200);
      const wrongVersion = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '2.0', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify(body) });
      expect(wrongVersion.status).toBe(400);
      const duplicate = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify(body) });
      expect(duplicate.status).toBe(200);
      const duplicateTask = (await duplicate.json() as { task?: { id?: string; status?: { state?: string } } }).task;
      expect(duplicateTask?.status?.state).toBe('TASK_STATE_COMPLETED');
      expect(duplicateTask?.id).toBe(result.task?.id);
      const changed = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify({ message: { role: 'ROLE_USER', messageId: 'request-1', parts: [{ text: 'Changed request' }] } }) });
      expect(changed.status).toBe(400);
      expect(modelCalls).toBe(1);
      const rpc = await fetch(`http://127.0.0.1:${address.port}/a2a/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'SendMessage', params: { message: { role: 'ROLE_USER', messageId: 'request-2', parts: [{ text: 'Return fixture answer again' }] } } }) });
      const rpcResult = await rpc.json() as { result?: { task?: { status?: { state?: string } } }; error?: unknown };
      expect(rpc.status, JSON.stringify(rpcResult)).toBe(200);
      expect(rpcResult.result?.task?.status?.state).toBe('TASK_STATE_COMPLETED');
      const hermesAlias = await fetch(`http://127.0.0.1:${address.port}/a2a/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify({ jsonrpc: '2.0', id: 71, method: 'message/send', params: { message: { role: 'ROLE_USER', messageId: 'hermes-alias-1', parts: [{ text: 'Return fixture answer through Hermes alias' }] } } }) });
      const aliasResult = await hermesAlias.json() as { result?: { id?: string; status?: { state?: string } }; error?: unknown };
      expect(hermesAlias.status, JSON.stringify(aliasResult)).toBe(200);
      expect(aliasResult.result?.status?.state, JSON.stringify(aliasResult)).toBe('TASK_STATE_COMPLETED');
      const aliasGet = await fetch(`http://127.0.0.1:${address.port}/a2a/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify({ jsonrpc: '2.0', id: 72, method: 'tasks/get', params: { id: aliasResult.result?.id } }) });
      expect((await aliasGet.json() as { result?: { id?: string } }).result?.id).toBe(aliasResult.result?.id);
      const aliasList = await fetch(`http://127.0.0.1:${address.port}/a2a/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify({ jsonrpc: '2.0', id: 73, method: 'tasks/list', params: { pageSize: 50 } }) });
      expect((await aliasList.json() as { result?: { tasks?: { id?: string }[] } }).result?.tasks?.some(task => task.id === aliasResult.result?.id)).toBe(true);
      const aliasStream = await fetch(`http://127.0.0.1:${address.port}/a2a/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify({ jsonrpc: '2.0', id: 74, method: 'message/stream', params: { message: { role: 'ROLE_USER', messageId: 'hermes-alias-stream-1', parts: [{ text: 'Stream the fixture answer' }] } } }) });
      expect(aliasStream.headers.get('content-type')).toContain('text/event-stream');
      expect(await aliasStream.text()).toContain('TASK_STATE_COMPLETED');
      const outbound = await new ArdentA2AClient(dir, config, env).send('coordinator', 'Use the fixture model');
      expect('id' in outbound && outbound.status?.state).toBe(A2ATaskState.TASK_STATE_COMPLETED);
      const extendedCard = await new ArdentA2AClient(dir, config, env).extendedCard('coordinator');
      expect(extendedCard.skills.some(skill => skill.id === 'assistant-team-result')).toBe(true);
      const publicCard = await (await fetch(`http://127.0.0.1:${address.port}/.well-known/agent-card.json`, { headers: { 'A2A-Version': '1.0' } })).json() as { skills?: { id?: string }[]; capabilities?: { extendedAgentCard?: boolean } };
      expect(publicCard.capabilities?.extendedAgentCard).toBe(true);
      expect(publicCard.skills?.some(skill => skill.id === 'assistant-team-result')).toBe(false);
      const anonymousCard = await fetch(`http://127.0.0.1:${address.port}/a2a/rest/extendedAgentCard`, { headers: { 'A2A-Version': '1.0' } });
      expect(anonymousCard.status).toBe(401);
      const unsupportedVersion = await fetch(`http://127.0.0.1:${address.port}/a2a/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '9.9', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'unsupported-version', method: 'SendMessage', params: { message: { role: 'ROLE_USER', messageId: 'unsupported-version', parts: [{ text: 'Do not execute this version' }] } } }) });
      const unsupportedWire = await unsupportedVersion.text();
      expect(unsupportedVersion.status < 400 && /TASK_STATE_COMPLETED/.test(unsupportedWire)).toBe(false);
      const legacyCard = await (await fetch(`http://127.0.0.1:${address.port}/.well-known/agent-card.json`, { headers: { 'A2A-Version': '0.3' } })).json() as { protocolVersion?: string; url?: string };
      expect(legacyCard.protocolVersion).toMatch(/^0\.3/);
      expect(legacyCard.url).toContain('/a2a/jsonrpc');
      const legacy = await fetch(`http://127.0.0.1:${address.port}/a2a/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '0.3', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'message/send', params: { message: { kind: 'message', messageId: 'legacy-request-1', role: 'user', parts: [{ kind: 'text', text: 'Legacy fixture response' }] } } }) });
      const legacyResult = await legacy.json() as { result?: { kind?: string; status?: { state?: string } }; error?: unknown };
      expect(legacy.status, JSON.stringify(legacyResult)).toBe(200);
      expect(legacyResult.result?.status?.state).toBe('completed');
      const stream = await fetch(`http://127.0.0.1:${address.port}/a2a/rest/message:stream`, { method: 'POST', headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify({ message: { role: 'ROLE_USER', messageId: 'request-4', parts: [{ text: 'Stream fixture answer' }] } }) });
      expect(stream.status).toBe(200);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      expect(await stream.text()).toContain('TASK_STATE_COMPLETED');
      const beforeForgery = modelCalls;
      const unsupportedExtension = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify({ message: { role: 'ROLE_USER', messageId: 'unsupported-extension', parts: [{ text: 'Do not run this team extension' }], metadata: { hermesTeamClarification: '2.0' } } }) });
      expect((await unsupportedExtension.json() as { task?: { status?: { state?: string } } }).task?.status?.state).toBe('TASK_STATE_REJECTED');
      expect(modelCalls).toBe(beforeForgery);
      const control = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify({ message: { role: 'ROLE_USER', messageId: 'control-1', parts: [{ text: 'HERMES_COORDINATION_CONTROL' }], metadata: { hermesTeamControl: { version: '1.0', action: 'status_operation', key: 'test', payload: {} } } } }) });
      expect((await control.json() as { task?: { status?: { state?: string } } }).task?.status?.state).toBe('TASK_STATE_REJECTED');
      expect(modelCalls).toBe(beforeForgery);
      const forgedMission = { version: '1.0', caller: 'peerb', task_id: 'forged-1', objective: 'Research a topic', mission: { id: 'mission-1', revision: 1, parent_task: null, constraints: [], allowed_actions: ['observe'], resources: ['public:news'], deadline: Math.floor(Date.now() / 1000) + 3600, acceptance_criteria: ['Cite a source'], expected_artifacts: [] } };
      const forged = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify({ message: { role: 'ROLE_USER', messageId: 'forged-1', parts: [{ text: 'Research a topic' }], metadata: { hermesTeamTask: forgedMission } } }) });
      const forgedResult = await forged.json() as { task?: { status?: { state?: string } } };
      expect(forgedResult.task?.status?.state).toBe('TASK_STATE_FAILED');
      expect(modelCalls).toBe(beforeForgery);
      const acceptedMission = { ...forgedMission, caller: 'coordinator', task_id: 'team-1' };
      const unsupportedChild = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify({ message: { role: 'ROLE_USER', messageId: 'team-child', parts: [{ text: 'Research a topic' }], metadata: { hermesTeamTask: { ...acceptedMission, task_id: 'team-child', mission: { ...acceptedMission.mission, parent_task: 'parent-1' } } } } }) });
      expect((await unsupportedChild.json() as { task?: { status?: { state?: string } } }).task?.status?.state).toBe('TASK_STATE_FAILED');
      expect(modelCalls).toBe(beforeForgery);
      const team = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify({ message: { role: 'ROLE_USER', messageId: 'team-1', parts: [{ text: 'Research a topic' }], metadata: { hermesTeamTask: acceptedMission } } }) });
      const teamWire = await team.json() as { task?: { id?: string; artifacts?: { parts: { text?: string }[] }[] } };
      const teamResult = JSON.parse(teamWire.task?.artifacts?.[0]?.parts[0]?.text ?? '{}') as { outcome?: string; mission_id?: string };
      expect(teamResult.outcome).toBe('partial');
      expect(teamResult.mission_id).toBe('mission-1');
      const controlCall = async (action: string, key: string, payload: object) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-token-1234567890' }, body: JSON.stringify({ jsonrpc: '2.0', id: key, method: 'SendMessage', params: { message: { role: 'ROLE_USER', messageId: key, contextId: `control-${key}`, parts: [{ text: 'HERMES_COORDINATION_CONTROL' }], metadata: { hermesTeamControl: { version: '1.0', action, key, payload } } } } }) });
        const wire = await response.json() as { result?: { task?: { status?: { state?: string }; artifacts?: { parts: { text?: string }[] }[] } }; error?: unknown };
        expect(response.status, JSON.stringify(wire)).toBe(200);
        expect(wire.result?.task?.status?.state, JSON.stringify(wire)).toBe('TASK_STATE_COMPLETED');
        return JSON.parse(wire.result?.task?.artifacts?.[0]?.parts[0]?.text ?? '{}') as { version?: string; request_digest?: string; data?: { events?: { task_id?: string }[]; admission?: string; control_version?: number } };
      };
      const events = await controlCall('task_events', 'events-1', { native_task_id: teamWire.task?.id, after_cursor: 0, limit: 10 });
      expect(events.version).toBe('1.0');
      expect(events.request_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(events.data?.events?.some(event => event.task_id === teamWire.task?.id)).toBe(true);
      const paused = await controlCall('task_control', 'pause-1', { native_task_id: teamWire.task?.id, task_id: 'team-1', mission_revision: 1, control_id: 'pause-1', control_version: 1, action: 'pause' });
      expect(paused.data?.admission).toBe('paused');
      const resumed = await controlCall('task_control', 'resume-1', { native_task_id: teamWire.task?.id, task_id: 'team-1', mission_revision: 1, control_id: 'resume-1', control_version: 2, action: 'resume' });
      expect(resumed.data?.admission).toBe('open');
      const grpcPort = await new Promise<number>((resolve, reject) => surface.grpcServer.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
      try {
        const grpcCard = { ...surface.card, supportedInterfaces: [{ url: `127.0.0.1:${grpcPort}`, protocolBinding: 'GRPC', tenant: '', protocolVersion: '1.0' }] };
        const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, { transports: [new GrpcTransportFactory()], preferredTransports: ['GRPC'] }));
        const client = await factory.createFromAgentCard(grpcCard);
        const response = await client.sendMessage({ tenant: '', message: { role: A2ARole.ROLE_USER, messageId: 'request-3', contextId: '', taskId: '', parts: [{ content: { $case: 'text', value: 'Return fixture answer over gRPC' }, metadata: undefined, filename: '', mediaType: 'text/plain' }], metadata: {}, extensions: [], referenceTaskIds: [] }, configuration: undefined, metadata: undefined }, { serviceParameters: { Authorization: 'Bearer fixture-token-1234567890', 'A2A-Version': '1.0' } });
        expect('id' in response && response.status?.state).toBe(A2ATaskState.TASK_STATE_COMPLETED);
      } finally { surface.grpcServer.forceShutdown(); }
    } finally { runtime.close(); }
  });
});

describe('Hermes team contract parity', () => {
  it('enforces mission resource scope before a delegated tool can reach a backend', async () => {
    let turns = 0;
    const model = await fixture((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      turns++;
      const delta = turns % 2 === 1
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: `market-${turns}`, type: 'function', function: { name: 'market_get_quote', arguments: '{"symbol":"ETHUSDC"}' } }] } }] }
        : { choices: [{ delta: { content: 'The market tool was not authorized for this mission.' } }] };
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`);
    });
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = model;
    config.providers.llamacpp.model = 'fixture';
    const runtime = new ArdentRuntime(dir, config);
    try {
      for (const resources of [['public:news'], ['market:quote:BTCUSDC']]) {
        const task = runtime.accept('Review the assigned topic', 'a2a::coordinator', 'peer');
        runtime.store.append(task.id, 'team_envelope', { version: '1.0', caller: 'coordinator', task_id: task.id, objective: 'Review the assigned topic', mission: { id: `mission-${task.id}`, revision: 1, parent_task: null, constraints: [], allowed_actions: ['observe'], resources, deadline: Math.floor(Date.now() / 1000) + 300, acceptance_criteria: ['Report what can be observed'], expected_artifacts: [] } });
        expect((await runtime.run(task.id)).task.state).toBe('completed');
        const denied = runtime.store.events(task.id).find(event => event.kind === 'tool_result');
        expect((denied?.detail as { result?: { code?: string } }).result?.code).toBe('TOOL_DENIED');
      }
      expect(turns).toBe(4);
    } finally { runtime.close(); }
  });
  it('binds a mission to the authenticated caller and rejects unsupported completion', () => {
    const envelope = { version: '1.0', caller: 'coordinator', task_id: 'task-1', objective: 'Research a topic', mission: { id: 'mission-1', revision: 1, parent_task: null, constraints: [], allowed_actions: ['observe'], resources: ['public:news'], deadline: Math.floor(Date.now() / 1000) + 3600, acceptance_criteria: ['Cite a source'], expected_artifacts: [] } };
    const accepted = validateTeamEnvelope(envelope, 'coordinator', 'task-1', 'Research a topic');
    expect(() => validateTeamEnvelope(envelope, 'peerb', 'task-1', 'Research a topic')).toThrow('authenticated');
    const partial = { version: '1.0', mission_id: 'mission-1', mission_revision: 1, task_id: 'task-1', outcome: 'partial', summary: 'One source was unavailable', checks: [{ criterion: 'Cite a source', status: 'unknown', evidence: [] }], artifacts: [], uncertain_effects: [] };
    expect(validateTeamResult(JSON.stringify(partial), accepted).outcome).toBe('partial');
    expect(() => validateTeamResult(JSON.stringify({ ...partial, outcome: 'completed' }), accepted)).toThrow('completion lacks');
    expect(() => validateTeamResult(JSON.stringify({ ...partial, outcome: 'completed', checks: [{ criterion: 'Cite a source', status: 'pass', evidence: ['source:invented'] }] }), accepted, new Set(['source:real']))).toThrow('unobserved');
  });
  it('returns a completed specialist result only with an observed source reference', async () => {
    const sourceUrl = 'https://93.184.216.34/team-source';
    const sourceId = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16);
    let turns = 0;
    const base = await fixture((request, response) => {
      if (request.url?.startsWith('/search')) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ results: [{ url: sourceUrl, title: 'Publisher lead', content: 'A reported update', engines: ['fixture'] }], unresponsive_engines: [] }));
        return;
      }
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      turns++;
      response.setHeader('Content-Type', 'text/event-stream');
      const delta = turns === 1
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'team-search', type: 'function', function: { name: 'news_search', arguments: '{"query":"fixture"}' } }] } }] }
        : { choices: [{ delta: { content: JSON.stringify({ question: 'Find an attributed lead', scope: 'fixture', as_of: new Date().toISOString(), findings: ['A publisher reported an update.'], claims: [{ text: 'A reported update', source_ids: [sourceId], qualification: 'Search snippet only' }], contrary_evidence: [], coverage_gaps: ['Original article not extracted'], artifact_ids: [], answer_markdown: 'One attributed lead; original article not extracted.', team_result: { version: '1.0', mission_id: 'team-mission', mission_revision: 1, task_id: 'team-complete', outcome: 'completed', summary: 'One attributed publisher lead found, with extraction gap.', checks: [{ criterion: 'Provide attributed lead', status: 'pass', evidence: [`source:${sourceId}`] }], artifacts: [], uncertain_effects: [] } }) } }] };
      response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`);
    });
    const dir = await temp();
    await initTestProfile(dir);
    await writeFile(join(dir, 'peers.yaml'), 'schema_version: 1\npeers:\n  - id: coordinator\n    url: http://127.0.0.1:9900\n    token_env: COORDINATOR_TOKEN\n');
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = base;
    config.providers.llamacpp.model = 'fixture';
    config.research.searxng_url = base;
    config.a2a.public_url = 'http://127.0.0.1:9900';
    const env = { COORDINATOR_TOKEN: 'fixture-token-1234567890' };
    const runtime = new ArdentRuntime(dir, config, env);
    try {
      const surface = await createA2ASurface(runtime, config, env);
      const server = surface.app.listen(0, '127.0.0.1');
      servers.push(server);
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No A2A address');
      const envelope = { version: '1.0', caller: 'coordinator', task_id: 'team-complete', objective: 'Find an attributed lead', mission: { id: 'team-mission', revision: 1, parent_task: null, constraints: [], allowed_actions: ['observe'], resources: ['public:news'], deadline: Math.floor(Date.now() / 1000) + 3600, acceptance_criteria: ['Provide attributed lead'], expected_artifacts: [] } };
      const response = await fetch(`http://127.0.0.1:${address.port}/a2a/rest/message:send`, { method: 'POST', headers: { Authorization: 'Bearer fixture-token-1234567890', 'A2A-Version': '1.0', 'Content-Type': 'application/a2a+json' }, body: JSON.stringify({ message: { role: 'ROLE_USER', messageId: 'team-complete', parts: [{ text: 'Find an attributed lead' }], metadata: { hermesTeamTask: envelope } } }) });
      const wire = await response.json() as { task?: { status?: { state?: string }; artifacts?: { parts: { text?: string }[] }[] } };
      expect(response.status, JSON.stringify(wire)).toBe(200);
      expect(wire.task?.status?.state).toBe('TASK_STATE_COMPLETED');
      const result = JSON.parse(wire.task?.artifacts?.[0]?.parts[0]?.text ?? '{}') as { outcome?: string; checks?: { evidence: string[] }[]; artifacts?: unknown[] };
      expect(result.outcome).toBe('completed');
      expect(result.checks?.[0]?.evidence).toEqual([`source:${sourceId}`]);
      expect(result.artifacts).toEqual([]);
      const mapped = runtime.store.db.prepare('SELECT operation_id FROM a2a_operation_map WHERE a2a_task_id=?').get(wire.task?.id) as { operation_id: string };
      expect(runtime.store.events(mapped.operation_id).some(event => event.kind === 'research_artifacts')).toBe(true);
      expect(turns).toBe(2);
    } finally { runtime.close(); }
  });
  it('persists a team mission through input-required continuation on the same A2A task', async () => {
    const sourceUrl = 'https://93.184.216.34/clarification';
    const sourceId = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16);
    let turns = 0;
    const base = await fixture((request, response) => {
      if (request.url?.startsWith('/search')) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ results: [{ url: sourceUrl, title: 'Source', content: 'An attributed fact', engines: ['fixture'] }], unresponsive_engines: [] }));
        return;
      }
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      turns++;
      const result = turns % 2 === 1
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: `search-${turns}`, type: 'function', function: { name: 'news_search', arguments: '{"query":"attributed fact"}' } }] } }] }
        : { choices: [{ delta: { content: JSON.stringify({ question: 'Verify an attributed fact', scope: 'fixture', as_of: new Date().toISOString(), findings: ['An attributed fact was found.'], claims: [{ text: 'The source reports a fact', source_ids: [sourceId], qualification: 'single source' }], contrary_evidence: [], coverage_gaps: ['No corroboration'], artifact_ids: [], answer_markdown: 'An attributed fact was found.', team_result: { version: '1.0', mission_id: 'clarify-mission', mission_revision: 1, task_id: 'clarify-first', outcome: turns === 2 ? 'input_required' : 'completed', summary: turns === 2 ? 'Need a narrower time window' : 'The narrowed report is complete', checks: [{ criterion: 'Report an attributed fact', status: turns === 2 ? 'unknown' : 'pass', evidence: turns === 2 ? [] : [`source:${sourceId}`] }], artifacts: [], uncertain_effects: [], ...(turns === 2 ? { clarification: { missing_fact: 'Which time window?', choices: [{ id: 'today', label: 'Today' }], blocked_task: 'clarify-first', intended_respondent: 'coordinator' } } : {}) } }) } }] };
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(`data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`);
    });
    const dir = await temp();
    await initTestProfile(dir);
    await writeFile(join(dir, 'peers.yaml'), 'schema_version: 1\npeers:\n  - id: coordinator\n    url: http://127.0.0.1:9900\n    token_env: COORDINATOR_TOKEN\n');
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = base;
    config.providers.llamacpp.model = 'fixture';
    config.research.searxng_url = base;
    config.a2a.public_url = 'http://127.0.0.1:9900';
    const token = 'fixture-token-1234567890';
    const runtime = new ArdentRuntime(dir, config, { COORDINATOR_TOKEN: token });
    try {
      const surface = await createA2ASurface(runtime, config, { COORDINATOR_TOKEN: token });
      const server = surface.app.listen(0, '127.0.0.1');
      servers.push(server);
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No A2A address');
      const url = `http://127.0.0.1:${address.port}/a2a/rest/message:send`;
      const headers = { Authorization: `Bearer ${token}`, 'A2A-Version': '1.0', 'Content-Type': 'application/a2a+json' };
      const envelope = { version: '1.0', caller: 'coordinator', task_id: 'clarify-first', objective: 'Verify an attributed fact', mission: { id: 'clarify-mission', revision: 1, parent_task: null, constraints: [], allowed_actions: ['observe'], resources: ['public:news'], deadline: Math.floor(Date.now() / 1000) + 3600, acceptance_criteria: ['Report an attributed fact'], expected_artifacts: [] } };
      const firstResponse = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: { role: 'ROLE_USER', messageId: 'clarify-first', parts: [{ text: 'Verify an attributed fact' }], metadata: { hermesTeamTask: envelope } } }) });
      const first = await firstResponse.json() as { task?: { id: string; contextId: string; status?: { state?: string } } };
      expect(firstResponse.status).toBe(200);
      expect(first.task?.status?.state).toBe('TASK_STATE_INPUT_REQUIRED');
      const followupResponse = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: { role: 'ROLE_USER', messageId: 'clarify-second', taskId: first.task?.id, contextId: first.task?.contextId, parts: [{ text: 'Use today as the time window' }] } }) });
      const followup = await followupResponse.json() as { task?: { id: string; status?: { state?: string }; artifacts?: { parts: { text?: string }[] }[] } };
      expect(followupResponse.status, JSON.stringify(followup)).toBe(200);
      expect(followup.task?.id).toBe(first.task?.id);
      expect(followup.task?.status?.state).toBe('TASK_STATE_COMPLETED');
      const teamResult = JSON.parse(followup.task?.artifacts?.at(-2)?.parts[0]?.text ?? '{}') as { outcome?: string; mission_id?: string };
      expect(teamResult.outcome).toBe('completed');
      expect(teamResult.mission_id).toBe('clarify-mission');
      expect(turns).toBe(4);
    } finally { runtime.close(); }
  });
});

describe('network contracts', () => {
  it('preserves old publication dates and groups identical extracted text across distinct URLs', async () => {
    const urls = ['https://93.184.216.34/original', 'https://93.184.216.35/reprint'];
    const oldDate = '2025-01-15T10:00:00Z';
    const base = await fixture((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.startsWith('/search')) {
        response.end(JSON.stringify({ results: urls.map((url, index) => ({ url, title: `Result ${index}`, content: 'The new event was announced today', publishedDate: oldDate, engines: ['fixture'] })), unresponsive_engines: [] }));
      } else if (request.url === '/v1/scrape') {
        let body = '';
        request.on('data', chunk => { body += String(chunk); });
        request.on('end', () => response.end(JSON.stringify({ success: true, data: { markdown: 'The same syndicated text describes an event on 2026-09-26.', metadata: { sourceURL: (JSON.parse(body) as { url: string }).url, publishedTime: oldDate } } })));
      } else response.writeHead(404).end('{}');
    });
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.research.searxng_url = base;
    config.research.firecrawl_url = base;
    const registry = new ToolRegistry();
    registerNewsTools(registry, config, new ArtifactStore(join(dir, 'artifacts')));
    const result = await registry.call('news_collect', { query: 'new event', max_articles: 2 }, 'direct', AbortSignal.timeout(5000));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const packet = result.value as { search: { results: { published_at: string; source_id: string }[]; retrieved_at: string }; articles: { published_at: string; content_sha256: string }[]; syndication_groups: string[][] };
    expect(packet.search.results.map(item => item.published_at)).toEqual([oldDate, oldDate]);
    expect(Date.parse(packet.search.retrieved_at)).toBeGreaterThan(Date.parse(oldDate));
    expect(packet.articles.map(item => item.published_at)).toEqual([oldDate, oldDate]);
    expect(packet.articles[0]?.content_sha256).toBe(packet.articles[1]?.content_sha256);
    expect(packet.syndication_groups).toEqual([packet.search.results.map(item => item.source_id)]);
  });
  it('ports news search, extraction, exact packet artifact, and partial failures', async () => {
    const base = await fixture((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.startsWith('/search')) {
        response.end(JSON.stringify({ results: [
          { url: 'https://93.184.216.34/story', title: 'Source', content: 'Snippet', publishedDate: null, engines: ['fixture'] },
          { url: 'https://93.184.216.34/story', title: 'Duplicate', content: 'Repeated' }
        ], unresponsive_engines: [['one-engine', 'timeout']] }));
      } else if (request.url === '/v1/scrape') {
        response.end(JSON.stringify({ success: true, data: { markdown: '# Actual extracted text', metadata: { title: 'Original', sourceURL: 'https://93.184.216.34/story' } } }));
      } else { response.statusCode = 404; response.end('{}'); }
    });
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.research.searxng_url = '${ARDENT_TEST_SEARXNG_URL}';
    config.research.firecrawl_url = '${ARDENT_TEST_FIRECRAWL_URL}';
    const registry = new ToolRegistry();
    const artifacts = new ArtifactStore(join(dir, 'artifacts'));
    registerNewsTools(registry, config, artifacts, { ARDENT_TEST_SEARXNG_URL: base, ARDENT_TEST_FIRECRAWL_URL: base });
    const search = await registry.call('news_search', { query: 'topic' }, 'direct', new AbortController().signal);
    expect(search.ok).toBe(true);
    if (!search.ok) throw new Error(search.message);
    const found = search.value as { status: string; results: unknown[] };
    expect(found.status).toBe('partial');
    expect(found.results).toHaveLength(1);
    const collected = await registry.call('news_collect', { query: 'topic' }, 'peer', new AbortController().signal);
    expect(collected.ok).toBe(true);
    if (!collected.ok) throw new Error(collected.message);
    const packet = collected.value as { artifact: { id: string; sha256: string }; articles: { markdown: string }[] };
    expect(packet.articles[0]?.markdown).toContain('Actual extracted text');
    expect(packet.artifact.id).toBe(packet.artifact.sha256);
    expect(Buffer.from(await artifacts.get(packet.artifact.id)).toString()).toContain('Actual extracted text');
    expect((await registry.call('news_article', { url: 'http://127.0.0.1/private' }, 'direct', new AbortController().signal)).ok).toBe(false);
  });
  it('tries a later search result when the top publisher extraction fails', async () => {
    let scrapeCalls = 0;
    const base = await fixture((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.startsWith('/search')) {
        response.end(JSON.stringify({ results: [
          { url: 'https://93.184.216.34/blocked', title: 'Blocked', content: 'Discovery only' },
          { url: 'https://93.184.216.34/available', title: 'Available', content: 'Extractable' }
        ], unresponsive_engines: [] }));
      } else if (request.url === '/v1/scrape') {
        scrapeCalls++;
        let body = '';
        request.on('data', chunk => { body += String(chunk); });
        request.on('end', () => {
          const url = (JSON.parse(body) as { url: string }).url;
          if (url.includes('/blocked')) { response.writeHead(500).end('{}'); return; }
          response.end(JSON.stringify({ success: true, data: { markdown: '# Extracted follow-up result', metadata: { sourceURL: url } } }));
        });
      } else response.writeHead(404).end('{}');
    });
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.research.searxng_url = base;
    config.research.firecrawl_url = base;
    const registry = new ToolRegistry();
    registerNewsTools(registry, config, new ArtifactStore(join(dir, 'artifacts')));
    const result = await registry.call('news_collect', { query: 'publisher update', max_articles: 1 }, 'direct', new AbortController().signal);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const packet = result.value as { coverage: { discovered: number; title_prefiltered: number; extracted: number }; failures: { url: string }[]; articles: { url: string }[] };
    expect(packet.coverage).toEqual({ discovered: 2, title_prefiltered: 0, extracted: 1 });
    expect(packet.failures[0]?.url).toContain('/blocked');
    expect(packet.articles[0]?.url).toContain('/available');
    const filtered = await registry.call('news_collect', { query: 'publisher update', max_articles: 1,
      include_title_terms: ['security', 'breach'] }, 'scheduled', new AbortController().signal);
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) throw new Error(filtered.message);
    expect((filtered.value as { status: string; coverage: { title_prefiltered: number }; articles: unknown[] }))
      .toMatchObject({ status: 'empty', coverage: { title_prefiltered: 2 }, articles: [] });
    expect(scrapeCalls).toBe(2);
    expect((await registry.call('news_collect', { query: 'publisher update',
      include_title_regex: '(.+)+$' }, 'scheduled', new AbortController().signal)).ok).toBe(false);
    expect((await registry.call('news_collect', { query: 'publisher update',
      include_title_terms: [] }, 'scheduled', new AbortController().signal)).ok).toBe(false);
  });
  it('assembles SSE across UTF-8 and CRLF chunk boundaries', async () => {
    const encoded = new TextEncoder().encode('data: {"text":"café"}\r\n\r\ndata: [DONE]\r\n\r\n');
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of encoded) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
    const values: string[] = [];
    for await (const value of sseData(stream)) values.push(value);
    expect(values).toEqual(['{"text":"café"}', '[DONE]']);
  });
  it('ends the SSE response when its consumer stops early', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\ndata: second\n\n')); },
      cancel() { cancelled = true; }
    });
    for await (const value of sseData(stream)) { expect(value).toBe('first'); break; }
    expect(cancelled).toBe(true);
  });
  it('stores identical artifact bytes written at the same instant', async () => {
    const dir = await temp();
    const store = new ArtifactStore(join(dir, 'artifacts'));
    const bytes = Buffer.from('identical deliverable');
    const stored = await Promise.all(Array.from({ length: 16 }, () => store.put('report.txt', 'text/plain', bytes)));
    expect(new Set(stored.map(item => item.id)).size).toBe(1);
    expect(Buffer.from(await store.get(stored[0]!.id)).toString()).toBe('identical deliverable');
    expect((await readdir(join(dir, 'artifacts'))).filter(name => name.startsWith('.'))).toEqual([]);
  });
  it('repairs one non-JSON research answer using only observed source IDs', async () => {
    const sourceUrl = 'https://93.184.216.34/repair-source';
    const sourceId = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16);
    let turns = 0;
    const base = await fixture((request, response) => {
      if (request.url?.startsWith('/search')) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ results: [{ url: sourceUrl, title: 'Fixture source', content: 'Evidence', engines: ['fixture'] }], unresponsive_engines: [] }));
        return;
      }
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      turns++;
      if (turns === 3) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ question: 'What happened?', scope: 'fixture', as_of: new Date().toISOString(), findings: ['An update occurred.'], claims: [{ text: 'An update occurred', source_ids: [sourceId], qualification: 'one source' }], contrary_evidence: [], coverage_gaps: ['Only one source'], artifact_ids: [], answer_markdown: `Update [${sourceId}]` }) } }] }));
        return;
      }
      response.setHeader('Content-Type', 'text/event-stream');
      const delta = turns === 1
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'search-1', type: 'function', function: { name: 'news_search', arguments: '{"query":"fixture"}' } }] } }] }
        : { choices: [{ delta: { content: 'The fixture source says an update occurred.' } }] };
      response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`);
    });
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = base;
    config.providers.llamacpp.model = 'fixture';
    config.research.searxng_url = base;
    const runtime = new ArdentRuntime(dir, config);
    try {
      const task = runtime.accept('Research fixture');
      const result = await runtime.run(task.id);
      expect(result.answer).toContain(sourceId);
      expect(turns).toBe(3);
      expect(runtime.store.events(task.id).some(event => event.kind === 'research_repair_attempt')).toBe(true);
      const budgets = runtime.store.events(task.id).filter(event => event.kind === 'model_input_budget')
        .map(event => event.detail as { step: number; repair?: boolean; input_tokens: number; max_input_tokens: number; tokenizer: string });
      expect(budgets).toHaveLength(3);
      expect(budgets.every(item => item.input_tokens <= item.max_input_tokens && item.tokenizer === 'estimate')).toBe(true);
      expect(budgets.at(-1)).toMatchObject({ step: 1, repair: true });
    } finally { runtime.close(); }
  });
  it('runs a news tool/model round trip with a validated source ID and durable receipt', async () => {
    const sourceUrl = 'https://93.184.216.34/story';
    const sourceId = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16);
    let modelTurns = 0;
    const base = await fixture((request, response) => {
      if (request.url === '/search?') { response.statusCode = 404; response.end('{}'); return; }
      if (request.url?.startsWith('/search')) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ results: [{ url: sourceUrl, title: 'Official update', content: 'New data', engines: ['fixture'] }], unresponsive_engines: [] }));
        return;
      }
      if (request.url === '/v1/chat/completions') {
        modelTurns++;
        response.setHeader('Content-Type', 'text/event-stream');
        const delta = modelTurns === 1
          ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'news_search', arguments: '{"query":"official update"}' } }] } }] }
          : { choices: [{ delta: { content: JSON.stringify({ question: 'What changed?', scope: 'fixture', as_of: new Date().toISOString(), findings: ['The official source reports new data.'], claims: [{ text: 'New data was reported', source_ids: [sourceId], qualification: 'one source' }], contrary_evidence: [], coverage_gaps: ['Only one source was found'], artifact_ids: [], answer_markdown: `Official source [${sourceId}] reports new data.`, source_assessments: [{ source_id: sourceId, reporting_role: 'secondary', basis: 'Search snippet reports an update; original document was not extracted' }] }) } }] };
        response.write(`data: ${JSON.stringify(delta)}\n\n`);
        response.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
        response.end('data: [DONE]\n\n');
        return;
      }
      response.statusCode = 404; response.end('{}');
    });
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.research.searxng_url = base;
    config.providers.llamacpp.base_url = base;
    config.providers.llamacpp.model = 'fixture';
    const runtime = new ArdentRuntime(dir, config, {});
    try {
      const task = runtime.accept('What changed?', 'alice', 'direct', 'request-1');
      const result = await runtime.run(task.id, {});
      expect(result.answer).toContain(sourceId);
      expect(result.answer).toContain(sourceUrl);
      expect(result.answer).toContain('### Sources');
      expect(result.brief?.claims[0]?.source_ids).toEqual([sourceId]);
      expect(runtime.store.get(task.id)?.state).toBe('completed');
      expect(runtime.store.events(task.id).some(event => event.kind === 'tool_result')).toBe(true);
      const budgets = runtime.store.events(task.id).filter(event => event.kind === 'model_input_budget')
        .map(event => event.detail as { input_tokens: number; max_input_tokens: number });
      expect(budgets).toHaveLength(2);
      expect(budgets.every(item => item.input_tokens <= item.max_input_tokens)).toBe(true);
      const artifactEvent = runtime.store.events(task.id).find(event => event.kind === 'research_artifacts');
      expect(artifactEvent).toBeDefined();
      const reportId = (artifactEvent?.detail as { report: { id: string } }).report.id;
      const report = JSON.parse(Buffer.from(await runtime.artifacts.get(reportId)).toString()) as { source_register: { source_id: string; url: string; evidence_kind: string; title: string; retrieved_at: string }[] };
      expect(report.source_register).toEqual([expect.objectContaining({ source_id: sourceId, url: sourceUrl, evidence_kind: 'search_snippet', reporting_role: 'secondary', title: 'Official update', retrieved_at: expect.any(String) })]);
      expect(runtime.accept('What changed?', 'alice', 'direct', 'request-1').id).toBe(task.id);
      expect(modelTurns).toBe(2);
    } finally { runtime.close(); }
  });
  it('gives an ordinary authenticated A2A task bounded public-news tools without a team envelope', async () => {
    const sourceUrl = 'https://93.184.216.34/ordinary-peer-report';
    const sourceId = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16);
    let turns = 0;
    const base = await fixture((request, response) => {
      if (request.url?.startsWith('/search')) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ results: [{ url: sourceUrl, title: 'Publisher report', content: 'A dated observation', engines: ['fixture'] }], unresponsive_engines: [] }));
        return;
      }
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end('{}'); return; }
      turns++;
      const delta = turns === 1
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'peer-search', type: 'function', function: { name: 'news_search', arguments: '{"query":"dated observation"}' } }] } }] }
        : { choices: [{ delta: { content: JSON.stringify({ question: 'What happened?', scope: 'peer', as_of: new Date().toISOString(), findings: ['A publisher reported an observation.'], claims: [{ text: 'A dated observation', source_ids: [sourceId], qualification: 'single search snippet' }], contrary_evidence: [], coverage_gaps: ['Article not extracted'], artifact_ids: [], answer_markdown: 'An attributed publisher report was found.' }) } }] };
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`);
    });
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = base;
    config.providers.llamacpp.model = 'fixture';
    config.research.searxng_url = base;
    const runtime = new ArdentRuntime(dir, config, {});
    try {
      const task = runtime.accept('Find a dated publisher report', 'ordinary-peer', 'peer');
      const result = await runtime.run(task.id, {});
      expect(result.task.state).toBe('completed');
      expect(result.answer).toContain(sourceId);
      expect(runtime.store.events(task.id).some(event => event.kind === 'tool_result' && (event.detail as { name?: string }).name === 'news_search')).toBe(true);
      expect(turns).toBe(2);
    } finally { runtime.close(); }
  });
});

describe('headless management API', () => {
  it('requires a bearer, validates config revisions, and exposes task receipts', async () => {
    const dir = await temp();
    await initTestProfile(dir);
    const loaded = await loadConfig(dir);
    const runtime = new ArdentRuntime(dir, loaded.config, {});
    const app = createArdentApi(runtime, loaded, { ARDENT_API_TOKEN: 'fixture-token' });
    try {
      const client = createArdentManagementClient({ baseUrl: 'http://ardent.test', bearerToken: 'fixture-token', fetch: (input, init) => app.request(new Request(input, init)) });
      const typedStatus = await client.GET('/api/v1/status');
      expect(typedStatus.error).toBeUndefined();
      expect(typedStatus.data?.profile).toBe('assistant');
      expect((await app.request('/health/live')).status).toBe(200);
      expect((await app.request('/health/ready')).status).toBe(503);
      expect((await app.request('/api/v1/config')).status).toBe(401);
      expect((await app.request('/api/v1/tasks', { method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400);
      const headers = { Authorization: 'Bearer fixture-token' };
      const configResponse = await app.request('/api/v1/config', { headers });
      expect(configResponse.status).toBe(200);
      const configSchema = await (await app.request('/api/v1/config/schema', { headers })).json() as { type: string; properties: Record<string, unknown> };
      expect(configSchema.properties).toHaveProperty('schema_version');
      const config = await configResponse.json() as { revision: string; text: string };
      const changed = config.text.replace('name: Assistant', 'name: API Assistant');
      const saved = await app.request('/api/v1/config', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: changed, revision: config.revision }) });
      expect(saved.status).toBe(200);
      const stale = await app.request('/api/v1/config', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: config.text, revision: config.revision }) });
      expect(stale.status).toBe(409);
      const after = await (await app.request('/api/v1/config', { headers })).json() as { text: string };
      expect(after.text).toContain('API Assistant');
      const validation = await app.request('/api/v1/config/validate', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: changed }) });
      expect(validation.status).toBe(200);
      const soul = await (await app.request('/api/v1/identity/soul', { headers })).json() as { text: string; revision: string };
      const edited = await app.request('/api/v1/identity/soul', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `${soul.text}\nUse concise replies.`, revision: soul.revision }) });
      expect(edited.status).toBe(200);
      const editedSoul = await edited.json() as { revision: string };
      expect((await app.request('/api/v1/identity/soul', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: soul.text, revision: soul.revision }) })).status).toBe(409);
      const history = await (await app.request('/api/v1/identity/soul/history', { headers })).json() as { history: { name: string }[] };
      expect(history.history).toHaveLength(1);
      const restored = await app.request('/api/v1/identity/soul/restore', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ history_name: history.history[0]?.name, revision: editedSoul.revision }) });
      expect(restored.status).toBe(200);
      expect((await restored.json() as { revision: string }).revision).toBe(soul.revision);
      expect((await app.request('/api/v1/channels', { headers })).status).toBe(200);
      expect((await app.request('/api/v1/peers', { headers })).status).toBe(200);
      expect((await app.request('/api/v1/peers/config', { headers })).status).toBe(200);
      const memoryStatus = await (await app.request('/api/v1/memory/status', { headers })).json() as { status: string; reason: string };
      expect(memoryStatus.status).toBe('degraded');
      expect(memoryStatus.reason).toMatch(/not configured/);
      const artifact = await runtime.artifacts.put('fixture.bin', 'application/octet-stream', Buffer.from([0, 1, 2]));
      expect((await app.request(`/api/v1/artifacts/${artifact.id}`)).status).toBe(401);
      const downloaded = await app.request(`/api/v1/artifacts/${artifact.id}`, { headers });
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(Buffer.from([0, 1, 2]));
      const task = runtime.accept('Check status');
      expect((await app.request(`/api/v1/tasks/${task.id}`, { headers })).status).toBe(200);
      expect((await app.request(`/api/v1/tasks/${task.id}/events`, { headers })).status).toBe(200);
      expect((await app.request(`/api/v1/tasks/${task.id}/stream`)).status).toBe(401);
      expect((await app.request(`/api/v1/tasks/${task.id}/events?after=invalid`, { headers })).status).toBe(400);
      runtime.store.setState(task.id, 'completed', 'Done');
      const streamed = await app.request(`/api/v1/tasks/${task.id}/stream`, { headers });
      expect(streamed.status).toBe(200);
      expect(streamed.headers.get('content-type')).toContain('text/event-stream');
      expect(await streamed.text()).toContain('event: task.done');
      const spec = await (await app.request('/openapi.json')).json() as { openapi: string; paths: Record<string, Record<string, { operationId: string }>> };
      expect(spec.openapi).toBe('3.1.0');
      const documented = Object.entries(spec.paths).filter(([path]) => !path.startsWith('/a2a/rest/'))
        .flatMap(([path, operations]) => Object.keys(operations).map(method => `${method.toUpperCase()} ${path}`));
      const routed = app.routes.filter(route => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method) && route.path !== '/openapi.json')
        .map(route => `${route.method} ${route.path.replace(/:([A-Za-z_][A-Za-z_0-9]*)/g, '{$1}')}`);
      expect(documented.sort()).toEqual(routed.sort());
      const allOperations = Object.values(spec.paths).flatMap(operations => Object.values(operations).map(operation => operation.operationId));
      expect(new Set(allOperations).size).toBe(allOperations.length);
      for (const path of ['/a2a/rest/message:send', '/a2a/rest/message:stream', '/a2a/rest/tasks', '/a2a/rest/tasks/{taskId}', '/a2a/rest/tasks/{taskId}:cancel', '/a2a/rest/tasks/{taskId}:subscribe'])
        expect(spec.paths[path]).toBeDefined();
    } finally { runtime.close(); }
  });
});

describe('Codex App Server protocol', () => {
  it('reports the tested ChatGPT harness as ready without a model call', async () => {
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.execution.backend = 'codex';
    config.providers.codex.command = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
    config.providers.codex.model = 'fixture-model';
    config.a2a.enabled = false;
    const runtime = new ArdentRuntime(dir, config, {});
    try {
      const app = createArdentApi(runtime, await loadConfig(dir), {});
      const response = await app.request('/health/ready');
      expect(response.status).toBe(200);
    } finally { runtime.close(); }
  });
  it('bridges a typed dynamic tool over structured stdio without API-key fallback', async () => {
    const dir = await temp();
    const registry = new ToolRegistry();
    registry.register(defineTool({ name: 'fixture_search', description: 'Fixture search', input: z.object({ query: z.string() }).strict(), output: z.object({ found: z.literal(true) }), effect: 'read', contexts: ['direct'], timeoutMs: 1000, handler: async () => ({ found: true as const }) }));
    const command = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
    const backend = new CodexHarnessBackend({ command, model: 'fixture-model', auth_mode: 'chatgpt', approval_policy: 'never', sandbox: 'read-only' }, dir, { OPENAI_API_KEY: 'forbidden', CODEX_ACCESS_TOKEN: 'forbidden' });
    const result = await backend.run('Research', 'Use only fixture_search', registry, 'direct', new AbortController().signal, 2);
    expect(result.answer).toBe('Sourced fixture answer');
    expect(result.toolCalls).toBe(1);
  });
  it('executes the configured Codex harness through Ardent task state', async () => {
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.execution.backend = 'codex';
    config.providers.codex.command = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
    config.providers.codex.model = 'fixture-model';
    const env = { ARDENT_FIXTURE_TOOL: 'news_capabilities' };
    const runtime = new ArdentRuntime(dir, config, env);
    try {
      const task = runtime.accept('Give a short response');
      const result = await runtime.run(task.id, env);
      expect(result.answer).toBe('Sourced fixture answer');
      expect(result.task.state).toBe('completed');
      expect(runtime.store.events(task.id).some(event => event.kind === 'tool_result')).toBe(true);
    } finally { runtime.close(); }
  });
});
