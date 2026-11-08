import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { createArdentApi } from '../src/api.js';
import { initTestProfile } from './helpers.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Reply = { text: string } | { call: { name: string; args: unknown } };
/** A llama.cpp fixture whose replies are released by the test, one request at a time. */
async function gatedModel(reply: (prompt: string, index: number) => Reply) {
  const requests: Array<{ prompt: string; release: () => void }> = [];
  const server = createServer((request: IncomingMessage, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let text = '';
    request.on('data', chunk => { text += String(chunk); });
    request.on('end', () => {
      const body = JSON.parse(text) as { messages: Array<{ role: string; content: string | null }> };
      const prompt = String(body.messages.find(message => message.role === 'user')?.content ?? '');
      const index = requests.length;
      requests.push({ prompt, release: () => {
        const value = reply(prompt, index);
        response.setHeader('Content-Type', 'text/event-stream');
        const delta = 'text' in value ? { content: value.text }
          : { tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: { name: value.call.name, arguments: JSON.stringify(value.call.args) } }] };
        response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
      } });
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return { url: `http://127.0.0.1:${address.port}/`, requests };
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Timed out waiting for ${label}`);
}

async function setup(url: string) {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-pause-'));
  dirs.push(dir);
  await initTestProfile(dir);
  const loaded = await loadConfig(dir);
  loaded.config.providers.llamacpp.base_url = url;
  loaded.config.providers.llamacpp.model = 'fixture';
  loaded.config.research.enabled = false;
  const runtime = new ArdentRuntime(dir, loaded.config, {});
  const app = createArdentApi(runtime, loaded, { ARDENT_API_TOKEN: 'fixture-token' });
  const headers = { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' };
  const submit = async (prompt: string) => (await (await app.request('/api/v1/tasks', { method: 'POST', headers, body: JSON.stringify({ prompt }) })).json() as { task_id: string }).task_id;
  const post = (path: string) => app.request(path, { method: 'POST', headers });
  return { runtime, submit, post };
}

describe('task pause and resume', () => {
  it('holds a running task at the next step boundary until it is resumed', async () => {
    const model = await gatedModel((_prompt, index) => index === 0
      ? { call: { name: 'development_note', args: { kind: 'method', title: 'Outline', body: 'Outline first.' } } } : { text: 'Done.' });
    const { runtime, submit, post } = await setup(model.url);
    try {
      const id = await submit('Write a note');
      await until(() => model.requests.length === 1, 'first model call');
      const paused = await post(`/api/v1/tasks/${id}/pause`);
      expect(await paused.json()).toEqual({ task_id: id, state: 'running', admission: 'paused' });
      expect((await (await post(`/api/v1/tasks/${id}/pause`)).json() as { admission: string }).admission).toBe('paused');
      model.requests[0]!.release();
      await until(() => runtime.store.events(id, 0, 500).some(event => event.kind === 'paused'), 'pause at a step boundary');
      await new Promise(resolve => setTimeout(resolve, 150));
      const kinds = () => runtime.store.events(id, 0, 500).map(event => event.kind);
      expect(kinds()).not.toContain('tool_attempt');
      expect(runtime.store.get(id)?.state).toBe('running');
      expect(kinds().filter(kind => kind === 'pause_requested')).toHaveLength(1);
      expect(await (await post(`/api/v1/tasks/${id}/resume`)).json()).toEqual({ task_id: id, state: 'running', admission: 'open' });
      await until(() => model.requests.length === 2, 'second model call');
      model.requests[1]!.release();
      await until(() => runtime.store.get(id)?.state === 'completed', 'completion');
      expect(kinds().filter(kind => ['pause_requested', 'paused', 'resumed', 'tool_attempt'].includes(kind))).toEqual(['pause_requested', 'paused', 'resumed', 'tool_attempt']);
      expect((await (await post(`/api/v1/tasks/${id}/resume`)).json() as { admission: string }).admission).toBe('open');
      expect((await post(`/api/v1/tasks/${id}/pause`)).status).toBe(409);
      expect((await post('/api/v1/tasks/absent/pause')).status).toBe(404);
    } finally { runtime.close(); }
  });

  it('keeps a paused queued task from starting while later work runs, and cancels it cleanly', async () => {
    const model = await gatedModel(prompt => ({ text: `Reply to ${prompt}` }));
    const { runtime, submit, post } = await setup(model.url);
    try {
      const first = await submit('first');
      await until(() => model.requests.length === 1, 'first call');
      const held = await submit('held');
      const later = await submit('later');
      const dropped = await submit('dropped');
      expect((await post(`/api/v1/tasks/${held}/pause`)).status).toBe(200);
      expect((await post(`/api/v1/tasks/${dropped}/pause`)).status).toBe(200);
      model.requests[0]!.release();
      await until(() => model.requests.length === 2, 'second call');
      expect(model.requests[1]!.prompt).toBe('later');
      model.requests[1]!.release();
      await until(() => runtime.store.get(later)?.state === 'completed', 'later completion');
      expect(runtime.store.get(held)?.state).toBe('queued');
      expect(runtime.store.events(held).find(event => event.kind === 'paused')?.detail).toEqual({ boundary: 'start' });
      expect(runtime.cancel(dropped).state).toBe('cancelled');
      expect((await post(`/api/v1/tasks/${held}/resume`)).status).toBe(200);
      await until(() => model.requests.length === 3, 'resumed call');
      expect(model.requests[2]!.prompt).toBe('held');
      model.requests[2]!.release();
      await until(() => runtime.store.get(held)?.state === 'completed', 'held completion');
      expect(runtime.store.get(first)?.state).toBe('completed');
      expect(await runtime.drain(1000)).toBe(true);
    } finally { runtime.close(); }
  });

  it('releases parked work on drain without settling it', async () => {
    const model = await gatedModel(prompt => ({ text: prompt }));
    const { runtime } = await setup(model.url);
    try {
      const task = runtime.accept('later', 'management');
      runtime.pause(task.id);
      const run = runtime.run(task.id, {});
      await expect(runtime.drain(1000)).resolves.toBe(true);
      await expect(run).rejects.toThrow(/paused/);
      expect(runtime.store.get(task.id)?.state).toBe('queued');
      expect(runtime.store.taskAdmission(task.id)).toBe('paused');
    } finally { runtime.close(); }
  });
});
