import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArdentClient, direct } from '../client/src/index.js';
import { createArdentApi } from '../src/api.js';
import { loadConfig, type ArdentConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { initTestProfile } from './helpers.js';

const token = 'fixture-management-token';
const headers = { Authorization: `Bearer ${token}` };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function setup(configure?: (config: ArdentConfig) => void, extraEnv: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-task-list-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await initTestProfile(dir);
  const loaded = await loadConfig(dir);
  configure?.(loaded.config);
  const env: NodeJS.ProcessEnv = { ARDENT_API_TOKEN: token, ...extraEnv };
  const runtime = new ArdentRuntime(dir, loaded.config, env);
  cleanup.push(() => runtime.close());
  return { runtime, env, app: createArdentApi(runtime, loaded, env) };
}
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return `http://127.0.0.1:${address.port}/`;
}
/** Read an SSE response body as it arrives. */
function sseReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const state = { body: '', ended: false };
  cleanup.push(() => reader.cancel().catch(() => undefined));
  // A read that outlives a timeout is kept for the next call, so no chunk is lost.
  let pending: ReturnType<typeof reader.read> | undefined;
  const next = async (ms: number): Promise<boolean> => {
    pending ??= reader.read();
    const part = await Promise.race([pending, new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ms))]);
    if (part === 'timeout') return false;
    pending = undefined;
    if (part.done) { state.ended = true; return false; }
    state.body += decoder.decode(part.value, { stream: true });
    return true;
  };
  return {
    state,
    async until(needle: string, ms = 5000): Promise<boolean> {
      const deadline = Date.now() + ms;
      while (!state.body.includes(needle) && !state.ended && Date.now() < deadline) await next(deadline - Date.now());
      return state.body.includes(needle);
    },
    async end(ms = 5000): Promise<void> {
      const deadline = Date.now() + ms;
      while (!state.ended && Date.now() < deadline) await next(deadline - Date.now());
      if (!state.ended) throw new Error('The stream did not end');
    },
    /** Sequences of the task.event frames, in order. */
    sequences: () => [...state.body.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1])),
  };
}
type Page = { tasks: Array<{ id: string; state: string; caller: string; context: string; created_ms: number }>; next: string | null };

describe('GET /api/v1/tasks pagination and filters', () => {
  it('pages through every task newest first with a cursor', async () => {
    const { runtime, app } = await setup();
    let now = 1_790_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const ids: string[] = [];
    // Two tasks share a creation time so the cursor must break the tie by id.
    for (let index = 0; index < 7; index += 1) { if (index !== 3) now += 1000; ids.push(runtime.accept(`Prompt ${index}`, index % 2 ? 'peer-a' : 'management').id); }
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const response = await app.request(`/api/v1/tasks?limit=3${after ? `&after=${after}` : ''}`, { headers });
      expect(response.status).toBe(200);
      const page = await response.json() as Page;
      seen.push(...page.tasks.map(task => task.id));
      after = page.next;
      pages += 1;
    } while (after);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect(seen.map(id => runtime.store.get(id)!.created_ms)).toEqual([...seen.map(id => runtime.store.get(id)!.created_ms)].sort((a, b) => b - a));
    // The last page says so; an old client that ignores next still gets the newest tasks.
    const all = await (await app.request('/api/v1/tasks', { headers })).json() as Page;
    expect(all.tasks).toHaveLength(7);
    expect(all.next).toBeNull();
    expect(all.tasks[0]!.id).toBe(ids[6]);
  });

  it('filters by state, context, caller and time, and refuses bad filters', async () => {
    const { runtime, app } = await setup();
    let now = 1_790_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const first = runtime.accept('First', 'management');
    now += 60_000;
    const second = runtime.accept('Second', 'peer-a', 'peer');
    now += 60_000;
    const third = runtime.accept('Third', 'management');
    runtime.store.setState(third.id, 'failed', null, 'fixture');
    const list = async (query: string) => (await (await app.request(`/api/v1/tasks?${query}`, { headers })).json() as Page).tasks.map(task => task.id);
    expect(await list('state=failed')).toEqual([third.id]);
    expect(await list('state=queued,failed')).toEqual([third.id, second.id, first.id]);
    expect(await list('context=peer')).toEqual([second.id]);
    expect(await list('caller=management')).toEqual([third.id, first.id]);
    expect(await list(`since=${first.created_ms + 1}`)).toEqual([third.id, second.id]);
    expect(await list(`since=${new Date(second.created_ms).toISOString()}&until=${third.created_ms}`)).toEqual([second.id]);
    for (const bad of ['state=done', 'context=other', 'since=yesterday', 'after=not-a-cursor', 'limit=101'])
      expect((await app.request(`/api/v1/tasks?${bad}`, { headers })).status, bad).toBe(400);
  });
});

describe('task stream', () => {
  it('wakes on a journal append instead of polling', async () => {
    const { runtime, app } = await setup();
    const task = runtime.accept('Prompt', 'management');
    const response = await app.request(`/api/v1/tasks/${task.id}/stream`, { headers });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    const readUntil = async (needle: string, ms: number) => {
      const deadline = Date.now() + ms;
      while (!body.includes(needle)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        const part = await Promise.race([reader.read(), new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), remaining))]);
        if (part === 'timeout') return false;
        if (part.done) return body.includes(needle);
        body += decoder.decode(part.value, { stream: true });
      }
      return true;
    };
    cleanup.push(() => reader.cancel().catch(() => undefined));
    expect(await readUntil('"kind":"accepted"', 2000)).toBe(true);
    // A journal event reaches the stream well before the one-second fallback poll.
    const appended = Date.now();
    runtime.store.append(task.id, 'fixture_event', { n: 1 });
    expect(await readUntil('fixture_event', 2000)).toBe(true);
    expect(Date.now() - appended).toBeLessThan(500);
    runtime.store.setState(task.id, 'cancelled', null, null);
    expect(await readUntil('task.done', 2000)).toBe(true);
  });

  it('sends a keepalive comment on an idle stream', async () => {
    const { runtime, app } = await setup();
    const task = runtime.accept('Prompt', 'management');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const response = await app.request(`/api/v1/tasks/${task.id}/stream`, { headers });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    const pump = (async () => { for (let part = await reader.read(); !part.done; part = await reader.read()) body += decoder.decode(part.value, { stream: true }); })();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(body).toContain(': keepalive');
    runtime.store.setState(task.id, 'cancelled', null, null);
    await vi.advanceTimersByTimeAsync(2_000);
    await pump;
    expect(body).toContain('task.done');
  });
  it('sends every event before task.done when the task finishes while the stream writes', async () => {
    const { runtime, app } = await setup();
    const task = runtime.accept('Prompt', 'management');
    runtime.store.startQueued(task.id);
    // Finish the task right after the stream has read a page of events, before it writes
    // them: the final state event must still reach the stream before task.done.
    const original = runtime.store.events.bind(runtime.store);
    let armed = false;
    runtime.store.events = (id, after, limit) => {
      const rows = original(id, after, limit);
      if (armed && rows.length) { armed = false; queueMicrotask(() => runtime.store.setState(task.id, 'completed', 'done', null)); }
      return rows;
    };
    const stream = sseReader(await app.request(`/api/v1/tasks/${task.id}/stream`, { headers }));
    expect(await stream.until('"to":"running"')).toBe(true);
    armed = true;
    runtime.store.append(task.id, 'model_result', { step: 1 });
    await stream.end();
    expect(stream.sequences()).toEqual(original(task.id).map(event => event.sequence));
    expect(stream.state.body.trimEnd().split('\n\n').at(-1)).toMatch(/^event: task\.done\n/);
  });

  it('keeps a full page from ending the stream', async () => {
    const { runtime, app } = await setup();
    const task = runtime.accept('Prompt', 'management');
    for (let index = 0; index < 150; index += 1) runtime.store.append(task.id, 'fixture_event', { index });
    runtime.store.setState(task.id, 'cancelled', null, null);
    const stream = sseReader(await app.request(`/api/v1/tasks/${task.id}/stream`, { headers }));
    await stream.end();
    expect(stream.sequences()).toEqual(runtime.store.events(task.id, 0, 500).map(event => event.sequence));
    expect(stream.state.body).toContain('event: task.done');
  });

  it('holds task.done until a finished research task has journaled its memory write', async () => {
    const sourceUrl = 'https://93.184.216.34/story';
    const sourceId = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16);
    let modelTurns = 0;
    let releaseMemory: (() => void) | undefined;
    const memoryRequested = new Promise<void>(resolve => { releaseMemory = resolve; }).then(() => undefined);
    let memoryWrite: (() => void) | undefined;
    const memoryWriteStarted = new Promise<void>(resolve => { memoryWrite = resolve; });
    const base = await listen((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.startsWith('/search')) {
        response.end(JSON.stringify({ results: [{ url: sourceUrl, title: 'Official update', content: 'New data', engines: ['fixture'] }], unresponsive_engines: [] }));
        return;
      }
      if (request.url === '/v1/capabilities') { response.end(JSON.stringify({ retrieval: 'lexical', storage: 'sqlite' })); return; }
      if (request.url === '/v1/memories/search') { response.end(JSON.stringify({ results: [] })); return; }
      if (request.url === '/v1/memories' && request.method === 'POST') {
        // HiveMem answers the memory write only when the test releases it.
        memoryWrite?.();
        void memoryRequested.then(() => response.end(JSON.stringify({ id: 'memory-1', agent_id: 'assistant', content: 'Observation', scope: 'private', workspace_id: 'ws-1' })));
        return;
      }
      if (request.url === '/v1/chat/completions') {
        modelTurns++;
        response.setHeader('Content-Type', 'text/event-stream');
        const delta = modelTurns === 1
          ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'news_search', arguments: '{"query":"official update"}' } }] } }] }
          : { choices: [{ delta: { content: JSON.stringify({ question: 'What changed?', scope: 'fixture', as_of: new Date().toISOString(), findings: ['The official source reports new data for the fixture.'], claims: [{ text: 'New data was reported', source_ids: [sourceId], qualification: 'one source' }], contrary_evidence: [], coverage_gaps: [], artifact_ids: [], answer_markdown: `Official source [${sourceId}] reports new data.`, source_assessments: [{ source_id: sourceId, reporting_role: 'secondary', basis: 'Search snippet only' }] }) } }] };
        response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`);
        return;
      }
      response.statusCode = 404; response.end('{}');
    });
    const { runtime, app, env } = await setup(config => {
      config.research.searxng_url = base;
      config.providers.llamacpp.base_url = base;
      config.providers.llamacpp.model = 'fixture';
      config.memory = { provider: 'hivemem', base_url: base, token_env: 'HIVEMEM_TOKEN', agent_id: 'assistant', workspace_id: 'ws-1', default_scope: 'private' };
    }, { HIVEMEM_TOKEN: 'fixture-token' });
    const task = runtime.accept('What changed?', 'management', 'direct', 'request-1');
    const run = runtime.run(task.id, env);
    const stream = sseReader(await app.request(`/api/v1/tasks/${task.id}/stream`, { headers }));
    // A client following through @hivemagnus/ardent-client sees the same events.
    const client = createArdentClient({ transport: direct({ baseUrl: 'http://ardent.test', getToken: () => token, fetch: (input, init) => app.request(new Request(input, init)) }) });
    const followed: string[] = [];
    const following = client.tasks.follow(task.id, { onEvent: event => { followed.push(event.kind); } });
    await memoryWriteStarted;
    expect(runtime.store.get(task.id)?.state).toBe('completed');
    expect(await stream.until('"to":"completed"')).toBe(true);
    // The task is completed, but its run is still writing memory: no task.done yet.
    expect(await stream.until('task.done', 300)).toBe(false);
    releaseMemory?.();
    await run;
    await stream.end();
    const journal = runtime.store.events(task.id);
    expect(journal.map(event => event.kind).slice(-2)).toEqual(['method_reflection', 'memory_stored']);
    expect(stream.sequences()).toEqual(journal.map(event => event.sequence));
    expect((await following).state).toBe('completed');
    expect(followed).toEqual(journal.map(event => event.kind));
  });
});
