import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeExecutionHeader, executionHeaders, type ExecutionContext } from '@hivemagnus/hive-common/execution';
import { parseTraceparent } from '@hivemagnus/hive-common/context';
import { loadConfig, runtimeProblems, type LoadedConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { createArdentApi } from '../src/api.js';
import { createA2ASurface } from '../src/a2a-server.js';
import { ArdentA2AClient } from '../src/a2a-client.js';
import { executionInstance } from '../src/execution.js';
import Database from '../src/sqlite.js';
import { initTestProfile } from './helpers.js';

type ModelRequest = { body: { messages: Array<{ role: string; content: string | null }>; tools?: Array<{ function: { name: string } }> }; headers: IncomingHttpHeaders };
type Turn = { text: string } | { calls: Array<{ name: string; args: unknown }> };

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
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

/** A llama.cpp fixture that plays scripted turns and records every completion request with its headers. */
async function llama(turns: Turn[] = []): Promise<{ url: string; requests: ModelRequest[] }> {
  const requests: ModelRequest[] = [];
  const url = await listen(createServer((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    void body(request).then(text => {
      requests.push({ body: JSON.parse(text) as ModelRequest['body'], headers: request.headers });
      const turn = turns[requests.length - 1] ?? { text: 'Done.' };
      response.setHeader('Content-Type', 'text/event-stream');
      if ('text' in turn) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: turn.text } }] })}\n\n`);
      else turn.calls.forEach((call, index) => response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `call-${requests.length}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] })}\n\n`));
      response.end('data: [DONE]\n\n');
    });
  }));
  return { url, requests };
}

async function profile(modelUrl: string, edit?: (loaded: LoadedConfig) => void): Promise<{ dir: string; loaded: LoadedConfig }> {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-lineage-'));
  dirs.push(dir);
  await initTestProfile(dir);
  const loaded = await loadConfig(dir);
  loaded.config.providers.llamacpp.base_url = modelUrl;
  loaded.config.providers.llamacpp.model = 'fixture';
  loaded.config.research.enabled = false;
  edit?.(loaded);
  return { dir, loaded };
}

function open(dir: string, loaded: LoadedConfig, env: NodeJS.ProcessEnv = { ARDENT_INSTANCE_REF: 'node-a.assistant' }) {
  const runtime = new ArdentRuntime(dir, loaded.config, env);
  const app = createArdentApi(runtime, loaded, { ARDENT_API_TOKEN: 'fixture-token', ...env });
  const headers = { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' };
  const get = async <T>(path: string): Promise<T> => {
    const response = await app.request(path, { headers });
    expect(response.status, path).toBe(200);
    return await response.json() as T;
  };
  const post = (path: string, value: unknown, extra: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
  return { runtime, app, get, post };
}

async function waitDone(runtime: ArdentRuntime, id: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const state = runtime.store.get(id)?.state;
    if (state && !['queued', 'running'].includes(state)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // Join the in-process run, so the runtime can close.
  await runtime.run(id, {}).catch(() => undefined);
}

function mission(overrides: Record<string, unknown> = {}) {
  return { id: 'adventure-1', revision: 1, parent_task: null, constraints: ['Keep it short'], allowed_actions: ['observe', 'analyze', 'create_artifact'],
    resources: ['tool:artifact_write', 'tool:development_note'], deadline: Math.floor(Date.now() / 1000) + 600,
    acceptance_criteria: ['A map exists'], expected_artifacts: [], ...overrides };
}

type TaskView = { id: string; deadline_ms: number; execution?: ExecutionContext };
type Lineage = {
  task_id: string; execution?: ExecutionContext; source?: string; traceparent?: string; parent?: { ref: string; local_task_id?: string };
  children: Array<{ ref: string; local_task_id: string; source: string }>; continuations: unknown[];
  model_attempts: Array<{ step: number; attempt: number; request_id: string | null; ref: string | null; usage: unknown; repair?: boolean }>;
  tools: Array<{ call_id: string; name: string; effect: string | null; state: string }>;
  artifacts: Array<{ sha256: string; name: string; source: string; artifact_id: string | null }>;
};

const studio = { v: 1, request_id: 'req-studio-1', root: 'hx1:studio:inst-1:request:r-1', self: 'hx1:studio:inst-1:node:n-1' } as const;

describe('execution ancestry', () => {
  it('keeps a caller root, mints self, and records the context on the task, the accepted event and lineage', async () => {
    const model = await llama();
    const { dir, loaded } = await profile(model.url);
    const { runtime, get, post } = open(dir, loaded);
    try {
      const submitted = await post('/api/v1/tasks', { prompt: 'Map the river', execution: studio, idempotency_key: 'k-1' });
      expect(submitted.status).toBe(202);
      const { task_id: id } = await submitted.json() as { task_id: string };
      await waitDone(runtime, id);
      const task = await get<TaskView>(`/api/v1/tasks/${id}`);
      expect(task.execution).toEqual({ v: 1, request_id: 'req-studio-1', root: studio.root, parent: studio.self,
        self: `hx1:ardent:node-a.assistant:task:${id}`, deadline_ms: task.deadline_ms });
      const accepted = runtime.store.events(id).find(event => event.kind === 'accepted');
      expect((accepted?.detail as { execution?: unknown }).execution).toEqual(task.execution);
      const listed = await get<{ tasks: TaskView[] }>('/api/v1/tasks');
      expect(listed.tasks.find(item => item.id === id)?.execution).toEqual(task.execution);
      const lineage = await get<Lineage>(`/api/v1/tasks/${id}/lineage`);
      expect(lineage).toMatchObject({ task_id: id, source: 'caller', execution: task.execution, parent: { ref: studio.self }, children: [], continuations: [] });
      expect(parseTraceparent(lineage.traceparent)).toBeDefined();
      // A replay with a different context returns the first task unchanged: ancestry is not part of the digest.
      const replay = await post('/api/v1/tasks', { prompt: 'Map the river', execution: { ...studio, root: 'hx1:studio:inst-1:request:r-2' }, idempotency_key: 'k-1' });
      expect((await replay.json() as { task_id: string }).task_id).toBe(id);
      expect(runtime.store.executionFor(id)?.root).toBe(studio.root);

      // Absent, invalid and unknown-version contexts are never rejected: each task gets a minted root.
      for (const execution of [undefined, 'not-a-context', { v: 2, root: studio.root }, { v: 1, root: 'studio-root' }]) {
        const response = await post('/api/v1/tasks', { prompt: 'Minted', ...(execution === undefined ? {} : { execution }) });
        expect(response.status).toBe(202);
        const minted = (await response.json() as { task_id: string }).task_id;
        await waitDone(runtime, minted);
        const self = `hx1:ardent:node-a.assistant:task:${minted}`;
        expect(runtime.store.executionFor(minted)).toMatchObject({ v: 1, root: self, self });
        expect(runtime.store.executionFor(minted)?.parent).toBeUndefined();
        expect((await get<Lineage>(`/api/v1/tasks/${minted}/lineage`)).source).toBe('minted');
      }

      // The x-hive-execution header is used when the body has no execution; x-request-id fills a missing request id.
      const header = await post('/api/v1/tasks', { prompt: 'From a header' }, { ...executionHeaders({ v: 1, root: studio.root }), 'x-request-id': 'req-hop-7' });
      const fromHeader = (await header.json() as { task_id: string }).task_id;
      await waitDone(runtime, fromHeader);
      expect(runtime.store.executionFor(fromHeader)).toMatchObject({ root: studio.root, parent: studio.root, request_id: 'req-hop-7' });

      // Mission and preview submissions take the same optional field.
      const missionTask = await post('/api/v1/missions', { objective: 'Draw the map', mission: mission(), idempotency_key: 'm-1', execution: studio });
      expect(missionTask.status).toBe(202);
      const missionId = (await missionTask.json() as { task_id: string }).task_id;
      await waitDone(runtime, missionId);
      expect(runtime.store.executionFor(missionId)).toMatchObject({ root: studio.root, parent: studio.self });
      const preview = await post('/api/v1/preview/tasks', { prompt: 'Try the soul', execution: studio });
      expect(preview.status).toBe(202);
      const previewId = (await preview.json() as { task_id: string }).task_id;
      await waitDone(runtime, previewId);
      expect(runtime.store.executionFor(previewId)).toMatchObject({ root: studio.root, parent: studio.self });
    } finally { runtime.close(); }
  });

  it('sends x-request-id, traceparent and x-hive-execution on every llama.cpp completion, journals them, and keeps lineage across a restart', async () => {
    const model = await llama([{ calls: [{ name: 'artifact_write', args: { name: 'map.md', mime: 'text/markdown', text: '# Map\n\nA ford.' } }] }, { text: 'The map is saved.' }]);
    const { dir, loaded } = await profile(model.url);
    let { runtime, get, post } = open(dir, loaded);
    const seen: Array<{ hook: string; execution: unknown }> = [];
    await runtime.usePlugins([{ name: 'ancestry-observer',
      beforeToolCall: (ctx, call) => { seen.push({ hook: 'context', execution: ctx.execution }, { hook: 'beforeToolCall', execution: call.execution }); },
      afterToolCall: (_ctx, call) => { seen.push({ hook: 'afterToolCall', execution: call.execution }); } }], {});
    let id = '';
    try {
      const submitted = await post('/api/v1/missions', { objective: 'Draw the map', mission: mission(), idempotency_key: 'm-2', execution: studio });
      id = (await submitted.json() as { task_id: string }).task_id;
      await waitDone(runtime, id);
      expect(runtime.store.get(id)?.state).toBe('completed');
      const task = await get<TaskView>(`/api/v1/tasks/${id}`);
      const taskRef = `hx1:ardent:node-a.assistant:task:${id}`;
      const started = runtime.store.events(id, 0, 500).filter(event => event.kind === 'model_started').map(event => event.detail as Record<string, unknown>);
      expect(model.requests).toHaveLength(2);
      const lineageBefore = await get<Lineage>(`/api/v1/tasks/${id}/lineage`);
      const taskTrace = parseTraceparent(lineageBefore.traceparent)!;
      for (const [step, request] of model.requests.entries()) {
        const requestId = request.headers['x-request-id'];
        expect(typeof requestId).toBe('string');
        const trace = parseTraceparent(String(request.headers.traceparent));
        expect(trace?.traceId).toBe(taskTrace.traceId);
        expect(trace?.spanId).not.toBe(taskTrace.spanId);
        const context = decodeExecutionHeader(String(request.headers['x-hive-execution']));
        const ref = `hx1:ardent:node-a.assistant:attempt:${id}/${step}/1`;
        expect(context).toEqual({ v: 1, request_id: 'req-studio-1', root: studio.root, parent: taskRef, self: ref, attempt: 1, deadline_ms: task.deadline_ms });
        expect(started[step]).toMatchObject({ backend: 'llamacpp', step, attempt: 1, ref, request_id: requestId, traceparent: request.headers.traceparent });
      }
      expect(model.requests[0]!.headers['x-request-id']).not.toBe(model.requests[1]!.headers['x-request-id']);
      // Plugin hooks see the task's real context.
      expect(seen.map(item => item.hook)).toEqual(['context', 'beforeToolCall', 'afterToolCall']);
      for (const item of seen) expect(item.execution).toEqual(task.execution);
      runtime.close();

      ({ runtime, get, post } = open(dir, loaded));
      const lineage = await get<Lineage>(`/api/v1/tasks/${id}/lineage`);
      expect(lineage).toEqual(lineageBefore);
      expect(lineage.model_attempts.map(item => ({ step: item.step, attempt: item.attempt, ref: item.ref, request_id: item.request_id }))).toEqual(
        model.requests.map((request, step) => ({ step, attempt: 1, ref: `hx1:ardent:node-a.assistant:attempt:${id}/${step}/1`, request_id: request.headers['x-request-id'] })));
      expect(lineage.tools).toEqual([{ call_id: 'call-1-0', name: 'artifact_write', effect: 'artifact-write', state: 'succeeded' }]);
      expect(lineage.artifacts).toMatchObject([{ name: 'map.md', source: 'artifact_registered' }]);
      expect(lineage.artifacts[0]!.artifact_id).toEqual(expect.any(String));
      // The manifest writer's seam: the context of the producing task is joinable by task id.
      expect(runtime.executionFor(id)?.self).toBe(taskRef);
    } finally { runtime.close(); }
  });

  it('carries the root to a child delegated over loopback A2A, whose parent is the delegating task', async () => {
    const childModel = await llama([{ text: 'Child answer.' }]);
    const parent = await profile('http://127.0.0.1:1/');
    const child = await profile(childModel.url, loaded => { loaded.config.a2a.public_url = 'http://127.0.0.1:9900'; });
    const token = 'fixture-token-1234567890';
    await writeFile(join(child.dir, 'peers.yaml'), 'schema_version: 1\npeers:\n  - id: coordinator\n    url: http://127.0.0.1:9900\n    token_env: ARDENT_TEST_PEER_TOKEN\n');
    const childEnv = { ARDENT_TEST_PEER_TOKEN: token, ARDENT_INSTANCE_REF: 'node-b.child' };
    const childRuntime = new ArdentRuntime(child.dir, child.loaded.config, childEnv);
    const parentSide = open(parent.dir, parent.loaded, { ARDENT_INSTANCE_REF: 'node-a.parent' });
    try {
      const surface = await createA2ASurface(childRuntime, child.loaded.config, childEnv);
      const server = surface.app.listen(0, '127.0.0.1');
      servers.push(server);
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No A2A fixture address');
      for (const iface of surface.card.supportedInterfaces) if (iface.protocolBinding !== 'GRPC') iface.url = `http://127.0.0.1:${address.port}/${iface.protocolBinding === 'JSONRPC' ? 'a2a/jsonrpc' : 'a2a/rest'}`;
      const grpc = surface.card.supportedInterfaces.find(iface => iface.protocolBinding === 'GRPC');
      const grpcPort = grpc ? Number(new URL(`http://${grpc.url}`).port) : undefined;
      await writeFile(join(parent.dir, 'peers.yaml'), `schema_version: 1\npeers:\n  - id: child\n    url: http://127.0.0.1:${address.port}\n    token_env: ARDENT_TEST_PEER_TOKEN\n${grpcPort ? `    transport_ports: [${grpcPort}]\n` : ''}`);

      const parentTask = parentSide.runtime.accept('Delegate the research', 'management', 'direct', undefined, undefined, undefined, undefined, { context: studio, source: 'caller' });
      parentSide.runtime.cancel(parentTask.id);
      const client = new ArdentA2AClient(parent.dir, parent.loaded.config, { ARDENT_TEST_PEER_TOKEN: token }, undefined, ['HTTP+JSON']);
      await client.sendWithReceipt('child', 'Return the child answer', undefined, undefined, undefined, { execution: parentSide.runtime.executionFor(parentTask.id) });
      const [delegated] = childRuntime.store.list(10).filter(task => task.caller.startsWith('a2a:'));
      if (!delegated) throw new Error('No delegated task');
      await waitDone(childRuntime, delegated.id);
      const execution = childRuntime.store.executionFor(delegated.id);
      expect(execution).toMatchObject({ root: studio.root, request_id: 'req-studio-1', parent: `hx1:ardent:node-a.parent:task:${parentTask.id}`,
        self: `hx1:ardent:node-b.child:task:${delegated.id}` });
      expect(childRuntime.store.executions.get(delegated.id)?.source).toBe('a2a');
      // The child's model request continues the same tree.
      expect(decodeExecutionHeader(String(childModel.requests[0]!.headers['x-hive-execution']))).toMatchObject({ root: studio.root, parent: execution?.self });

      // A message without hiveExecution gets a minted root on the child.
      await client.sendWithReceipt('child', 'Return another answer');
      const plain = childRuntime.store.list(10).find(task => task.caller.startsWith('a2a:') && task.id !== delegated.id);
      if (!plain) throw new Error('No plain task');
      await waitDone(childRuntime, plain.id);
      expect(childRuntime.store.executions.get(plain.id)).toMatchObject({ source: 'minted', root_ref: `hx1:ardent:node-b.child:task:${plain.id}`, parent_ref: null });
      surface.grpcServer.forceShutdown();
    } finally { parentSide.runtime.close(); childRuntime.close(); }
  });

  it('lists a local child under its parent and resolves the parent locally', async () => {
    const { dir, loaded } = await profile('http://127.0.0.1:1/');
    const { runtime, get } = open(dir, loaded);
    try {
      const parentTask = runtime.accept('Parent');
      runtime.cancel(parentTask.id);
      const childTask = runtime.accept('Child', 'a2a::peer', 'peer', 'msg-1', undefined, undefined, undefined, { context: runtime.executionFor(parentTask.id), source: 'a2a' });
      runtime.cancel(childTask.id);
      const parentLineage = await get<Lineage>(`/api/v1/tasks/${parentTask.id}/lineage`);
      expect(parentLineage.children).toEqual([expect.objectContaining({ local_task_id: childTask.id, source: 'a2a', ref: `hx1:ardent:node-a.assistant:task:${childTask.id}` })]);
      expect(parentLineage.continuations).toEqual([]);
      expect((await get<Lineage>(`/api/v1/tasks/${childTask.id}/lineage`)).parent).toEqual({ ref: `hx1:ardent:node-a.assistant:task:${parentTask.id}`, local_task_id: parentTask.id });
    } finally { runtime.close(); }
  });

  it('serves a task accepted before ancestry existed without execution on every endpoint', async () => {
    const model = await llama([{ text: 'First.' }, { text: 'Second.' }]);
    const { dir, loaded } = await profile(model.url);
    let { runtime, get, post } = open(dir, loaded);
    let done = '';
    let queued = '';
    try {
      done = (await (await post('/api/v1/tasks', { prompt: 'Old finished task' })).json() as { task_id: string }).task_id;
      await waitDone(runtime, done);
      queued = runtime.accept('Old queued task').id;
      runtime.close();
      // An older database has no task_execution table and no execution in its accepted events.
      const db = new Database(join(dir, 'state', 'ardent.sqlite'));
      db.exec('DROP TABLE task_execution');
      db.prepare("UPDATE events SET detail_json=json_remove(detail_json,'$.execution') WHERE kind='accepted'").run();
      db.close();
      ({ runtime, get, post } = open(dir, loaded));
      for (const id of [done, queued]) {
        expect((await get<TaskView>(`/api/v1/tasks/${id}`)).execution).toBeUndefined();
        expect((await get<{ events: unknown[] }>(`/api/v1/tasks/${id}/events`)).events.length).toBeGreaterThan(0);
        await get(`/api/v1/tasks/${id}/artifacts`);
      }
      expect((await get<{ tasks: TaskView[] }>('/api/v1/tasks')).tasks.every(task => task.execution === undefined)).toBe(true);
      const lineage = await get<Lineage>(`/api/v1/tasks/${done}/lineage`);
      expect(lineage.execution).toBeUndefined();
      expect(lineage.parent).toBeUndefined();
      expect(lineage.children).toEqual([]);
      expect(lineage.model_attempts).toEqual([expect.objectContaining({ step: 0, attempt: 1 })]);
      // The queued pre-upgrade task still runs, and its model request still carries a context rooted at the task.
      await runtime.run(queued, {});
      const context = decodeExecutionHeader(String(model.requests[1]!.headers['x-hive-execution']));
      expect(context).toMatchObject({ root: `hx1:ardent:node-a.assistant:task:${queued}`, self: `hx1:ardent:node-a.assistant:attempt:${queued}/0/1` });
      expect(runtime.store.executionFor(queued)).toBeUndefined();
      const stream = runtime.store.events(queued, 0, 500);
      expect(stream.some(event => event.kind === 'model_started')).toBe(true);
      expect((await (await post(`/api/v1/tasks/${queued}/pause`, {})).json() as { error?: { code: string } }).error?.code).toBe('CONFLICT');
    } finally { runtime.close(); }
  });

  it('never widens tools or memory scope for forged or changed ancestry', async () => {
    const searches: unknown[] = [];
    const hivemem = await listen(createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/capabilities') { response.end(JSON.stringify({ retrieval: 'lexical', storage: 'sqlite' })); return; }
      void body(request).then(text => { searches.push(JSON.parse(text)); response.end(JSON.stringify({ results: [] })); });
    }));
    const model = await llama();
    const { dir, loaded } = await profile(model.url, value => {
      value.config.memory = { provider: 'hivemem', base_url: hivemem, token_env: 'HIVEMEM_TOKEN', agent_id: 'assistant', workspace_id: 'ws-1', default_scope: 'private' };
    });
    const { runtime, post } = open(dir, loaded, { ARDENT_INSTANCE_REF: 'node-a.assistant', HIVEMEM_TOKEN: 'fixture-token' });
    try {
      // A broad mission whose task ref the forged contexts claim as their parent and root.
      const broad = await post('/api/v1/missions', { objective: 'Broad', idempotency_key: 'broad', mission: mission({ id: 'broad', resources: ['tool:artifact_write', 'tool:development_note', 'tool:team_handoff', 'project:p2'] }) });
      const broadId = (await broad.json() as { task_id: string }).task_id;
      await waitDone(runtime, broadId);
      const broadRef = `hx1:ardent:node-a.assistant:task:${broadId}`;
      const forged = [undefined, { v: 1, root: broadRef, self: broadRef },
        { v: 1, root: 'hx1:magnus:fleet:mission:all', parent: broadRef, self: 'hx1:magnus:fleet:task:admin', inputs: [broadRef] }];
      const offered: string[][] = [];
      const scopes: unknown[] = [];
      for (const [index, execution] of forged.entries()) {
        const before = searches.length;
        const submitted = await post('/api/v1/missions', { objective: 'Narrow', idempotency_key: `narrow-${index}`, mission: mission({ id: 'narrow', resources: ['tool:development_note', 'project:p1'] }),
          ...(execution ? { execution } : {}) });
        const id = (await submitted.json() as { task_id: string }).task_id;
        await waitDone(runtime, id);
        offered.push((model.requests.at(-1)!.body.tools ?? []).map(tool => tool.function.name).sort());
        scopes.push({ searches: searches.slice(before), event: runtime.store.events(id, 0, 500).find(event => event.kind === 'memory_context')?.detail });
      }
      // A row changed in place before the task runs is ignored as well.
      const changed = runtime.acceptMission({ objective: 'Narrow', idempotency_key: 'narrow-changed', mission: mission({ id: 'narrow', resources: ['tool:development_note', 'project:p1'] }) });
      runtime.store.db.prepare('UPDATE task_execution SET root_ref=?, parent_ref=?, context_json=? WHERE task_id=?')
        .run(broadRef, broadRef, JSON.stringify({ execution: { v: 1, root: broadRef, parent: broadRef, self: broadRef }, traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' }), changed.id);
      const before = searches.length;
      await runtime.run(changed.id, { HIVEMEM_TOKEN: 'fixture-token' });
      offered.push((model.requests.at(-1)!.body.tools ?? []).map(tool => tool.function.name).sort());
      scopes.push({ searches: searches.slice(before), event: runtime.store.events(changed.id, 0, 500).find(event => event.kind === 'memory_context')?.detail });
      expect(offered[0]).toEqual(['development_note']);
      for (const item of offered) expect(item).toEqual(offered[0]);
      expect(scopes[0]).toMatchObject({ event: { scope: 'private+shared', project_id: 'p1' } });
      for (const item of scopes) expect(item).toEqual(scopes[0]);
    } finally { runtime.close(); }
  });

  it('keeps ancestry out of the modules that select tools, memory and team-child admission', async () => {
    for (const file of ['team-child.ts', 'missions.ts', 'mission-tools.ts', 'memory-tools.ts', 'memory.ts', 'tools.ts', 'team-contract.ts']) {
      const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/task_execution|\.executions\b|executionFor\(/);
    }
  });

  it('validates ARDENT_INSTANCE_REF', async () => {
    expect(executionInstance('assistant', {})).toBe('local.assistant');
    expect(executionInstance('assistant', { ARDENT_INSTANCE_REF: '' })).toBe('local.assistant');
    expect(executionInstance('assistant', { ARDENT_INSTANCE_REF: 'node-7.assistant' })).toBe('node-7.assistant');
    for (const bad of ['node 7', 'node:7', 'node/7', 'x'.repeat(97), 'nöde']) expect(() => executionInstance('assistant', { ARDENT_INSTANCE_REF: bad })).toThrow(/ARDENT_INSTANCE_REF/);
    const { dir, loaded } = await profile('http://127.0.0.1:1/');
    expect(() => new ArdentRuntime(dir, loaded.config, { ARDENT_INSTANCE_REF: 'node:7' })).toThrow(/ARDENT_INSTANCE_REF/);
    expect(runtimeProblems(loaded.config, { ARDENT_INSTANCE_REF: 'node:7' })).toEqual(expect.arrayContaining([expect.stringMatching(/ARDENT_INSTANCE_REF/)]));
    expect(runtimeProblems(loaded.config, { ARDENT_INSTANCE_REF: 'node-7.assistant' }).some(problem => problem.includes('ARDENT_INSTANCE_REF'))).toBe(false);
    const runtime = new ArdentRuntime(dir, loaded.config, {});
    try {
      const task = runtime.accept('Standalone');
      runtime.cancel(task.id);
      expect(runtime.executionFor(task.id)?.self).toBe(`hx1:ardent:local.${loaded.config.profile}:task:${task.id}`);
    } finally { runtime.close(); }
  });
});
