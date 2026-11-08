import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { createArdentApi } from '../src/api.js';
import { LiveTextHub, PlainTextFilter, type LiveTextUpdate } from '../src/live-text.js';
import { initTestProfile } from './helpers.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('PlainTextFilter', () => {
  it('passes plain text through and holds leading whitespace until the reply starts', () => {
    const filter = new PlainTextFilter();
    expect(filter.push('\n ', 0)).toEqual({ step: 0, text: '', started: false });
    expect(filter.push('The bridge', 0)).toEqual({ step: 0, text: '\n The bridge', started: true });
    expect(filter.push(' holds.', 0)).toEqual({ step: 0, text: ' holds.', started: false });
    expect(filter.text).toBe('\n The bridge holds.');
    expect(filter.mode).toBe('plain');
  });
  it('never shows structured output and starts over for each model step', () => {
    const filter = new PlainTextFilter();
    expect(filter.push(' {"question":', 0).text).toBe('');
    expect(filter.push('"x"}', 0).text).toBe('');
    expect(filter.mode).toBe('structured');
    expect(filter.text).toBe('');
    expect(filter.push('Answer', 1)).toEqual({ step: 1, text: 'Answer', started: true });
    expect(filter.push('[not json', 2).text).toBe('');
  });
});

describe('LiveTextHub', () => {
  it('sends a text snapshot at the start of a step, then deltas, then end', () => {
    const hub = new LiveTextHub();
    const updates: LiveTextUpdate[] = [];
    hub.subscribe('t1', update => updates.push(update));
    hub.push('t1', 'Hello', 0);
    hub.push('t1', ' there', 0);
    expect(hub.snapshot('t1')).toEqual({ step: 0, text: 'Hello there' });
    hub.push('t1', 'Next', 1);
    hub.end('t1');
    expect(updates).toEqual([
      { kind: 'text', step: 0, text: 'Hello' },
      { kind: 'delta', step: 0, text: ' there' },
      { kind: 'text', step: 1, text: 'Next' },
      { kind: 'end' },
    ]);
    expect(hub.snapshot('t1')).toBeUndefined();
  });
  it('isolates a failing subscriber and forgets idle subscriptions', () => {
    const hub = new LiveTextHub();
    const seen: string[] = [];
    hub.subscribe('t2', () => { throw new Error('subscriber failed'); });
    hub.subscribe('t2', update => { if (update.kind !== 'end') seen.push(update.text); });
    hub.push('t2', 'Still delivered', 0);
    expect(seen).toEqual(['Still delivered']);
    const unsubscribe = hub.subscribe('idle', () => undefined);
    unsubscribe();
    expect(hub.snapshot('idle')).toBeUndefined();
  });
});

describe('management task stream', () => {
  it('streams the visible reply live without journaling it', async () => {
    let release: () => void = () => undefined;
    const released = new Promise<void>(resolve => { release = resolve; });
    const server = createServer((request, response: ServerResponse) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', 'text/event-stream');
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'The ford ' } }] })}\n\n`);
      void released.then(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'is shallow.' } }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture address');
    const dir = await mkdtemp(join(tmpdir(), 'ardent-live-'));
    dirs.push(dir);
    await initTestProfile(dir);
    const loaded = await loadConfig(dir);
    loaded.config.providers.llamacpp.base_url = `http://127.0.0.1:${address.port}/`;
    loaded.config.providers.llamacpp.model = 'fixture';
    loaded.config.research.enabled = false;
    const runtime = new ArdentRuntime(dir, loaded.config, {});
    const app = createArdentApi(runtime, loaded, { ARDENT_API_TOKEN: 'fixture-token' });
    const headers = { Authorization: 'Bearer fixture-token' };
    try {
      const submitted = await app.request('/api/v1/tasks', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Describe the ford' }) });
      expect(submitted.status).toBe(202);
      const { task_id: taskId } = await submitted.json() as { task_id: string };
      const response = await app.request(`/api/v1/tasks/${taskId}/stream`, { headers });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let body = '';
      while (!body.includes('event: task.text')) {
        const part = await reader.read();
        if (part.done) throw new Error(`Stream ended early: ${body}`);
        body += decoder.decode(part.value, { stream: true });
      }
      // The first words are visible while the model is still generating.
      expect(runtime.store.get(taskId)?.state).toBe('running');
      release();
      for (let part = await reader.read(); !part.done; part = await reader.read()) body += decoder.decode(part.value, { stream: true });
      const frames = body.split('\n\n').filter(Boolean).map(frame => Object.fromEntries(frame.split('\n').map(line => {
        const index = line.indexOf(': ');
        return [line.slice(0, index), line.slice(index + 2)];
      })) as Record<string, string>);
      const live = frames.filter(frame => frame.event === 'task.text' || frame.event === 'task.delta');
      expect(live.every(frame => frame.id === undefined)).toBe(true);
      expect(live.map(frame => (JSON.parse(frame.data!) as { text: string }).text).join('')).toBe('The ford is shallow.');
      expect(live[0]?.event).toBe('task.text');
      expect(frames.at(-1)?.event).toBe('task.done');
      expect((JSON.parse(frames.at(-1)!.data!) as { result: string }).result).toBe('The ford is shallow.');
      expect(runtime.store.events(taskId).some(event => JSON.stringify(event.detail).includes('text_delta'))).toBe(false);
      expect(runtime.liveText.snapshot(taskId)).toBeUndefined();
    } finally { runtime.close(); }
  });
});
