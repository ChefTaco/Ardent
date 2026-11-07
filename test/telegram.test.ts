import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from '../src/config.js';
import { initTestProfile } from './helpers.js';
import { ArdentRuntime } from '../src/runtime.js';
import { TelegramAdapter, TelegramConflictError } from '../src/telegram.js';
import YAML from 'yaml';

const dirs: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];
async function temp(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'ardent-telegram-')); dirs.push(dir); return dir; }
async function fixture(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  return `http://127.0.0.1:${address.port}`;
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

describe('Telegram Bot API adapter', () => {
  it('does not acknowledge an update when Team rollback closes admission during polling', async () => {
    let runtime: ArdentRuntime;
    let sends = 0;
    const api = await fixture((request, response) => {
      const method = request.url?.split('/').at(-1);
      request.resume();
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        if (method === 'getMe') response.end(JSON.stringify({ ok: true, result: { id: 999, is_bot: true, username: 'coordinator_test_bot' } }));
        else if (method === 'getWebhookInfo') response.end(JSON.stringify({ ok: true, result: { url: '' } }));
        else if (method === 'getUpdates') {
          runtime.store.closeAdmission(randomUUID());
          response.end(JSON.stringify({ ok: true, result: [{ update_id: 1, message: {
            message_id: 1, from: { id: 123, is_bot: false }, chat: { id: 123, type: 'private' }, text: '/status' } }] }));
        } else if (method === 'sendChatAction') response.end(JSON.stringify({ ok: true, result: true }));
        else { sends++; response.end(JSON.stringify({ ok: true, result: {} })); }
      });
    });
    const dir = await temp();
    await initTestProfile(dir, { profile: 'coordinator' });
    const config = (await loadConfig(dir)).config;
    config.channels.telegram.allowed_user_ids = [123];
    const env = { TELEGRAM_BOT_TOKEN: '123456:12345678901234567890' };
    runtime = new ArdentRuntime(dir, config, env);
    try {
      const adapter = new TelegramAdapter(runtime, config.channels.telegram, env, api);
      await expect(adapter.pollOnce()).rejects.toThrow('admission is fenced');
      await adapter.drain();
      expect(runtime.store.cursor('telegram:999:offset')).toBeUndefined();
      expect((runtime.store.db.prepare('SELECT count(*) AS count FROM channel_inbound').get() as { count: number }).count).toBe(0);
      expect(sends).toBe(0);
    } finally { runtime.close(); }
  });
  it('stops intake on shutdown but lets an admitted reply finish under its separate delivery signal', async () => {
    const intake = new AbortController();
    const delivery = new AbortController();
    let updates = 0;
    const api = await fixture((request, response) => {
      const method = request.url?.split('/').at(-1);
      request.resume();
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        if (method === 'getMe') response.end(JSON.stringify({ ok: true, result: { id: 999, is_bot: true, username: 'coordinator_test_bot' } }));
        else if (method === 'getWebhookInfo') response.end(JSON.stringify({ ok: true, result: { url: '' } }));
        else if (method === 'getUpdates') response.end(JSON.stringify({ ok: true, result: updates++ ? [] : [{ update_id: 1, message: {
          message_id: 1, from: { id: 123, is_bot: false }, chat: { id: 123, type: 'private' }, text: '/status' } }] }));
        else if (method === 'sendChatAction') response.end(JSON.stringify({ ok: true, result: true }));
        else {
          // Shutdown begins while this reply is in flight.
          intake.abort();
          setTimeout(() => response.end(JSON.stringify({ ok: true, result: { message_id: 77, chat: { id: 123, type: 'private' }, text: 'ok' } })), 50);
        }
      });
    });
    const dir = await temp();
    await initTestProfile(dir, { profile: 'coordinator' });
    const config = (await loadConfig(dir)).config;
    config.channels.telegram.allowed_user_ids = [123];
    const env = { TELEGRAM_BOT_TOKEN: '123456:12345678901234567890' };
    const runtime = new ArdentRuntime(dir, config, env);
    try {
      const adapter = new TelegramAdapter(runtime, config.channels.telegram, env, api);
      await adapter.run(intake.signal, delivery.signal);
      expect(delivery.signal.aborted).toBe(false);
      expect(runtime.store.delivery('telegram', '999', '1')).toMatchObject({ state: 'sent', externalId: '77' });
    } finally { runtime.close(); }
  });
  it('requires an allowed human and explicit group mention, preserves the topic, and detects a second poller', async () => {
    let modelCalls = 0;
    const model = await fixture((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      modelCalls++;
      response.setHeader('Content-Type', 'text/event-stream');
      response.end('data: {"choices":[{"delta":{"content":"GROUP_OK"}}]}\n\ndata: [DONE]\n\n');
    });
    const sent: { chat_id: number; message_thread_id?: number; reply_parameters: { message_id: number }; text: string }[] = [];
    const typing: { chat_id: number; message_thread_id?: number; action: string }[] = [];
    const activity: string[] = [];
    const api = await fixture((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        const method = request.url?.split('/').at(-1);
        if (method === 'getMe') response.end(JSON.stringify({ ok: true, result: { id: 999, is_bot: true, username: 'assistant_test_bot' } }));
        else if (method === 'getWebhookInfo') response.end(JSON.stringify({ ok: true, result: { url: '' } }));
        else if (method === 'getUpdates') {
          if ((JSON.parse(body) as { offset: number }).offset > 0) { response.statusCode = 409; response.end(JSON.stringify({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' })); return; }
          response.end(JSON.stringify({ ok: true, result: [
            { update_id: 1, message: { message_id: 1, from: { id: 123, is_bot: false }, chat: { id: -100, type: 'supergroup' }, message_thread_id: 7, text: 'No mention' } },
            { update_id: 2, message: { message_id: 2, from: { id: 456, is_bot: false }, chat: { id: -100, type: 'supergroup' }, message_thread_id: 7, text: '@assistant_test_bot Unauthorized' } },
            { update_id: 3, message: { message_id: 3, from: { id: 123, is_bot: false }, chat: { id: -100, type: 'supergroup' }, message_thread_id: 7, text: '@assistant_test_bot Answer in topic' } }
          ] }));
        } else if (method === 'sendChatAction') { typing.push(JSON.parse(body) as typeof typing[number]); activity.push('typing'); response.end(JSON.stringify({ ok: true, result: true })); }
        else if (method === 'sendMessage') { const input = JSON.parse(body) as typeof sent[number]; sent.push(input); activity.push('reply'); response.end(JSON.stringify({ ok: true, result: { message_id: 100, chat: { id: -100, type: 'supergroup' } } })); }
        else response.writeHead(404).end('{}');
      });
    });
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = `${model}/`;
    config.providers.llamacpp.model = 'fixture';
    config.channels.telegram.allowed_user_ids = [123];
    config.channels.telegram.allowed_chat_ids = [-100];
    const env = { TELEGRAM_BOT_TOKEN: '123456:12345678901234567890' };
    const runtime = new ArdentRuntime(dir, config, env);
    try {
      const adapter = new TelegramAdapter(runtime, config.channels.telegram, env, api);
      await adapter.pollOnce();
      await adapter.drain();
      expect(modelCalls).toBe(1);
      expect(sent).toHaveLength(1);
      expect(typing).toEqual([{ chat_id: -100, message_thread_id: 7, action: 'typing' }]);
      expect(activity).toEqual(['typing', 'reply']);
      expect(sent[0]).toMatchObject({ chat_id: -100, message_thread_id: 7, reply_parameters: { message_id: 3 }, text: 'GROUP_OK' });
      expect(runtime.store.db.prepare(`SELECT channel_type FROM channel_inbound
        WHERE platform='telegram' AND account='999' AND update_id='3'`).get())
        .toEqual({ channel_type: 'telegram_supergroup' });
      await expect(adapter.pollOnce()).rejects.toBeInstanceOf(TelegramConflictError);
      await expect(adapter.pollOnce()).rejects.toBeInstanceOf(TelegramConflictError);
    } finally { runtime.close(); }
  });
  it('cancels a running task from /stop without delivering its later model answer', async () => {
    let modelCalls = 0;
    const model = await fixture((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      modelCalls++;
      response.setHeader('Content-Type', 'text/event-stream');
      setTimeout(() => response.end('data: {"choices":[{"delta":{"content":"SHOULD_NOT_DELIVER"}}]}\n\ndata: [DONE]\n\n'), 200);
    });
    const sent: string[] = [];
    const api = await fixture((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        const method = request.url?.split('/').at(-1);
        if (method === 'getMe') response.end(JSON.stringify({ ok: true, result: { id: 999, is_bot: true } }));
        else if (method === 'getWebhookInfo') response.end(JSON.stringify({ ok: true, result: { url: '' } }));
        else if (method === 'getUpdates') response.end(JSON.stringify({ ok: true, result: (JSON.parse(body) as { offset: number }).offset > 1 ? [] : [
          { update_id: 1, message: { message_id: 1, from: { id: 123, is_bot: false }, chat: { id: 123, type: 'private' }, text: 'Long task' } },
          { update_id: 2, message: { message_id: 2, from: { id: 123, is_bot: false }, chat: { id: 123, type: 'private' }, text: '/stop' } }
        ] }));
        else if (method === 'sendMessage') { sent.push((JSON.parse(body) as { text: string }).text); response.end(JSON.stringify({ ok: true, result: { message_id: 100 + sent.length, chat: { id: 123, type: 'private' } } })); }
        else response.writeHead(404).end('{}');
      });
    });
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = `${model}/`;
    config.providers.llamacpp.model = 'fixture';
    config.channels.telegram.allowed_user_ids = [123];
    const env = { TELEGRAM_BOT_TOKEN: '123456:12345678901234567890' };
    const runtime = new ArdentRuntime(dir, config, env);
    try {
      const adapter = new TelegramAdapter(runtime, config.channels.telegram, env, api);
      await adapter.pollOnce();
      await adapter.drain();
      expect(runtime.store.db.prepare(`SELECT channel_type FROM channel_inbound
        WHERE platform='telegram' AND account='999' AND update_id='1'`).get())
        .toEqual({ channel_type: 'telegram_private' });
      expect(sent.join('\n')).toContain('Cancellation requested');
      expect(sent.join('\n')).not.toContain('SHOULD_NOT_DELIVER');
      const executionMayHaveStarted = runtime.store.listByCaller('telegram:999:123')[0]
        ? runtime.store.events(runtime.store.listByCaller('telegram:999:123')[0]!.id).some(event => event.kind === 'model_started')
        : false;
      expect(runtime.store.listByCaller('telegram:999:123')[0]?.state).toBe(executionMayHaveStarted ? 'unknown' : 'cancelled');
      expect(modelCalls).toBeLessThanOrEqual(1);
    } finally { runtime.close(); }
  });
  it('retries a definite rate limit without rerunning research and splits long output', async () => {
    let modelCalls = 0;
    const model = await fixture((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      modelCalls++;
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'L'.repeat(9000) } }] })}\n\ndata: [DONE]\n\n`);
    });
    let rateLimits = 0;
    const sent: string[] = [];
    const api = await fixture((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        const method = request.url?.split('/').at(-1);
        if (method === 'getMe') response.end(JSON.stringify({ ok: true, result: { id: 999, is_bot: true } }));
        else if (method === 'getWebhookInfo') response.end(JSON.stringify({ ok: true, result: { url: '' } }));
        else if (method === 'getUpdates') response.end(JSON.stringify({ ok: true, result: [{ update_id: 1, message: { message_id: 1, from: { id: 123, is_bot: false }, chat: { id: 123, type: 'private' }, text: 'Long answer' } }] }));
        else if (method === 'sendMessage') {
          if (rateLimits++ === 0) { response.statusCode = 429; response.end(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } })); return; }
          sent.push((JSON.parse(body) as { text: string }).text);
          response.end(JSON.stringify({ ok: true, result: { message_id: 100 + sent.length, chat: { id: 123, type: 'private' } } }));
        } else response.writeHead(404).end('{}');
      });
    });
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = `${model}/`;
    config.providers.llamacpp.model = 'fixture';
    config.channels.telegram.allowed_user_ids = [123];
    const env = { TELEGRAM_BOT_TOKEN: '123456:12345678901234567890' };
    const runtime = new ArdentRuntime(dir, config, env);
    try {
      const adapter = new TelegramAdapter(runtime, config.channels.telegram, env, api);
      await adapter.pollOnce();
      await adapter.drain();
      expect(modelCalls).toBe(1);
      expect(sent.join('')).toBe('L'.repeat(9000));
      expect(sent.length).toBe(3);
      expect(sent.every(part => part.length <= 3900)).toBe(true);
      expect(runtime.store.delivery('telegram', '999', '1')?.state).toBe('sent');
    } finally { runtime.close(); }
  }, 5000);
  it('runs a real gateway against a Bot API fixture with research and document delivery', async () => {
    const sourceUrl = 'https://93.184.216.34/telegram-source';
    const sourceId = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16);
    let modelTurns = 0;
    const model = await fixture((request, response) => {
      if (request.url?.startsWith('/search')) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ results: [{ url: sourceUrl, title: 'Official fixture', content: 'Verified report', engines: ['fixture'] }], unresponsive_engines: [] }));
        return;
      }
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      modelTurns++;
      const delta = modelTurns === 1
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'search-call', type: 'function', function: { name: 'news_search', arguments: '{"query":"official update"}' } }] } }] }
        : { choices: [{ delta: { content: JSON.stringify({ question: 'What changed?', scope: 'fixture', as_of: new Date().toISOString(), findings: ['A fixture update was reported.'], claims: [{ text: 'Fixture update', source_ids: [sourceId], qualification: 'one source' }], contrary_evidence: [], coverage_gaps: ['Only one source'], artifact_ids: [], answer_markdown: `TELEGRAM_GATEWAY_OK [${sourceId}]` }) } }] };
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`);
    });
    const sent: string[] = [];
    const documents: string[] = [];
    const api = await fixture((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const method = request.url?.split('/').at(-1);
        response.setHeader('Content-Type', 'application/json');
        if (method === 'getMe') response.end(JSON.stringify({ ok: true, result: { id: 999, is_bot: true, username: 'assistant_test_bot' } }));
        else if (method === 'getWebhookInfo') response.end(JSON.stringify({ ok: true, result: { url: '' } }));
        else if (method === 'getUpdates') {
          const offset = (JSON.parse(body) as { offset: number }).offset;
          const updates = offset <= 10 ? [{ update_id: 10, message: { message_id: 20, from: { id: 123, is_bot: false }, chat: { id: 123, type: 'private' }, text: 'Research an official update' } }] : offset <= 11 && documents.length >= 2 ? [{ update_id: 11, message: { message_id: 21, from: { id: 123, is_bot: false }, chat: { id: 123, type: 'private' }, text: '/sources' } }] : [];
          setTimeout(() => response.end(JSON.stringify({ ok: true, result: updates })), 40);
        } else if (method === 'sendMessage') {
          sent.push((JSON.parse(body) as { text: string }).text);
          response.end(JSON.stringify({ ok: true, result: { message_id: 200 + sent.length, chat: { id: 123, type: 'private' } } }));
        } else if (method === 'sendDocument') {
          documents.push(body);
          response.end(JSON.stringify({ ok: true, result: { message_id: 300 + documents.length, chat: { id: 123, type: 'private' } } }));
        } else response.writeHead(404).end('{}');
      });
    });
    const portServer = createServer();
    await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
    const address = portServer.address();
    if (!address || typeof address === 'string') throw new Error('No gateway port');
    await new Promise<void>(resolve => portServer.close(() => resolve()));
    const dir = await temp();
    await initTestProfile(dir);
    const loaded = await loadConfig(dir);
    const doc = YAML.parseDocument(loaded.text);
    doc.setIn(['a2a', 'enabled'], false);
    doc.setIn(['api', 'port'], address.port);
    doc.setIn(['providers', 'llamacpp', 'base_url'], `${model}/`);
    doc.setIn(['providers', 'llamacpp', 'model'], 'fixture');
    doc.setIn(['research', 'searxng_url'], `${model}/`);
    doc.setIn(['channels', 'telegram', 'enabled'], true);
    doc.setIn(['channels', 'telegram', 'allowed_user_ids'], [123]);
    await saveConfig(dir, String(doc), loaded.revision);
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'gateway', 'run', '--profile-path', dir], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, NODE_ENV: 'test', ARDENT_TELEGRAM_API_FIXTURE_URL: api, TELEGRAM_BOT_TOKEN: '123456:12345678901234567890' }, stdio: 'ignore' });
    children.push(child);
    const started = Date.now();
    while (Date.now() - started < 10000 && (sent.length < 2 || documents.length < 2)) await new Promise(resolve => setTimeout(resolve, 50));
    expect(sent.join('\n')).toContain('TELEGRAM_GATEWAY_OK');
    expect(sent.join('\n')).toContain(`Source IDs for task`);
    expect(sent.join('\n')).toContain(sourceId);
    expect(documents).toHaveLength(2);
    expect(modelTurns).toBe(2);
    expect((await fetch(`http://127.0.0.1:${address.port}/health/live`)).status).toBe(200);
  }, 15000);
  it('polls an authorized user through the real runtime, replies, and deduplicates replay', async () => {
    let modelCalls = 0;
    const model = await fixture((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      modelCalls++;
      response.setHeader('Content-Type', 'text/event-stream');
      response.end('data: {"choices":[{"delta":{"content":"TELEGRAM_ASSISTANT_OK"}}]}\n\ndata: [DONE]\n\n');
    });
    const sent: { chat_id: number; text: string; reply_parameters: { message_id: number } }[] = [];
    const offsets: number[] = [];
    const api = await fixture((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        const method = request.url?.split('/').at(-1);
        if (method === 'getMe') response.end(JSON.stringify({ ok: true, result: { id: 999, is_bot: true, username: 'assistant_test_bot' } }));
        else if (method === 'getWebhookInfo') response.end(JSON.stringify({ ok: true, result: { url: '' } }));
        else if (method === 'getUpdates') {
          const input = JSON.parse(body) as { offset: number };
          offsets.push(input.offset);
          const updates = [
            { update_id: 1, message: { message_id: 11, from: { id: 123, is_bot: false }, chat: { id: 123, type: 'private' }, text: 'Say marker' } },
            { update_id: 2, message: { message_id: 12, from: { id: 456, is_bot: false }, chat: { id: 456, type: 'private' }, text: 'Unauthorized' } },
            { update_id: 3, message: { message_id: 13, from: { id: 999, is_bot: true }, chat: { id: 123, type: 'private' }, text: 'Bot loop' } },
            { update_id: 4, message: { message_id: 14, from: { id: 123, is_bot: false }, chat: { id: 123, type: 'private' }, text: '/status' } }
          ];
          response.end(JSON.stringify({ ok: true, result: updates.filter(update => update.update_id >= input.offset) }));
        } else if (method === 'sendMessage') {
          const input = JSON.parse(body) as typeof sent[number];
          sent.push(input);
          response.end(JSON.stringify({ ok: true, result: { message_id: 100 + sent.length, chat: { id: input.chat_id, type: 'private' } } }));
        } else if (method === 'sendChatAction') response.end(JSON.stringify({ ok: true, result: true }));
        else response.writeHead(404).end('{}');
      });
    });
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = model;
    config.providers.llamacpp.model = 'fixture';
    config.channels.telegram.enabled = true;
    config.channels.telegram.allowed_user_ids = [123];
    const env = { TELEGRAM_BOT_TOKEN: '123456:12345678901234567890' };
    const runtime = new ArdentRuntime(dir, config, env);
    try {
      const adapter = new TelegramAdapter(runtime, config.channels.telegram, env, api);
      expect(await adapter.initialize()).toEqual({ botId: 999, username: 'assistant_test_bot' });
      expect(await adapter.pollOnce()).toBe(4);
      await adapter.drain();
      expect(modelCalls).toBe(1);
      expect(sent).toHaveLength(2);
      expect(sent.find(item => item.reply_parameters.message_id === 11)?.text).toContain('TELEGRAM_ASSISTANT_OK');
      expect(sent.find(item => item.reply_parameters.message_id === 14)?.text).toContain('Session:');
      expect(runtime.store.cursor('telegram:999:offset')).toBe('5');
      runtime.store.setCursor('telegram:999:offset', '1');
      const restarted = new TelegramAdapter(runtime, config.channels.telegram, env, api);
      await restarted.pollOnce();
      await restarted.drain();
      expect(modelCalls).toBe(1);
      expect(sent).toHaveLength(2);
      expect(offsets).toEqual([0, 1]);
    } finally { runtime.close(); }
  });
  it('rejects webhook ownership before polling and does not delete it', async () => {
    const methods: string[] = [];
    const api = await fixture((request, response) => {
      methods.push(request.url?.split('/').at(-1) ?? '');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true, result: methods.at(-1) === 'getMe' ? { id: 999, is_bot: true } : { url: 'https://existing.example/hook' } }));
    });
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.channels.telegram.allowed_user_ids = [123];
    const runtime = new ArdentRuntime(dir, config);
    try {
      const adapter = new TelegramAdapter(runtime, config.channels.telegram, { TELEGRAM_BOT_TOKEN: '123456:12345678901234567890' }, api);
      await expect(adapter.initialize()).rejects.toBeInstanceOf(TelegramConflictError);
      expect(methods).toEqual(['getMe', 'getWebhookInfo']);
    } finally { runtime.close(); }
  });
});
