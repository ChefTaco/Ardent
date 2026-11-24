import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { isConfigNotice, loadConfig, maxParallelTasks, parseConfig, runtimeProblems } from '../src/config.js';
import { initTestProfile } from './helpers.js';
import { ArdentRuntime } from '../src/runtime.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('bounded runtime scheduling', () => {
  it('runs different callers fairly, serializes each caller, and cancels queued work without a model call', async () => {
    const active = new Set<string>();
    const started: string[] = [];
    let maxConcurrent = 0;
    const server = createServer((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] };
        const prompt = parsed.messages.findLast(item => item.role === 'user')?.content ?? '';
        started.push(prompt);
        active.add(prompt);
        maxConcurrent = Math.max(maxConcurrent, active.size);
        response.setHeader('Content-Type', 'text/event-stream');
        setTimeout(() => {
          active.delete(prompt);
          response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `DONE ${prompt}` } }] })}\n\ndata: [DONE]\n\n`);
        }, 80);
      });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No model port');
    const dir = await mkdtemp(join(tmpdir(), 'ardent-queue-'));
    dirs.push(dir);
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = `http://127.0.0.1:${address.port}/`;
    config.providers.llamacpp.model = 'fixture';
    config.execution.max_parallel_tools = 2;
    const runtime = new ArdentRuntime(dir, config);
    try {
      const a1 = runtime.accept('A1', 'alice');
      const a2 = runtime.accept('A2', 'alice');
      const b1 = runtime.accept('B1', 'bob');
      const first = runtime.run(a1.id);
      const queued = runtime.run(a2.id);
      const cancelled = expect(queued).rejects.toThrow('cancelled before execution');
      const other = runtime.run(b1.id);
      runtime.cancel(a2.id);
      expect((await first).answer).toBe('DONE A1');
      expect((await other).answer).toBe('DONE B1');
      await cancelled;
      expect([...started].sort()).toEqual(['A1', 'B1']);
      expect(maxConcurrent).toBe(2);
      expect(runtime.store.get(a2.id)?.state).toBe('cancelled');
    } finally { runtime.close(); }
  });
  it('marks interrupted running work with an uncertain effect unknown on restart without replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ardent-queue-'));
    dirs.push(dir);
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    const first = new ArdentRuntime(dir, config);
    const task = first.accept('Interrupted', 'alice');
    first.store.setState(task.id, 'running');
    // An effectful call journaled without a checkpoint (as by an older release) is never replayed.
    first.store.append(task.id, 'tool_attempt', { id: 'call-1', name: 'news_collect', effect: 'artifact-write' });
    first.close();
    const restarted = new ArdentRuntime(dir, config);
    try {
      expect(restarted.recovered.interrupted).toBe(1);
      expect(restarted.store.get(task.id)?.state).toBe('unknown');
      expect(restarted.recoveryFor(task.id)).toMatchObject({ status: 'unsupported', reason: { code: 'NO_EXECUTION_CHECKPOINT' } });
      await expect(restarted.run(task.id)).rejects.toThrow('Task is unknown');
    } finally { restarted.close(); }
  });
  it('drains accepted work and refuses new admissions during shutdown', async () => {
    const server = createServer((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', 'text/event-stream');
      setTimeout(() => response.end('data: {"choices":[{"delta":{"content":"READY"}}]}\n\ndata: [DONE]\n\n'), 60);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No model port');
    const dir = await mkdtemp(join(tmpdir(), 'ardent-drain-'));
    dirs.push(dir);
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = `http://127.0.0.1:${address.port}/`;
    config.providers.llamacpp.model = 'fixture';
    const runtime = new ArdentRuntime(dir, config);
    try {
      const task = runtime.accept('hello');
      const result = runtime.run(task.id);
      const draining = runtime.drain(1000);
      expect(() => runtime.accept('late')).toThrow('draining');
      expect(() => runtime.close()).toThrow('active');
      expect((await result).answer).toBe('READY');
      expect(await draining).toBe(true);
    } finally { runtime.close(); }
  });
  it('records a final-answer validation failure as failed without restart rewriting it to unknown', async () => {
    const server = createServer((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', 'text/event-stream');
      response.end('data: {"choices":[{"delta":{"content":""}}]}\n\ndata: [DONE]\n\n');
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No model port');
    const dir = await mkdtemp(join(tmpdir(), 'ardent-failure-'));
    dirs.push(dir);
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = `http://127.0.0.1:${address.port}/`;
    config.providers.llamacpp.model = 'fixture';
    const runtime = new ArdentRuntime(dir, config);
    const task = runtime.accept('hello');
    await expect(runtime.run(task.id)).rejects.toThrow('empty final answer');
    expect(runtime.store.get(task.id)?.state).toBe('failed');
    runtime.close();
    const restarted = new ArdentRuntime(dir, config);
    try {
      expect(restarted.recovered.interrupted).toBe(0);
      expect(restarted.store.get(task.id)?.state).toBe('failed');
    } finally { restarted.close(); }
  });
  it('keeps an old profile with only max_parallel_tools running that many tasks, with a deprecation notice', async () => {
    const active = new Set<string>();
    let maxConcurrent = 0;
    const server = createServer((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] };
        const prompt = parsed.messages.findLast(item => item.role === 'user')?.content ?? '';
        active.add(prompt);
        maxConcurrent = Math.max(maxConcurrent, active.size);
        response.setHeader('Content-Type', 'text/event-stream');
        setTimeout(() => {
          active.delete(prompt);
          response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `DONE ${prompt}` } }] })}\n\ndata: [DONE]\n\n`);
        }, 120);
      });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No model port');
    const dir = await mkdtemp(join(tmpdir(), 'ardent-old-profile-'));
    dirs.push(dir);
    await initTestProfile(dir);
    const path = join(dir, 'config.yaml');
    const current = await readFile(path, 'utf8');
    expect(current).toContain('max_parallel_tasks: 3');
    await writeFile(path, current.replace(/^ {2}max_parallel_tasks:.*\n {2}max_parallel_tool_calls:.*$/m, '  max_parallel_tools: 3'));
    const config = (await loadConfig(dir)).config;
    expect(config.execution.max_parallel_tasks).toBeUndefined();
    expect(config.execution.max_parallel_tool_calls).toBe(4);
    expect(maxParallelTasks(config)).toBe(3);
    const notices = runtimeProblems(config, {}).filter(isConfigNotice);
    expect(notices).toEqual(['notice: execution.max_parallel_tools is deprecated: it limits tasks; set max_parallel_tasks']);
    config.providers.llamacpp.base_url = `http://127.0.0.1:${address.port}/`;
    config.providers.llamacpp.model = 'fixture';
    const runtime = new ArdentRuntime(dir, config);
    try {
      const tasks = ['A', 'B', 'C', 'D'].map(name => runtime.accept(name, name.toLowerCase()));
      const answers = await Promise.all(tasks.map(task => runtime.run(task.id)));
      expect(answers.map(item => item.answer)).toEqual(['DONE A', 'DONE B', 'DONE C', 'DONE D']);
      expect(maxConcurrent).toBe(3);
    } finally { runtime.close(); }
    // The new key wins and silences the notice; the runtime still caps tasks at 4.
    const both = parseConfig((await readFile(path, 'utf8')).replace('  max_parallel_tools: 3', '  max_parallel_tasks: 1\n  max_parallel_tools: 3'));
    expect(maxParallelTasks(both)).toBe(1);
    expect(runtimeProblems(both, {}).some(isConfigNotice)).toBe(false);
  });
});
