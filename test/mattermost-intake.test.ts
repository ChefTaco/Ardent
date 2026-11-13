import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { initTestProfile } from './helpers.js';
import { ArdentRuntime } from '../src/runtime.js';
import { MattermostAdapter, mentionPattern } from '../src/mattermost.js';

describe('Mattermost intake', () => {
  it('recognizes a mention followed by punctuation but not a longer username', () => {
    const pattern = mentionPattern('coordinator');
    for (const text of ['@coordinator hello', 'hello @coordinator', '@coordinator: hello', '@coordinator, hello', 'thanks @coordinator.',
      '(@coordinator) hello', '@Coordinator; hello', 'is that right @coordinator?'])
      expect(pattern.test(text), text).toBe(true);
    for (const text of ['@coordinator.helper hello', '@coordinator-two hello', '@coordinator_two hello', '@coordinators hello',
      'operator@coordinator hello', 'coordinator hello'])
      expect(pattern.test(text), text).toBe(false);
    expect('@coordinator: hello'.replace(pattern, '$1').trim()).toBe(': hello');
    expect(mentionPattern('team.bot').test('@teamxbot hello')).toBe(false);
  });

  it('cuts a post longer than one channel event instead of failing reconciliation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ardent-mattermost-intake-'));
    const long = { id: 'long', user_id: 'operator', channel_id: 'dm', message: `/status ${'x'.repeat(16_200)}`, create_at: 2 };
    const replies: string[] = [];
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/v4/users/me') response.end(JSON.stringify({ id: 'bot', username: 'coordinator', is_bot: true }));
      else if (request.url === '/api/v4/users/me/channels') response.end(JSON.stringify([{ id: 'dm', type: 'D' }]));
      else if (request.url?.startsWith('/api/v4/channels/dm/posts')) response.end(JSON.stringify({ order: ['long'], posts: { long } }));
      else if (request.url === '/api/v4/posts' && request.method === 'POST') {
        let body = '';
        request.on('data', chunk => { body += String(chunk); });
        request.on('end', () => {
          const reply = JSON.parse(body) as { channel_id: string; message: string };
          replies.push(reply.message);
          response.end(JSON.stringify({ id: `reply-${replies.length}`, user_id: 'bot', create_at: Date.now(), ...reply }));
        });
      } else response.writeHead(404).end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.channels.mattermost.base_url = `http://127.0.0.1:${address.port}`;
    config.channels.mattermost.allowed_user_ids = ['operator'];
    const env = { MATTERMOST_TOKEN: 'fixture-token' };
    const runtime = new ArdentRuntime(dir, config, env);
    try {
      const adapter = new MattermostAdapter(runtime, config.channels.mattermost, env);
      await adapter.initialize();
      runtime.store.setCursor('mattermost:bot:dm:last_ms', '1');
      // Both the startup pass and the periodic pass must survive the post.
      expect(await adapter.reconcile(false)).toBe(1);
      for (let i = 0; i < 300 && runtime.store.delivery('mattermost', 'bot', 'long')?.state !== 'sent'; i++)
        await new Promise(resolve => setTimeout(resolve, 10));
      expect(runtime.store.delivery('mattermost', 'bot', 'long')?.state).toBe('sent');
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('Session:');
      expect(await adapter.reconcile(true)).toBe(0);
      expect(runtime.store.cursor('mattermost:bot:last_error')).toBeUndefined();
    } finally {
      runtime.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
