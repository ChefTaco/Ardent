import { describe, it, expect, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { initTestProfile } from './helpers.js';
import { ArdentRuntime } from '../src/runtime.js';
import { MattermostAdapter } from '../src/mattermost.js';
import { TaskStore } from '../src/store.js';
import { z } from 'zod';

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Missed-event fixture did not settle');
}

it('recovers a silent connected socket once, leaves claimed unknown work untouched, and stops serial polling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-missed-events-'));
  // Recent posts: catch-up skips posts older than catchup.max_age_hours.
  const base = Date.now() - 60_000;
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
      posts[id] = { id, user_id: 'operator', channel_id: 'dm', message: '/status', create_at: base + 2 };
      runtime.store.claimInbound('mattermost', 'bot', id);
    }
    runtime.store.bindInboundTask('mattermost', 'bot', 'unknown', prior.id);
    const protectedRows = JSON.stringify({ task: runtime.store.get(prior.id), inbound: runtime.store.db.prepare("SELECT * FROM channel_inbound ORDER BY update_id").all() });
    posts.fresh = { id: 'fresh', user_id: 'operator', channel_id: 'dm', message: '/status', create_at: base + 3 };
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
    posts.race = { id: 'race', user_id: 'operator', channel_id: 'dm', message: '/status', create_at: base + 4, file_ids: ['race'] };
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
      id: 'cancelled-attachment', user_id: 'operator', channel_id: 'dm', message: '/status', create_at: base + 4,
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

type FixturePost = { id: string; user_id: string; channel_id: string; message: string; create_at: number; root_id?: string; file_ids?: string[] };
/**
 * ChatterMost-compatible fixture: newest-first post lists, `per_page` up to 200
 * and `before=<post id>` paging, where an unknown pivot returns an empty list.
 */
async function catchupFixture() {
  const posts = new Map<string, FixturePost>();
  const replies: { channel_id: string; message: string; root_id?: string }[] = [];
  const requests: string[] = [];
  let afterPage: ((before: string | null, page: FixturePost[]) => void) | undefined;
  let onSocket: ((client: WebSocket) => void) | undefined;
  const limits = { replies: 0 };
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    const url = new URL(request.url ?? '/', 'http://fixture.example.com');
    if (url.pathname === '/api/v4/users/me') response.end(JSON.stringify({ id: 'bot', username: 'coordinator', is_bot: true }));
    else if (url.pathname === '/api/v4/users/me/channels') response.end(JSON.stringify([{ id: 'dm', type: 'D' }]));
    else if (url.pathname === '/api/v4/channels/dm/posts') {
      requests.push(url.search);
      const all = [...posts.values()].sort((a, b) => b.create_at - a.create_at);
      const perPage = Math.min(200, Math.max(1, Number(url.searchParams.get('per_page') ?? '60')));
      const before = url.searchParams.get('before');
      let listed = all;
      if (before) { const pivot = all.findIndex(post => post.id === before); listed = pivot < 0 ? [] : all.slice(pivot + 1); }
      const page = listed.slice(0, perPage);
      response.end(JSON.stringify({ order: page.map(post => post.id), posts: Object.fromEntries(page.map(post => [post.id, post])) }));
      afterPage?.(before, page);
    } else if (url.pathname === '/api/v4/posts' && request.method === 'POST' && limits.replies > 0) {
      limits.replies--;
      request.resume();
      response.writeHead(429, { 'Retry-After': '1' }).end('{"status_code":429}');
    } else if (url.pathname === '/api/v4/posts' && request.method === 'POST') {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const reply = JSON.parse(body) as { channel_id: string; message: string; root_id?: string };
        replies.push(reply);
        const sent = { id: `reply-${replies.length}`, user_id: 'bot', create_at: Date.now(), message: reply.message, channel_id: reply.channel_id, root_id: reply.root_id ?? '' };
        posts.set(sent.id, sent);
        response.end(JSON.stringify(sent));
      });
    } else response.writeHead(404).end('{}');
  });
  const ws = new WebSocketServer({ server, path: '/api/v4/websocket' });
  ws.on('connection', client => {
    client.once('message', () => { client.send(JSON.stringify({ status: 'OK', seq_reply: 1 })); onSocket?.(client); });
  });
  const model = createServer((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    request.resume();
    request.on('end', () => {
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'CATCHUP_OK' } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const address = server.address(), modelAddress = model.address();
  if (!address || typeof address === 'string' || !modelAddress || typeof modelAddress === 'string') throw new Error('Missing fixture port');
  const dir = await mkdtemp(join(tmpdir(), 'ardent-catchup-'));
  await initTestProfile(dir);
  const config = (await loadConfig(dir)).config;
  config.research.enabled = false;
  config.providers.llamacpp.base_url = `http://127.0.0.1:${modelAddress.port}/`;
  config.providers.llamacpp.model = 'fixture';
  config.channels.mattermost.base_url = `http://127.0.0.1:${address.port}`;
  config.channels.mattermost.allowed_user_ids = ['operator'];
  const env = { MATTERMOST_TOKEN: 'fixture-token' };
  const state = { runtime: new ArdentRuntime(dir, config, env) };
  return {
    posts, replies, requests, config, env, dir, state, limits,
    set afterPage(hook: typeof afterPage) { afterPage = hook; },
    set onSocket(hook: typeof onSocket) { onSocket = hook; },
    add(post: Omit<FixturePost, 'channel_id' | 'user_id'> & { user_id?: string }) { posts.set(post.id, { channel_id: 'dm', user_id: 'operator', ...post }); },
    adapter() { return new MattermostAdapter(state.runtime, config.channels.mattermost, env); },
    restart() { state.runtime.close(); state.runtime = new ArdentRuntime(dir, config, env); },
    async close() {
      state.runtime.close();
      for (const client of ws.clients) client.terminate();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await new Promise<void>(resolve => model.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  };
}
async function settle(check: () => boolean, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('Catch-up fixture did not settle');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const sentCount = (runtime: ArdentRuntime) => z.object({ n: z.number() }).parse(runtime.store.db.prepare("SELECT count(*) AS n FROM channel_deliveries WHERE state='sent'").get()).n;
const channelStatus = (runtime: ArdentRuntime) => runtime.store.catchup.status('mattermost').find(item => item.channel === 'dm');

describe('Mattermost catch-up walk', () => {
  it('recovers 250 missed posts after a restart with one task and one reply each, and reports it in status', async () => {
    const fixture = await catchupFixture();
    const stop = new AbortController();
    try {
      const base = Date.now() - 3_600_000;
      fixture.add({ id: 'p0000', message: 'Before the outage', create_at: base });
      const first = fixture.adapter();
      await first.initialize();
      // First sight of the channel claims its history without answering it.
      expect(await first.reconcile(false)).toBe(0);
      expect(fixture.replies).toHaveLength(0);
      fixture.restart();
      for (let i = 1; i <= 270; i++) {
        const bot = i % 26 === 0 || i > 260;
        fixture.add({ id: `p${String(i).padStart(4, '0')}`, user_id: bot ? 'bot' : 'operator', message: bot ? `bot note ${i}` : `question ${i}`, root_id: `thread-${i}`, create_at: base + i * 10 });
      }
      const eligible = [...fixture.posts.values()].filter(post => post.user_id === 'operator' && post.id !== 'p0000');
      expect(eligible).toHaveLength(250);
      const adapter = fixture.adapter();
      const connected = adapter.connectOnce(stop.signal);
      await settle(() => sentCount(fixture.state.runtime) === 250);
      const runtime = fixture.state.runtime;
      const tasks = z.array(z.object({ idempotency_key: z.string() })).parse(runtime.store.db.prepare("SELECT idempotency_key FROM tasks WHERE caller='mattermost:bot:operator'").all());
      expect(tasks).toHaveLength(250);
      expect(new Set(tasks.map(task => task.idempotency_key)).size).toBe(250);
      expect(fixture.replies).toHaveLength(250);
      expect(new Set(fixture.replies.map(reply => reply.root_id)).size).toBe(250);
      expect(fixture.replies.every(reply => reply.message.includes('CATCHUP_OK'))).toBe(true);
      // Page 0 reads 200 posts, page 1 reaches the boundary post.
      expect(fixture.requests.slice(-2)).toEqual(['?per_page=200', '?per_page=200&before=p0071']);
      const status = channelStatus(runtime);
      expect(status).toMatchObject({ account: 'bot', state: 'complete', recovered: 250, skipped_stale: 0, already_claimed: 0, pages: 2, gaps: 0 });
      expect(JSON.parse(runtime.store.cursor('mattermost:bot:dm:last') ?? '{}')).toEqual({ last_ms: base + 2700, last_post_id: 'p0270' });
      const { createArdentApi } = await import('../src/api.js');
      const app = createArdentApi(runtime, await loadConfig(fixture.dir), { ARDENT_API_TOKEN: 'fixture-token' });
      const body = await (await app.request('/api/v1/status', { headers: { Authorization: 'Bearer fixture-token' } })).json() as { channels: { mattermost: { catchup: unknown[] } } };
      expect(body.channels.mattermost.catchup).toEqual([expect.objectContaining({ channel: 'dm', state: 'complete', recovered: 250 })]);
      // A later pass finds nothing new and answers nothing twice.
      expect(await adapter.reconcile(true)).toBe(0);
      expect(fixture.replies).toHaveLength(250);
      stop.abort();
      await connected;
    } finally { stop.abort(); await fixture.close(); }
  }, 120_000);

  it('admits a post once when its live event races the backlog walk', async () => {
    const fixture = await catchupFixture();
    const stop = new AbortController();
    try {
      const base = Date.now() - 60_000;
      fixture.add({ id: 'old', message: 'Seen', create_at: base });
      const adapter = fixture.adapter();
      await adapter.initialize();
      await adapter.reconcile(false);
      for (let i = 1; i <= 5; i++) fixture.add({ id: `m${i}`, message: `backlog ${i}`, root_id: `thread-${i}`, create_at: base + i });
      // The live event for m3 arrives while the start walk reads the backlog.
      fixture.onSocket = client => client.send(JSON.stringify({ event: 'posted', data: { channel_type: 'D', post: JSON.stringify(fixture.posts.get('m3')) } }));
      const connected = adapter.connectOnce(stop.signal);
      await settle(() => sentCount(fixture.state.runtime) === 5);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(fixture.replies).toHaveLength(5);
      const tasks = fixture.state.runtime.store.listByCaller('mattermost:bot:operator', 100);
      expect(tasks).toHaveLength(5);
      expect(tasks.filter(task => task.idempotency_key === 'mattermost:bot:m3')).toHaveLength(1);
      stop.abort();
      await connected;
    } finally { stop.abort(); await fixture.close(); }
  });

  it('bounds a 12,000-post outage to max_posts and records the rest as a permanent walk_bound gap', async () => {
    const fixture = await catchupFixture();
    try {
      const base = Date.now() - 3_600_000;
      fixture.add({ id: 'b', message: 'Boundary', create_at: base });
      const adapter = fixture.adapter();
      await adapter.initialize();
      await adapter.reconcile(false);
      for (let i = 1; i <= 12_000; i++) fixture.add({ id: `q${String(i).padStart(5, '0')}`, message: '/help', create_at: base + i });
      expect(fixture.config.channels.mattermost.catchup.max_posts).toBe(2000);
      expect(await adapter.reconcile(true)).toBe(2000);
      const runtime = fixture.state.runtime;
      await settle(() => sentCount(runtime) === 2000);
      // Ten pages fill the budget; the eleventh shows the boundary is still further back.
      expect(fixture.requests.filter(search => search.startsWith('?per_page=200'))).toHaveLength(1 + 11);
      expect(runtime.store.hasInbound('mattermost', 'bot', 'q10001')).toBe(true);
      expect(runtime.store.hasInbound('mattermost', 'bot', 'q10000')).toBe(false);
      expect(runtime.store.catchup.gaps('mattermost', 'bot', 'dm')).toEqual([{ from_ms: base, to_ms: base + 10_001, reason: 'walk_bound', detected_ms: expect.any(Number) }]);
      expect(channelStatus(runtime)).toMatchObject({ state: 'gap', recovered: 2000, pages: 11, gaps: 1, last_gap: expect.objectContaining({ reason: 'walk_bound' }) });
      expect(JSON.parse(runtime.store.cursor('mattermost:bot:dm:last') ?? '{}')).toEqual({ last_ms: base + 12_000, last_post_id: 'q12000' });
      // The gap is permanent: the next pass walks back over the 2000 replies to
      // the new boundary, neither entering the gap nor recording it again.
      expect(await adapter.reconcile(true)).toBe(0);
      expect(runtime.store.catchup.gaps('mattermost', 'bot', 'dm')).toHaveLength(1);
      expect(fixture.replies).toHaveLength(2000);
    } finally { await fixture.close(); }
  }, 120_000);

  it('never re-answers a claimed post whose delivery is unknown and skips posts older than max_age_hours', async () => {
    const fixture = await catchupFixture();
    const stop = new AbortController();
    try {
      const now = Date.now();
      const runtime = fixture.state.runtime;
      runtime.store.setCursor('mattermost:bot:dm:last', JSON.stringify({ last_ms: now - 30 * 3_600_000, last_post_id: 'boundary' }));
      fixture.add({ id: 'boundary', message: 'Seen', create_at: now - 30 * 3_600_000 });
      fixture.add({ id: 'stale-1', message: 'Too old', create_at: now - 26 * 3_600_000 });
      fixture.add({ id: 'stale-2', message: 'Still too old', create_at: now - 25 * 3_600_000 });
      fixture.add({ id: 'uncertain', message: 'Answered once', create_at: now - 120_000 });
      fixture.add({ id: 'fresh', message: '/help', create_at: now - 60_000 });
      const prior = runtime.store.accept({ caller: 'mattermost:bot:operator', context: 'direct', prompt: 'Answered once', backend: 'llamacpp', deadlineMs: now + 60_000 });
      runtime.store.setState(prior.id, 'completed', 'Earlier answer', null);
      runtime.store.claimInbound('mattermost', 'bot', 'uncertain', 'mattermost_dm');
      runtime.store.bindInboundTask('mattermost', 'bot', 'uncertain', prior.id);
      runtime.store.setDelivery(runtime.store.queueDelivery('mattermost', 'bot', 'uncertain', prior.id), 'unknown', null, 'Delivery uncertain');
      const adapter = fixture.adapter();
      const connected = adapter.connectOnce(stop.signal);
      await settle(() => runtime.store.delivery('mattermost', 'bot', 'fresh')?.state === 'sent');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(fixture.replies).toHaveLength(1);
      expect(runtime.store.delivery('mattermost', 'bot', 'uncertain')?.state).toBe('unknown');
      expect(runtime.store.listByCaller('mattermost:bot:operator', 10)).toHaveLength(1);
      const dispositions = runtime.store.db.prepare("SELECT update_id,disposition,task_id FROM channel_inbound WHERE update_id LIKE 'stale-%' ORDER BY update_id").all();
      expect(dispositions).toEqual([{ update_id: 'stale-1', disposition: 'skipped_stale', task_id: null }, { update_id: 'stale-2', disposition: 'skipped_stale', task_id: null }]);
      expect(channelStatus(runtime)).toMatchObject({ state: 'complete', recovered: 1, skipped_stale: 2, already_claimed: 1 });
      // Stale claims are settled, not unbound work held against a rollback fence.
      expect(z.object({ n: z.number() }).parse(runtime.store.db.prepare(`SELECT count(*) AS n FROM channel_inbound AS inbound
        LEFT JOIN channel_deliveries AS delivery ON delivery.update_id=inbound.update_id
        WHERE inbound.task_id IS NULL AND inbound.disposition='admitted' AND delivery.id IS NULL`).get()).n).toBe(0);
      expect(await adapter.reconcile(true)).toBe(0);
      expect(fixture.replies).toHaveLength(1);
      stop.abort();
      await connected;
    } finally { stop.abort(); await fixture.close(); }
  });

  it('upgrades a 3.1 last_ms cursor in place and keeps writing it for a rollback', async () => {
    const fixture = await catchupFixture();
    try {
      const base = Date.now() - 60_000;
      const runtime = fixture.state.runtime;
      fixture.add({ id: 'seen', message: 'Answered by 3.1', create_at: base });
      runtime.store.claimInbound('mattermost', 'bot', 'seen', 'mattermost_dm');
      runtime.store.setCursor('mattermost:bot:dm:last_ms', String(base));
      const adapter = fixture.adapter();
      await adapter.initialize();
      // Without a post id the boundary post itself is re-read once and found claimed.
      expect(await adapter.reconcile(true)).toBe(0);
      expect(JSON.parse(runtime.store.cursor('mattermost:bot:dm:last') ?? '{}')).toEqual({ last_ms: base, last_post_id: 'seen' });
      fixture.add({ id: 'next', message: '/help', create_at: base + 5 });
      expect(await adapter.reconcile(true)).toBe(1);
      await settle(() => runtime.store.delivery('mattermost', 'bot', 'next')?.state === 'sent');
      expect(JSON.parse(runtime.store.cursor('mattermost:bot:dm:last') ?? '{}')).toEqual({ last_ms: base + 5, last_post_id: 'next' });
      expect(runtime.store.cursor('mattermost:bot:dm:last_ms')).toBe(String(base + 5));
      // A rolled-back runtime that moved only last_ms further wins over the stale JSON cursor.
      fixture.add({ id: 'during-rollback', message: '/help', create_at: base + 10 });
      runtime.store.claimInbound('mattermost', 'bot', 'during-rollback', 'mattermost_dm');
      runtime.store.setCursor('mattermost:bot:dm:last_ms', String(base + 10));
      fixture.add({ id: 'after-upgrade', message: '/help', create_at: base + 15 });
      expect(await adapter.reconcile(true)).toBe(1);
      expect(fixture.requests.at(-1)).toBe('?per_page=200');
      await settle(() => runtime.store.delivery('mattermost', 'bot', 'after-upgrade')?.state === 'sent');
      expect(runtime.store.delivery('mattermost', 'bot', 'during-rollback')).toBeUndefined();
    } finally { await fixture.close(); }
  });

  it('records a retention gap when the before pivot disappears mid-walk, once', async () => {
    const fixture = await catchupFixture();
    try {
      const base = Date.now() - 60_000;
      const runtime = fixture.state.runtime;
      fixture.add({ id: 'b', message: 'Boundary', create_at: base });
      runtime.store.setCursor('mattermost:bot:dm:last', JSON.stringify({ last_ms: base, last_post_id: 'b' }));
      for (let i = 1; i <= 250; i++) fixture.add({ id: `r${String(i).padStart(3, '0')}`, message: '/help', create_at: base + i });
      // Retention removes the oldest post of the first page before the walk pages past it.
      fixture.afterPage = (before, page) => { if (!before) fixture.posts.delete(page.at(-1)!.id); };
      const adapter = fixture.adapter();
      await adapter.initialize();
      expect(await adapter.reconcile(true)).toBe(200);
      fixture.afterPage = undefined;
      expect(fixture.requests).toEqual(['?per_page=200', '?per_page=200&before=r051']);
      expect(runtime.store.catchup.gaps('mattermost', 'bot', 'dm')).toEqual([{ from_ms: base, to_ms: base + 51, reason: 'retention', detected_ms: expect.any(Number) }]);
      await settle(() => sentCount(runtime) === 200);
      expect(channelStatus(runtime)).toMatchObject({ state: 'gap', recovered: 200, gaps: 1 });
      expect(await adapter.reconcile(true)).toBe(0);
      expect(runtime.store.catchup.gaps('mattermost', 'bot', 'dm')).toHaveLength(1);
      // The boundary post is gone and so is everything older: that is retention too.
      const lost = await catchupFixture();
      try {
        lost.state.runtime.store.setCursor('mattermost:bot:dm:last', JSON.stringify({ last_ms: base, last_post_id: 'deleted' }));
        lost.add({ id: 'n1', message: '/help', create_at: base + 1 });
        const other = lost.adapter();
        await other.initialize();
        expect(await other.reconcile(true)).toBe(1);
        expect(lost.state.runtime.store.catchup.gaps('mattermost', 'bot', 'dm')).toMatchObject([{ reason: 'retention' }]);
        await settle(() => sentCount(lost.state.runtime) === 1);
      } finally { await lost.close(); }
    } finally { await fixture.close(); }
  });

  it('waits out a rate-limited reply instead of dropping it', async () => {
    const fixture = await catchupFixture();
    try {
      const runtime = fixture.state.runtime;
      runtime.store.setCursor('mattermost:bot:dm:last', JSON.stringify({ last_ms: 0, last_post_id: null }));
      fixture.add({ id: 'limited', message: '/help', create_at: Date.now() - 1000 });
      fixture.limits.replies = 1;
      const adapter = fixture.adapter();
      await adapter.initialize();
      expect(await adapter.reconcile(true)).toBe(1);
      await settle(() => runtime.store.delivery('mattermost', 'bot', 'limited')?.state === 'sent', 10_000);
      expect(fixture.limits.replies).toBe(0);
      expect(fixture.replies).toHaveLength(1);
    } finally { await fixture.close(); }
  });

  it('moves a 3.1 reconcile_gap cursor into the gap table once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ardent-catchup-migrate-'));
    try {
      const first = new TaskStore(join(dir, 'state.sqlite'));
      first.setCursor('mattermost:bot:dm:reconcile_gap', '100:200');
      first.db.exec("UPDATE channel_cursors SET updated_ms=300 WHERE key='mattermost:bot:dm:reconcile_gap'");
      first.close();
      const second = new TaskStore(join(dir, 'state.sqlite'));
      expect(second.catchup.gaps('mattermost', 'bot', 'dm')).toEqual([{ from_ms: 100, to_ms: 200, reason: 'walk_bound', detected_ms: 300 }]);
      expect(second.cursor('mattermost:bot:dm:reconcile_gap')).toBeUndefined();
      second.close();
      const third = new TaskStore(join(dir, 'state.sqlite'));
      expect(third.catchup.gaps('mattermost', 'bot', 'dm')).toHaveLength(1);
      third.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
