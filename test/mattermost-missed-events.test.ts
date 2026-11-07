import { it, expect, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { initTestProfile } from './helpers.js';
import { ArdentRuntime } from '../src/runtime.js';
import { MattermostAdapter } from '../src/mattermost.js';

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Missed-event fixture did not settle');
}

it('recovers a silent connected socket once, leaves claimed unknown work untouched, and stops serial polling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-missed-events-'));
  const posts: Record<string, { id: string; user_id: string; channel_id: string; message: string; create_at: number; file_ids?: string[] }> = {};
  let reads = 0, replies = 0, attachmentReads = 0, failRead = false, holdRead = false;
  let socket: WebSocket | undefined;
  const heldRace: ServerResponse[] = [];
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/v4/users/me') response.end(JSON.stringify({ id: 'bot', username: 'coordinator', is_bot: true }));
    else if (request.url === '/api/v4/users/me/channels') response.end(JSON.stringify([{ id: 'dm', type: 'D' }]));
    else if (request.url?.startsWith('/api/v4/channels/dm/posts')) {
      reads++;
      if (holdRead) return;
      if (failRead) { response.writeHead(503).end('{}'); return; }
      response.end(JSON.stringify({ order: Object.keys(posts).reverse(), posts }));
    } else if (request.url === '/api/v4/files/race/info') {
      heldRace.push(response);
      return;
    } else if (request.url?.startsWith('/api/v4/files/blocked')) {
      attachmentReads++;
      // A silent attachment request must be cancelled with the connection.
      return;
    } else if (request.url === '/api/v4/posts' && request.method === 'POST') {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const reply = JSON.parse(body) as { channel_id: string; message: string };
        replies++;
        response.end(JSON.stringify({ id: `reply-${replies}`, user_id: 'bot', create_at: Date.now(), ...reply }));
      });
    } else response.writeHead(404).end('{}');
  });
  const ws = new WebSocketServer({ server, path: '/api/v4/websocket' });
  ws.on('connection', client => {
    socket = client;
    client.once('message', () => client.send(JSON.stringify({ status: 'OK', seq_reply: 1 })));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  await initTestProfile(dir);
  const config = (await loadConfig(dir)).config;
  config.channels.mattermost.base_url = `http://127.0.0.1:${address.port}`;
  config.channels.mattermost.allowed_user_ids = ['operator'];
  const runtime = new ArdentRuntime(dir, config, { MATTERMOST_TOKEN: 'fixture-token' });
  const adapter = new MattermostAdapter(runtime, config.channels.mattermost, { MATTERMOST_TOKEN: 'fixture-token' });
  const reconciliation = vi.spyOn(adapter, 'reconcile');
  runtime.store.setCursor('mattermost:bot:dm:last_ms', '1');
  const stop = new AbortController();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const connected = adapter.connectOnce(stop.signal);
  try {
    await until(() => reads === 1);
    // Ensure startup has finished before introducing previously claimed work.
    await until(() => vi.getTimerCount() === 1);
    const prior = runtime.store.accept({ caller: 'mattermost:bot:operator', context: 'direct', prompt: 'Prior uncertain task', backend: 'codex', deadlineMs: Date.now() + 60_000 });
    runtime.store.setState(prior.id, 'unknown', null, 'Retained uncertain effect');
    for (const id of ['unbound', 'unknown']) {
      posts[id] = { id, user_id: 'operator', channel_id: 'dm', message: '/status', create_at: 2 };
      runtime.store.claimInbound('mattermost', 'bot', id);
    }
    runtime.store.bindInboundTask('mattermost', 'bot', 'unknown', prior.id);
    const protectedRows = JSON.stringify({ task: runtime.store.get(prior.id), inbound: runtime.store.db.prepare("SELECT * FROM channel_inbound ORDER BY update_id").all() });
    posts.fresh = { id: 'fresh', user_id: 'operator', channel_id: 'dm', message: '/status', create_at: 3 };
    // No posted frame is emitted: the socket stays authenticated and open.
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => runtime.store.delivery('mattermost', 'bot', 'fresh')?.state === 'sent');
    expect(replies).toBe(1);
    expect(runtime.store.hasInbound('mattermost', 'bot', 'fresh')).toBe(true);
    expect(runtime.store.delivery('mattermost', 'bot', 'fresh')?.state).toBe('sent');
    expect(JSON.stringify({ task: runtime.store.get(prior.id), inbound: runtime.store.db.prepare("SELECT * FROM channel_inbound WHERE update_id != 'fresh' ORDER BY update_id").all() })).toBe(protectedRows);
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => reads === 3);
    await reconciliation.mock.results.at(-1)!.value;
    socket?.send(JSON.stringify({ event: 'posted', data: { post: JSON.stringify(posts.fresh), channel_type: 'D' } }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(replies).toBe(1);
    expect(runtime.store.listByCaller('mattermost:bot:operator')).toHaveLength(1);
    posts.race = { id: 'race', user_id: 'operator', channel_id: 'dm', message: '/status', create_at: 4, file_ids: ['race'] };
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => heldRace.length === 1);
    // Another owner path claimed the post while periodic attachment IO waited.
    runtime.store.claimInbound('mattermost', 'bot', 'race');
    runtime.store.bindInboundTask('mattermost', 'bot', 'race', prior.id);
    heldRace[0]!.end(JSON.stringify({ id: 'race', name: 'race.bin', mime_type: 'application/octet-stream', size: 1 }));
    await reconciliation.mock.results.at(-1)!.value;
    expect(runtime.store.delivery('mattermost', 'bot', 'race')).toBeUndefined();
    expect(runtime.store.get(prior.id)?.state).toBe('unknown');
    expect(replies).toBe(1);
    failRead = true;
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => runtime.store.cursor('mattermost:bot:last_error')?.includes('503') === true);
    failRead = false;
    holdRead = true;
    const beforeHeld = reads;
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => reads === beforeHeld + 1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(reads).toBe(beforeHeld + 1);
    socket?.send(JSON.stringify({ event: 'posted', data: { channel_type: 'D', post: JSON.stringify({
      id: 'cancelled-attachment', user_id: 'operator', channel_id: 'dm', message: '/status', create_at: 4,
      file_ids: ['blocked-1', 'blocked-2', 'blocked-3', 'blocked-4', 'blocked-5']
    }) } }));
    await until(() => attachmentReads === 1);
    stop.abort();
    await connected;
    expect(attachmentReads).toBe(1);
    expect(runtime.store.hasInbound('mattermost', 'bot', 'cancelled-attachment')).toBe(false);
    const stoppedReads = reads;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(reads).toBe(stoppedReads);
    expect(replies).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    runtime.store.closeAdmission('aaaa1111-1111-4111-8111-111111111111');
    expect(await adapter.reconcile(true)).toBe(0);
    expect(reads).toBe(stoppedReads);
  } finally {
    stop.abort();
    await connected.catch(() => {});
    vi.useRealTimers();
    vi.restoreAllMocks();
    runtime.close();
    for (const client of ws.clients) client.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
