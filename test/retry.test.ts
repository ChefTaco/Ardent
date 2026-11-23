import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskState } from '@a2a-js/sdk';
import { AttemptError, RETRY_POLICIES, RetryStoppedError, retryWithPolicy, type RetryAttemptRecord } from '../src/retry.js';
import { LlamaCppBackend, mergeRequestHeaders, type ModelRetryEvent } from '../src/llamacpp.js';
import type { ArdentConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { createA2ASurface } from '../src/a2a-server.js';
import { ArdentA2AClient } from '../src/a2a-client.js';
import { initTestProfile } from './helpers.js';

const servers: ReturnType<typeof createServer>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return `http://127.0.0.1:${address.port}`;
}

function llamaConfig(base: string, timeoutSeconds = 10): ArdentConfig['providers']['llamacpp'] {
  return { base_url: base, model: 'fixture', api_key_env: 'FIXTURE_LLAMA_KEY', request_timeout_seconds: timeoutSeconds };
}

const sse = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
const messages = [{ role: 'user' as const, content: 'Ready?' }];

describe('retryWithPolicy', () => {
  const transient = () => new AttemptError('HTTP 503', { status: 503 });
  it('exhausts after three attempts and reports each one', async () => {
    const records: RetryAttemptRecord[] = [];
    let calls = 0;
    const error = await retryWithPolicy('llamacpp', async () => { calls++; throw transient(); },
      { effect: 'none', onAttempt: record => records.push(record), random: () => 0 }).catch((caught: unknown) => caught);
    expect(calls).toBe(3);
    expect(error).toBeInstanceOf(RetryStoppedError);
    expect(error).toMatchObject({ code: 'RETRY_EXHAUSTED', attempts: 3, message: 'HTTP 503 (RETRY_EXHAUSTED after 3 attempts)' });
    expect(records).toEqual([
      { attempt: 1, reason: 'http_503', delayMs: 125 },
      { attempt: 2, reason: 'http_503', delayMs: 250 },
      { attempt: 3, reason: 'http_503', delayMs: null, stop: 'RETRY_EXHAUSTED' },
    ]);
  });
  it('does not repeat permanent statuses, an unknown effect, a consumed stream or an exhausted peer', async () => {
    for (const [failure, effect, reason] of [
      [{ status: 400 }, 'none', 'http_400'], [{ status: 404 }, 'none', 'http_404'],
      [{ status: 503 }, 'unknown', 'unknown_effect'], [{ network: true, bytesConsumed: 12 }, 'none', 'bytes_consumed'],
      [{ status: 503, signal: 'exhausted' }, 'none', 'peer_exhausted'],
    ] as const) {
      const records: RetryAttemptRecord[] = [];
      let calls = 0;
      await expect(retryWithPolicy('llamacpp', async () => { calls++; throw new AttemptError('failed', failure); },
        { effect, onAttempt: record => records.push(record) })).rejects.toBeInstanceOf(AttemptError);
      expect(calls).toBe(1);
      expect(records).toEqual([{ attempt: 1, reason, delayMs: null }]);
    }
  });
  it('never repeats the never policy or an error it cannot classify', async () => {
    let calls = 0;
    await expect(retryWithPolicy('never', async () => { calls++; throw transient(); }, { effect: 'none' })).rejects.toBeInstanceOf(RetryStoppedError);
    await expect(retryWithPolicy('llamacpp', async () => { calls++; throw new Error('tool failed_unknown'); }, { effect: 'none' })).rejects.toThrow('tool failed_unknown');
    expect(calls).toBe(2);
    expect(RETRY_POLICIES.never.maxAttempts).toBe(1);
  });
  it('stops early at the deadline and when the peer asks for too long a wait', async () => {
    let calls = 0;
    await expect(retryWithPolicy('llamacpp', async () => { calls++; throw transient(); },
      { effect: 'none', deadlineMs: Date.now() + 50 })).rejects.toMatchObject({ code: 'RETRY_DEADLINE', attempts: 1 });
    await expect(retryWithPolicy('llamacpp', async () => { calls++; throw new AttemptError('busy', { status: 429, retryAfterMs: 11_000 }); },
      { effect: 'none' })).rejects.toMatchObject({ code: 'RETRY_AFTER_TOO_LONG', attempts: 1 });
    expect(calls).toBe(2);
  });
  it('ends at once when cancelled during a backoff wait', async () => {
    const controller = new AbortController();
    let calls = 0;
    const started = Date.now();
    const pending = retryWithPolicy('llamacpp', async () => { calls++; throw new AttemptError('busy', { status: 429, retryAfterMs: 5000 }); },
      { effect: 'none', signal: controller.signal });
    setTimeout(() => controller.abort(new Error('cancelled by operator')), 30);
    await expect(pending).rejects.toThrow('cancelled by operator');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls).toBe(1);
  });
});

describe('llama.cpp retry policy', () => {
  it('honours Retry-After as seconds, journals each retry and exhausts after three requests', async () => {
    let requests = 0;
    const base = await listen((_request, response) => { requests++; response.writeHead(503, { 'Retry-After': '1' }).end('{}'); });
    const retries: ModelRetryEvent[] = [];
    const started = Date.now();
    const error = await new LlamaCppBackend(llamaConfig(base), {}).complete(messages, [], AbortSignal.timeout(10_000), true, undefined, undefined,
      { onRetry: event => retries.push(event) }).catch((caught: unknown) => caught);
    expect(requests).toBe(3);
    expect(error).toMatchObject({ code: 'RETRY_EXHAUSTED', message: 'llama.cpp HTTP 503 (RETRY_EXHAUSTED after 3 attempts)' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(retries).toEqual([
      { operation: 'complete', attempt: 1, reason: 'http_503', delay_ms: 1000 },
      { operation: 'complete', attempt: 2, reason: 'http_503', delay_ms: 1000 },
    ]);
  });
  it('honours Retry-After as an HTTP date, then succeeds', async () => {
    let requests = 0;
    const at = Math.ceil(Date.now() / 1000) * 1000 + 2000;
    const base = await listen((_request, response) => {
      requests++;
      if (requests === 1) { response.writeHead(429, { 'Retry-After': new Date(at).toUTCString() }).end('{}'); return; }
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(sse('READY'));
    });
    const retries: ModelRetryEvent[] = [];
    // A fixed clock 1.2 s before the date makes the wait exact.
    const reply = await new LlamaCppBackend(llamaConfig(base), {}).complete(messages, [], AbortSignal.timeout(10_000), true, undefined, undefined,
      { onRetry: event => retries.push(event), now: () => at - 1200 });
    expect(reply.content).toBe('READY');
    expect(requests).toBe(2);
    expect(retries).toEqual([{ operation: 'complete', attempt: 1, reason: 'http_429', delay_ms: 1200 }]);
  });
  it('does not repeat 400 or 404, a stream that failed after its first chunk, or an exhausted gateway', async () => {
    let mode = 'bad';
    let requests = 0;
    const base = await listen((_request, response) => {
      requests++;
      if (mode === 'bad') { response.writeHead(400).end('{}'); return; }
      if (mode === 'missing') { response.writeHead(404).end('{}'); return; }
      if (mode === 'exhausted') { response.writeHead(503, { 'x-hive-retry': 'exhausted' }).end('{}'); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
      setTimeout(() => response.destroy(), 20);
    });
    const backend = new LlamaCppBackend(llamaConfig(base), {});
    for (const [next, message] of [['bad', 'HTTP 400'], ['missing', 'HTTP 404'], ['exhausted', 'HTTP 503'], ['partial', '']] as const) {
      mode = next;
      requests = 0;
      const retries: ModelRetryEvent[] = [];
      const chunks: string[] = [];
      await expect(backend.complete(messages, [], AbortSignal.timeout(10_000), true, chunk => chunks.push(chunk), undefined,
        { onRetry: event => retries.push(event) })).rejects.toThrow(message);
      expect(requests).toBe(1);
      expect(retries).toEqual([]);
      if (next === 'partial') expect(chunks).toEqual(['partial']);
    }
  });
  it('stops retrying at the deadline and ends at once when cancelled during backoff', async () => {
    let requests = 0;
    const base = await listen((_request, response) => { requests++; response.writeHead(503, { 'Retry-After': '1' }).end('{}'); });
    const backend = new LlamaCppBackend(llamaConfig(base), {});
    await expect(backend.complete(messages, [], AbortSignal.timeout(10_000), true, undefined, undefined, { deadlineMs: Date.now() + 500 }))
      .rejects.toMatchObject({ code: 'RETRY_DEADLINE' });
    expect(requests).toBe(1);
    // The request timeout is a deadline too: a 1 s Retry-After cannot fit in a 1 s request.
    requests = 0;
    await expect(new LlamaCppBackend(llamaConfig(base, 1), {}).complete(messages, [], AbortSignal.timeout(10_000)))
      .rejects.toMatchObject({ code: 'RETRY_DEADLINE' });
    expect(requests).toBe(1);
    requests = 0;
    const controller = new AbortController();
    const started = Date.now();
    const pending = backend.complete(messages, [], controller.signal);
    setTimeout(() => controller.abort('fixture cancellation'), 100);
    await expect(pending).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(Date.now() - started).toBeLessThan(2500);
    expect(requests).toBe(1);
  });
  it('retries token counting, then falls back to the estimator, and merges request headers safely', async () => {
    let requests = 0;
    const seen: IncomingMessage['headers'][] = [];
    const base = await listen((request, response) => {
      requests++;
      seen.push(request.headers);
      if (requests === 1) { response.writeHead(502).end('{}'); return; }
      if (request.url === '/v1/chat/completions/input_tokens') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(requests === 2 ? { input_tokens: 42 } : {}));
        return;
      }
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(sse('READY'));
    });
    const backend = new LlamaCppBackend(llamaConfig(base), { FIXTURE_LLAMA_KEY: 'fixture-token' });
    const retries: ModelRetryEvent[] = [];
    const requestHeaders = { 'x-hive-execution': 'fixture-context', Authorization: 'Bearer forged', 'content-type': 'text/plain', 'bad header': 'x', 'x-split': 'a\r\nb' };
    expect(await backend.countInputTokens(messages, [], AbortSignal.timeout(10_000), { requestHeaders, onRetry: event => retries.push(event) })).toBe(42);
    expect(retries).toMatchObject([{ operation: 'count_tokens', attempt: 1, reason: 'http_502' }]);
    expect(requests).toBe(2);
    // A malformed count is not transient: the estimator takes over without another request.
    expect(await backend.countInputTokens(messages, [], AbortSignal.timeout(10_000))).toBeNull();
    expect(requests).toBe(3);
    expect((await backend.complete(messages, [], AbortSignal.timeout(10_000), true, undefined, undefined, { requestHeaders })).content).toBe('READY');
    for (const headers of [seen[1], seen[3]]) {
      expect(headers).toMatchObject({ 'x-hive-execution': 'fixture-context', authorization: 'Bearer fixture-token', 'content-type': 'application/json' });
      expect(headers).not.toHaveProperty('x-split');
    }
    expect(mergeRequestHeaders({ Accept: 'text/event-stream' }, { accept: 'text/html', 'x-ok': '1' })).toEqual({ 'x-ok': '1', Accept: 'text/event-stream' });
  });
  it('journals model_retry events on the task', async () => {
    let requests = 0;
    const base = await listen((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      requests++;
      if (requests === 1) { response.writeHead(503, { 'Retry-After': '0' }).end('{}'); return; }
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(sse('Hello from the fixture.'));
    });
    const dir = await mkdtemp(join(tmpdir(), 'ardent-retry-'));
    dirs.push(dir);
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = base;
    config.providers.llamacpp.model = 'fixture';
    const runtime = new ArdentRuntime(dir, config, {});
    try {
      const task = runtime.accept('Say hello');
      expect((await runtime.run(task.id)).answer).toContain('Hello from the fixture.');
      expect(requests).toBe(2);
      const retries = runtime.store.events(task.id).filter(event => event.kind === 'model_retry').map(event => event.detail);
      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatchObject({ step: 0, operation: 'complete', attempt: 1, reason: 'http_503' });
      expect((retries[0] as { delay_ms: number }).delay_ms).toBeGreaterThan(0);
    } finally { runtime.close(); }
  });
});

describe('A2A client retry policy', () => {
  it('repeats card and getTask reads and SendMessage with the same messageId, recording attempts', async () => {
    const model = await listen((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(sse('ROUNDTRIP_OK'));
    });
    const dir = await mkdtemp(join(tmpdir(), 'ardent-retry-a2a-'));
    dirs.push(dir);
    await initTestProfile(dir);
    // A fault-injecting front door: the next GET or POST answers 503 until its budget is spent.
    const faults = { get: 1, post: 1 };
    const faultedMessageIds: string[] = [];
    let app: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
    const front = await listen((request, response) => {
      const kind = request.method === 'POST' && !request.url?.startsWith('/a2a/push') ? 'post' : request.method === 'GET' ? 'get' : undefined;
      if (kind && faults[kind] > 0) {
        faults[kind]--;
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const id = /"messageId":"([^"]+)"/.exec(body)?.[1];
          if (id) faultedMessageIds.push(id);
          response.writeHead(503, { 'Retry-After': '0' }).end();
        });
        return;
      }
      app?.(request, response);
    });
    const port = Number(new URL(front).port);
    await writeFile(join(dir, 'peers.yaml'), `schema_version: 1\npeers:\n  - id: coordinator\n    url: ${front}\n    token_env: COORDINATOR_TOKEN\n    transport_ports: [${port + 1}]\n    allow_private_callbacks: true\n`);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = `${model}/`;
    config.providers.llamacpp.model = 'fixture';
    config.a2a.public_url = front;
    config.a2a.bindings = ['jsonrpc'];
    const env = { COORDINATOR_TOKEN: 'fixture-token-1234567890' };
    const runtime = new ArdentRuntime(dir, config, env);
    let surface: Awaited<ReturnType<typeof createA2ASurface>> | undefined;
    try {
      surface = await createA2ASurface(runtime, config, env);
      app = surface.app as unknown as (request: IncomingMessage, response: ServerResponse) => void;
      const client = new ArdentA2AClient(dir, config, env, surface.pushInbox);
      const sent = await client.sendWithReceipt('coordinator', 'Return ROUNDTRIP_OK');
      expect(faults).toEqual({ get: 0, post: 0 });
      if (!('id' in sent.result)) throw new Error('Expected a task');
      expect(sent.result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(faultedMessageIds).toHaveLength(1);
      expect(sent.result.history?.[0]?.messageId).toBe(faultedMessageIds[0]);
      expect(runtime.store.db.prepare('SELECT attempts,state FROM a2a_outbound_calls WHERE id=?').get(sent.outboundId)).toEqual({ attempts: 2, state: 'bound' });
      faults.post = 1;
      expect((await client.getTask('coordinator', sent.result.id)).id).toBe(sent.result.id);
      expect(faults.post).toBe(0);
      // A permanent failure is not repeated.
      await expect(client.getTask('coordinator', 'no-such-task')).rejects.toThrow();
    } finally { await surface?.pushSender.drain(); runtime.close(); }
  }, 20_000);
});
