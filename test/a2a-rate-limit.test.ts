import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { afterEach, describe, expect, it } from 'vitest';
import { clientKey, GatedA2AExecutor, PeerTaskGate, TokenBucketLimiter } from '../src/a2a-rate-limit.js';
import { createA2ASurface, limitedGrpcUser, type A2ASurface } from '../src/a2a-server.js';
import { loadConfig, type ArdentConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { initTestProfile } from './helpers.js';

const TOKEN = 'fixture-token-coordinator-1234';
const OTHER = 'fixture-token-other-567890123';
const env = { COORDINATOR_TOKEN: TOKEN, OTHER_TOKEN: OTHER };
const dirs: string[] = [];
const servers: Server[] = [];
const closers: Array<() => void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  if (!server.listening) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return address.port;
}

async function surface(limits: Partial<ArdentConfig['a2a']['rate_limit']>, modelPort?: number): Promise<{ base: string; surface: A2ASurface; runtime: ArdentRuntime }> {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-limit-'));
  dirs.push(dir);
  await initTestProfile(dir);
  await writeFile(join(dir, 'peers.yaml'), 'schema_version: 1\npeers:\n  - id: coordinator\n    url: https://coordinator.example.com\n    token_env: COORDINATOR_TOKEN\n  - id: other\n    url: https://other.example.com\n    token_env: OTHER_TOKEN\n');
  const config = (await loadConfig(dir)).config;
  config.a2a.public_url = 'http://127.0.0.1:9900';
  config.a2a.hermes_compat = true;
  Object.assign(config.a2a.rate_limit, limits);
  if (modelPort) { config.providers.llamacpp.base_url = `http://127.0.0.1:${modelPort}/`; config.providers.llamacpp.model = 'fixture'; }
  const runtime = new ArdentRuntime(dir, config, env);
  closers.push(() => runtime.close());
  const created = await createA2ASurface(runtime, config, env);
  const server = created.app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${await listen(server)}`, surface: created, runtime };
}

const auth = (token = TOKEN) => ({ Authorization: `Bearer ${token}` });
const rpc = (method: string, messageId: string, metadata?: Record<string, unknown>) => JSON.stringify({ jsonrpc: '2.0', id: 1, method,
  params: { message: { role: 'ROLE_USER', messageId, parts: [{ text: 'Return OK' }], ...(metadata ? { metadata } : {}) } } });
const rpcHeaders = (token = TOKEN) => ({ ...auth(token), 'Content-Type': 'application/json', 'A2A-Version': '1.0' });
const generous = { ip_requests_per_minute: 100_000, ip_burst: 10_000, peer_requests_per_minute: 100_000, peer_burst: 10_000 };

describe('TokenBucketLimiter', () => {
  it('spends the burst, reports when a token returns, and refills per key', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ perMinute: 60, burst: 2, now: () => now });
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.take('b').allowed).toBe(true);
    now = 1000;
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
    now = 100_000;
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('never tells a client to retry sooner than the token returns', () => {
    const limiter = new TokenBucketLimiter({ perMinute: 2, burst: 1, now: () => 0 });
    limiter.take('a');
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 30 });
  });

  it('keeps a bounded number of buckets, evicting the least recently used', () => {
    const limiter = new TokenBucketLimiter({ perMinute: 1, burst: 1, maxKeys: 2, now: () => 0 });
    limiter.take('a'); limiter.take('b');
    expect(limiter.take('a').allowed).toBe(false);
    limiter.take('c');
    expect(limiter.take('b').allowed).toBe(true);
  });
});

describe('clientKey', () => {
  it.each([
    ['192.0.2.1', '192.0.2.1'], ['::ffff:192.0.2.1', '192.0.2.1'], ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::9', '2001:db8:1:2::/64'], ['2001:0db8:0001:0002::a', '2001:db8:1:2::/64'], ['::1', '0:0:0:0::/64'], ['fe80::1%eth0', 'fe80:0:0:0::/64'], [undefined, 'unknown'],
  ])('maps %s to %s', (address, key) => { expect(clientKey(address)).toBe(key); });
});

describe('PeerTaskGate', () => {
  it('caps each peer separately and frees a slot once', () => {
    const gate = new PeerTaskGate(1);
    expect(gate.acquire('a', 'm1')).toBe(true);
    expect(gate.isFull('a')).toBe(true);
    expect(gate.acquire('a', 'm2')).toBe(false);
    expect(gate.acquire('b', 'm1')).toBe(true);
    gate.release('a', 'm1'); gate.release('a', 'm1');
    expect(gate.isFull('a')).toBe(false);
  });

  it('releases when execution ends or throws', async () => {
    const gate = new PeerTaskGate(2);
    gate.acquire('a', 'ok'); gate.acquire('a', 'bad');
    const request = (messageId: string) => ({ context: { user: { userName: 'a' } }, userMessage: { messageId } }) as never;
    const executor = new GatedA2AExecutor({ execute: async (r: { userMessage: { messageId: string } }) => { if (r.userMessage.messageId === 'bad') throw new Error('boom'); }, cancelTask: async () => {} } as never, gate);
    await executor.execute(request('ok'), {} as never);
    await expect(executor.execute(request('bad'), {} as never)).rejects.toThrow('boom');
    expect(gate.holds('a', 'ok') || gate.holds('a', 'bad')).toBe(false);
  });
});

describe('A2A surface limits', () => {
  it('spends the peer bucket for gRPC calls and leaves anonymous calls to authentication', () => {
    const bucket = new TokenBucketLimiter({ perMinute: 1, burst: 1, now: () => 0 });
    expect(limitedGrpcUser('coordinator', bucket)).toEqual({ isAuthenticated: true, userName: 'coordinator' });
    expect(() => limitedGrpcUser('coordinator', bucket)).toThrow('Too many A2A requests');
    expect(limitedGrpcUser(undefined, bucket)).toEqual({ isAuthenticated: false, userName: '' });
    expect(limitedGrpcUser('coordinator', undefined)).toEqual({ isAuthenticated: true, userName: 'coordinator' });
  });

  it('limits every route by client address before authentication and answers Retry-After', async () => {
    const { base } = await surface({ ip_requests_per_minute: 1, ip_burst: 2 });
    expect((await fetch(`${base}/.well-known/agent-card.json`)).status).toBe(200);
    expect((await fetch(`${base}/a2a/jsonrpc`, { method: 'POST' })).status).toBe(401);
    for (const [url, init] of [[`${base}/team/artifacts/x`, {}], [`${base}/a2a/rest/tasks`, {}], [`${base}/a2a/jsonrpc`, { method: 'POST' }],
      [`${base}/`, { method: 'POST' }], [`${base}/a2a/push/coordinator`, { method: 'POST' }], [`${base}/.well-known/hermes-team-card.json`, {}]] as const) {
      const response = await fetch(url, init);
      expect(response.status, url).toBe(429);
      expect(Number(response.headers.get('retry-after')), url).toBeGreaterThanOrEqual(1);
    }
  });

  it('ignores X-Forwarded-For unless the connecting address is a configured proxy', async () => {
    const direct = await surface({ ip_requests_per_minute: 1, ip_burst: 1 });
    const spoof = (base: string, client: string) => fetch(`${base}/.well-known/agent-card.json`, { headers: { 'X-Forwarded-For': client } });
    expect((await spoof(direct.base, '192.0.2.1')).status).toBe(200);
    expect((await spoof(direct.base, '192.0.2.2')).status).toBe(429);
    const proxied = await surface({ ip_requests_per_minute: 1, ip_burst: 1, trusted_proxies: ['127.0.0.1'] });
    expect((await spoof(proxied.base, '192.0.2.1')).status).toBe(200);
    expect((await spoof(proxied.base, '192.0.2.2')).status).toBe(200);
    expect((await spoof(proxied.base, '192.0.2.1')).status).toBe(429);
  });

  it('limits each authenticated peer separately on every authenticated route', async () => {
    const { base } = await surface({ ...generous, peer_requests_per_minute: 1, peer_burst: 1 });
    expect((await fetch(`${base}/.well-known/hermes-team-card.json`, { headers: auth() })).status).toBe(200);
    for (const [url, init] of [[`${base}/team/artifacts/x?context=y`, { headers: auth() }], [`${base}/a2a/rest/tasks`, { headers: auth() }],
      [`${base}/a2a/jsonrpc`, { method: 'POST', headers: rpcHeaders(), body: rpc('GetTask', 'x') }],
      [`${base}/`, { method: 'POST', headers: rpcHeaders(), body: rpc('GetTask', 'x') }]] as const) {
      const response = await fetch(url, init);
      expect(response.status, url).toBe(429);
      expect(response.headers.get('retry-after'), url).toBeTruthy();
    }
    expect((await fetch(`${base}/.well-known/hermes-team-card.json`, { headers: auth(OTHER) })).status).toBe(200);
    // A failed login spends no peer's tokens.
    expect((await fetch(`${base}/.well-known/hermes-team-card.json`, { headers: auth('wrong-token') })).status).toBe(401);
  });

  it('switches off completely when disabled', async () => {
    const { base } = await surface({ enabled: false, ip_requests_per_minute: 1, ip_burst: 1, peer_requests_per_minute: 1, peer_burst: 1 });
    for (let index = 0; index < 3; index++) expect((await fetch(`${base}/.well-known/hermes-team-card.json`, { headers: auth() })).status).toBe(200);
  });

  it('checks the push token before parsing the body, then limits and parses', async () => {
    const { base, surface: created } = await surface({ ...generous, peer_requests_per_minute: 1, peer_burst: 2 });
    const push = (token: string | undefined, body: string) => fetch(`${base}/a2a/push/coordinator`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-A2A-Notification-Token': token } : {}) }, body });
    for (const body of ['{not json', `{"pad":"${'x'.repeat(3 * 1024 * 1024)}"}`]) {
      const refused = await push('wrong-token', body);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: 'A2A push is unauthorized' });
    }
    expect((await push(undefined, '{not json')).status).toBe(401);
    const { token } = created.pushInbox.register('coordinator', 'push-message');
    expect((await push(token, '{not json')).status).toBe(400);
    expect((await push(token, '{"task":{"id":"task-1","contextId":"context-1"}}')).status).toBe(202);
    const limited = await push(token, '{"task":{"id":"task-1","contextId":"context-1"}}');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  it('answers 429 at the task cap, frees the slot when the task ends, and lets control messages through', async () => {
    let finish = () => {};
    const held = new Promise<void>(resolve => { finish = resolve; });
    const model = createServer((_request, response) => {
      void held.then(() => {
        response.setHeader('Content-Type', 'text/event-stream');
        response.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
      });
    });
    const { base, surface: created } = await surface({ ...generous, max_concurrent_tasks_per_peer: 1 }, await listen(model));
    const send = (messageId: string, token = TOKEN, metadata?: Record<string, unknown>) => fetch(`${base}/a2a/jsonrpc`, { method: 'POST', headers: rpcHeaders(token), body: rpc('SendMessage', messageId, metadata) });
    const first = send('task-1');
    await expect.poll(() => created.taskGate.isFull('coordinator')).toBe(true);
    const refused = await send('task-2');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('5');
    const rest = await fetch(`${base}/a2a/rest/message:send`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ message: { role: 'ROLE_USER', messageId: 'task-3', parts: [{ text: 'Return OK' }] } }) });
    expect(rest.status).toBe(429);
    // Another peer and a control message are not held back by this peer's cap.
    expect((await send('control-1', TOKEN, { hermesTeamControl: { kind: 'invalid' } })).status).not.toBe(429);
    expect(created.taskGate.isFull('other')).toBe(false);
    finish();
    expect((await first).status).toBe(200);
    await expect.poll(() => created.taskGate.isFull('coordinator')).toBe(false);
  });

  it('refuses at the handler without leaving a receipt that would poison the retry', async () => {
    const { surface: created, runtime } = await surface({ ...generous, max_concurrent_tasks_per_peer: 1 });
    const context = new ServerCallContext({ tenant: '', user: { isAuthenticated: true, userName: 'coordinator' }, requestedVersion: '1.0' });
    created.taskGate.acquire('coordinator', 'running-elsewhere');
    const request = { tenant: '', message: { messageId: 'retried', role: 1, parts: [], contextId: '', taskId: '', metadata: undefined, extensions: [], referenceTaskIds: [] }, configuration: undefined, metadata: undefined } as never;
    await expect(created.handler.sendMessage(request, context)).rejects.toThrow('Peer task limit reached');
    await expect((async () => { for await (const _ of created.handler.sendMessageStream(request, context)) break; })()).rejects.toThrow('Peer task limit reached');
    expect(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM a2a_request_receipts WHERE message_id='retried'").get()).toEqual({ count: 0 });
  });

  it('uses safe defaults when the config says nothing', async () => {
    const { surface: created } = await surface({});
    expect(created.taskGate.maxPerPeer).toBe(16);
    const dir = await mkdtemp(join(tmpdir(), 'ardent-limit-defaults-'));
    dirs.push(dir);
    await initTestProfile(dir);
    expect((await loadConfig(dir)).config.a2a.rate_limit).toEqual({ enabled: true, ip_requests_per_minute: 600, ip_burst: 120,
      peer_requests_per_minute: 300, peer_burst: 60, max_concurrent_tasks_per_peer: 16, trusted_proxies: [] });
  });
});
