import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { initTestProfile } from './helpers.js';
import { ArdentRuntime } from '../src/runtime.js';
import { MattermostAdapter } from '../src/mattermost.js';

const dirs: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];
const mattermostRepo = process.env['ARDENT_MATTERMOST_FIXTURE_REPO'] ?? fileURLToPath(new URL('../../../../Mattermost/', import.meta.url));
const mattermostAvailable = existsSync(join(mattermostRepo, 'src/server/index.ts')) && existsSync(join(mattermostRepo, 'node_modules/tsx/package.json'));
if (process.env['ARDENT_MATTERMOST_FIXTURE_REPO'] && !mattermostAvailable) {
  throw new Error('ARDENT_MATTERMOST_FIXTURE_REPO must contain an installed Mattermost checkout');
}
async function temp(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'ardent-chatter-')); dirs.push(dir); return dir; }
async function modelFixture(): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const sourceUrl = 'https://93.184.216.34/mattermost-source';
  const sourceId = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16);
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/search')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ results: [{ url: sourceUrl, title: 'Official fixture source', content: 'Assistant verifies a fixture update', engines: ['fixture'] }], unresponsive_engines: [] }));
      return;
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      requests.push(body);
      response.setHeader('Content-Type', 'text/event-stream');
      const delta = requests.length === 1
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'news-call', type: 'function', function: { name: 'news_search', arguments: '{"query":"official update"}' } }] } }] }
        : { choices: [{ delta: { content: requests.length === 2 ? JSON.stringify({ question: 'What changed?', scope: 'fixture', as_of: new Date().toISOString(), findings: ['A fixture update was reported.'], claims: [{ text: 'Fixture update', source_ids: [sourceId], qualification: 'one source' }], contrary_evidence: [], coverage_gaps: ['Only one source'], artifact_ids: [], answer_markdown: `MATTERMOST_ASSISTANT_OK [${sourceId}]` }) : 'MATTERMOST_ASSISTANT_OK' } }] };
      response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No model port');
  return { url: `http://127.0.0.1:${address.port}/`, requests };
}
async function openPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
async function until<T>(attempt: () => Promise<T | undefined>, timeoutMs = 15000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await attempt().catch(() => undefined);
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for Mattermost fixture');
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(resolve => { child.once('exit', () => resolve()); setTimeout(resolve, 3000); });
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!mattermostAvailable)('real Mattermost JSON store process (requires an installed Mattermost checkout)', () => {
  it('routes an allowlisted DM through WebSocket, runtime, and REST reply', async () => {
    const dir = await temp();
    const port = await openPort();
    const base = `http://127.0.0.1:${port}`;
    const botToken = `fixture-${randomUUID()}`;
    const adminPassword = `Fixture-${randomUUID()}!`;
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
      cwd: mattermostRepo,
      env: { ...process.env, MATTERMOST_ENV_FILE: join(dir, 'none.env'), NODE_ENV: 'test', ENABLE_DEV_DEFAULTS: 'true', STORE_BACKEND: 'json', STORE_PATH: join(dir, 'mattermost.json'), FILE_STORAGE_PATH: join(dir, 'files'), PROFILE_IMAGE_STORAGE_PATH: join(dir, 'images'), SERVER_URL: base, PORT: String(port), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: adminPassword, ADMIN_EMAIL: 'admin@example.test', HERMES_BOT_USERNAME: 'assistant', HERMES_BOT_DISPLAY_NAME: 'Assistant', HERMES_BOT_TOKEN: botToken },
      stdio: 'ignore'
    });
    children.push(child);
    await until(async () => (await fetch(`${base}/api/v4/system/ping`)).ok ? true : undefined);
    const login = await fetch(`${base}/api/v4/users/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ login_id: 'admin', password: adminPassword }) });
    expect(login.status).toBe(200);
    const user = await login.json() as { id: string };
    const userToken = login.headers.get('token');
    expect(userToken).toBeTruthy();
    const userHeaders = { Authorization: `Bearer ${userToken ?? ''}`, 'Content-Type': 'application/json' };
    const bot = await (await fetch(`${base}/api/v4/users/username/assistant`, { headers: userHeaders })).json() as { id: string };
    const direct = await fetch(`${base}/api/v4/channels/direct`, { method: 'POST', headers: userHeaders, body: JSON.stringify([bot.id]) });
    expect(direct.status).toBe(200);
    const channel = await direct.json() as { id: string };
    const teams = await (await fetch(`${base}/api/v4/users/me/teams`, { headers: userHeaders })).json() as { id: string }[];
    const teamId = teams[0]?.id;
    if (!teamId) throw new Error('Fixture team is missing');
    const publicChannel = await fetch(`${base}/api/v4/channels`, { method: 'POST', headers: userHeaders, body: JSON.stringify({ team_id: teamId, name: 'ardent-fixture', display_name: 'Ardent Fixture', type: 'O' }) });
    expect(publicChannel.status).toBe(201);
    const group = await publicChannel.json() as { id: string };
    const joined = await fetch(`${base}/api/v4/channels/${group.id}/members`, { method: 'POST', headers: userHeaders, body: JSON.stringify({ user_id: bot.id }) });
    expect(joined.status).toBe(200);
    const profileDir = join(dir, 'ardent');
    await initTestProfile(profileDir);
    const config = (await loadConfig(profileDir)).config;
    const model = await modelFixture();
    config.providers.llamacpp.base_url = model.url;
    config.providers.llamacpp.model = 'fixture';
    config.research.searxng_url = model.url;
    config.channels.mattermost.enabled = true;
    config.channels.mattermost.base_url = base;
    config.channels.mattermost.allowed_user_ids = [user.id];
    config.channels.mattermost.allowed_channel_ids = [group.id];
    const runtime = new ArdentRuntime(profileDir, config, { MATTERMOST_TOKEN: botToken });
    const adapter = new MattermostAdapter(runtime, config.channels.mattermost, { MATTERMOST_TOKEN: botToken });
    const stop = new AbortController();
    try {
      expect((await adapter.initialize()).botId).toBe(bot.id);
      const historical = await fetch(`${base}/api/v4/posts`, { method: 'POST', headers: userHeaders,
        body: JSON.stringify({ channel_id: channel.id, message: 'Historical preclaim is not DM proof' }) });
      expect(historical.status).toBe(201);
      const historicalPost = await historical.json() as { id: string; channel_id: string;
        user_id: string; message: string; root_id?: string; file_ids?: string[] };
      await adapter.reconcile();
      expect(runtime.store.db.prepare(`SELECT channel_type FROM channel_inbound
        WHERE platform='mattermost' AND account=? AND update_id=?`)
        .get(bot.id, historicalPost.id)).toEqual({ channel_type: 'unknown' });
      await adapter.handlePost(historicalPost, 'D');
      expect(runtime.store.db.prepare(`SELECT channel_type FROM channel_inbound
        WHERE platform='mattermost' AND account=? AND update_id=?`)
        .get(bot.id, historicalPost.id)).toEqual({ channel_type: 'unknown' });
      const connected = adapter.connectOnce(stop.signal);
      await until(async () => runtime.store.cursor(`mattermost:${bot.id}:${channel.id}:last_ms`) ? true : undefined);
      const sent = await fetch(`${base}/api/v4/posts`, { method: 'POST', headers: userHeaders, body: JSON.stringify({ channel_id: channel.id, message: 'Return the fixture marker' }) });
      expect(sent.status).toBe(201);
      const post = await sent.json() as { id: string; create_at: number };
      const reply = await until(async () => {
        const listing = await (await fetch(`${base}/api/v4/channels/${channel.id}/posts`, { headers: userHeaders })).json() as { order: string[]; posts: Record<string, { user_id: string; message: string }> };
        return listing.order.map(id => listing.posts[id]).find(item => item?.user_id === bot.id && item.message.includes('MATTERMOST_ASSISTANT_OK'));
      });
      expect(reply.message).toContain('MATTERMOST_ASSISTANT_OK');
      const firstTask = runtime.store.listByCaller(`mattermost:${bot.id}:${user.id}`)[0];
      expect(firstTask && runtime.store.events(firstTask.id).some(event => event.kind === 'tool_result')).toBe(true);
      expect(runtime.store.db.prepare('SELECT channel_type FROM channel_inbound WHERE platform=? AND account=? AND task_id=?')
        .get('mattermost', bot.id, firstTask?.id)).toEqual({ channel_type: 'mattermost_dm' });
      const sourcePacket = await until(async () => {
        const listing = await (await fetch(`${base}/api/v4/channels/${channel.id}/posts`, { headers: userHeaders })).json() as { order: string[]; posts: Record<string, { user_id: string; file_ids: string[] }> };
        return listing.order.map(id => listing.posts[id]).find(item => item?.user_id === bot.id && item.file_ids.length === 2);
      });
      expect(sourcePacket.file_ids).toHaveLength(2);
      expect(runtime.store.listByCaller(`mattermost:${bot.id}:${user.id}`)).toHaveLength(1);
      const command = await fetch(`${base}/api/v4/commands/execute`, { method: 'POST', headers: userHeaders, body: JSON.stringify({ channel_id: channel.id, command: '/status' }) });
      expect(command.status).toBe(200);
      await until(async () => {
        const listing = await (await fetch(`${base}/api/v4/channels/${channel.id}/posts`, { headers: userHeaders })).json() as { order: string[]; posts: Record<string, { user_id: string; message: string }> };
        return listing.order.map(id => listing.posts[id]).find(item => item?.user_id === bot.id && item.message.includes('Session:'));
      });
      expect(model.requests).toHaveLength(2);
      const ignored = await fetch(`${base}/api/v4/posts`, { method: 'POST', headers: userHeaders, body: JSON.stringify({ channel_id: group.id, message: 'A channel message without a bot mention' }) });
      expect(ignored.status).toBe(201);
      const mentioned = await fetch(`${base}/api/v4/posts`, { method: 'POST', headers: userHeaders, body: JSON.stringify({ channel_id: group.id, message: '@assistant /status' }) });
      expect(mentioned.status).toBe(201);
      const mentionPost = await mentioned.json() as { id: string };
      await until(async () => {
        const listing = await (await fetch(`${base}/api/v4/channels/${group.id}/posts`, { headers: userHeaders })).json() as { order: string[]; posts: Record<string, { user_id: string; message: string; root_id: string }> };
        return listing.order.map(id => listing.posts[id]).find(item => item?.user_id === bot.id && item.root_id === mentionPost.id && item.message.includes('Session:'));
      });
      expect(runtime.store.listByCaller(`mattermost:${bot.id}:${user.id}`)).toHaveLength(1);
      expect(runtime.store.db.prepare('SELECT channel_type FROM channel_inbound WHERE platform=? AND account=? AND update_id=?')
        .get('mattermost', bot.id, mentionPost.id)).toEqual({ channel_type: 'mattermost_channel' });
      const form = new FormData();
      form.set('channel_id', channel.id);
      form.set('files', new Blob(['ATTACHMENT_MARKER'], { type: 'text/plain' }), 'notes.txt');
      const uploaded = await fetch(`${base}/api/v4/files`, { method: 'POST', headers: { Authorization: `Bearer ${userToken ?? ''}` }, body: form });
      expect(uploaded.status).toBe(201);
      const file = await uploaded.json() as { file_infos: { id: string }[] };
      const attached = await fetch(`${base}/api/v4/posts`, { method: 'POST', headers: userHeaders, body: JSON.stringify({ channel_id: channel.id, root_id: post.id, message: 'Read my note', file_ids: [file.file_infos[0]?.id] }) });
      expect(attached.status).toBe(201);
      const threaded = await until(async () => {
        const listing = await (await fetch(`${base}/api/v4/channels/${channel.id}/posts`, { headers: userHeaders })).json() as { order: string[]; posts: Record<string, { user_id: string; message: string; root_id: string }> };
        return listing.order.map(id => listing.posts[id]).find(item => item?.user_id === bot.id && item.root_id === post.id && item.message.includes('MATTERMOST_ASSISTANT_OK'));
      });
      expect(threaded.root_id).toBe(post.id);
      expect(model.requests.some(body => body.includes('ATTACHMENT_MARKER'))).toBe(true);
      await adapter.handlePost({ ...post, user_id: user.id, channel_id: channel.id, message: 'Return the fixture marker', root_id: '', file_ids: [] }, 'D');
      await adapter.handlePost({ ...post, id: 'unauthorized', user_id: 'other', channel_id: channel.id, message: 'Ignore me', root_id: '', file_ids: [] }, 'D');
      expect(runtime.store.listByCaller(`mattermost:${bot.id}:${user.id}`)).toHaveLength(2);
      stop.abort();
      await connected;
      const missed = await fetch(`${base}/api/v4/posts`, { method: 'POST', headers: userHeaders, body: JSON.stringify({ channel_id: channel.id, message: 'After reconnect' }) });
      expect(missed.status).toBe(201);
      const reconnectStop = new AbortController();
      const reconnected = adapter.connectOnce(reconnectStop.signal);
      await until(async () => runtime.store.listByCaller(`mattermost:${bot.id}:${user.id}`).length === 3 ? true : undefined);
      expect(model.requests).toHaveLength(4);
      reconnectStop.abort();
      await reconnected;
    } finally { stop.abort(); runtime.close(); }
  }, 30000);
});
