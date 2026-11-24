import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { loadConfig, type ArdentConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { TelegramAdapter } from '../src/telegram.js';
import { MattermostAdapter } from '../src/mattermost.js';
import { createA2ASurface } from '../src/a2a-server.js';
import { definePlugin } from '../src/plugins.js';
import { defineTool, type Tool } from '../src/tools.js';
import { initTestProfile } from './helpers.js';

const dirs: string[] = [];
const servers: Server[] = [];
const runtimes: ArdentRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { try { if (runtime.store.db.open) runtime.close(); } catch { /* a crashed runtime is abandoned */ } }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  for (const started = Date.now(); Date.now() - started < ms; await sleep(10)) if (await check()) return;
  throw new Error('Condition not reached');
}
async function body(request: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return text;
}
async function listen(handler: Parameters<typeof createServer>[0]): Promise<{ url: string; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  return { url: `http://127.0.0.1:${address.port}`, port: address.port };
}
type Message = { role: string; content: string | null; tool_calls?: Array<{ id: string }> };
/** llama.cpp: write once, then answer "Recovered answer". `gate` holds the first reply. */
async function llama(gate?: Promise<void>): Promise<string> {
  let count = 0;
  const { url } = await listen((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    void body(request).then(async text => {
      const messages = (JSON.parse(text) as { messages: Message[] }).messages;
      if (count++ === 0) await gate;
      response.setHeader('Content-Type', 'text/event-stream');
      if (messages.at(-1)?.role === 'user') response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-w1', type: 'function', function: { name: 'fixture_write', arguments: '{"text":"hello"}' } }] } }] })}\n\n`);
      else response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Recovered answer' } }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  return `${url}/`;
}
function writeTool(side: string): Tool {
  return defineTool({ name: 'fixture_write', description: 'Write one fixture record', input: z.object({ text: z.string() }).strict(),
    output: z.object({ written: z.literal(true) }).strict(), effect: 'external-write', contexts: ['direct', 'peer'], timeoutMs: 10_000,
    handler: async (_input, _signal, ctx) => { await appendFile(side, `${ctx?.idempotencyKey ?? 'none'}\n`); return { written: true as const }; } });
}
async function writes(side: string): Promise<number> {
  try { return (await readFile(side, 'utf8')).split('\n').filter(Boolean).length; } catch { return 0; }
}
/**
 * The process stops: its database closes and it writes nothing more. Its
 * best-effort cursor writes (a real crash never runs them) become no-ops so
 * the abandoned adapters do not report unhandled rejections.
 */
function crash(runtime: ArdentRuntime): void {
  runtime.store.db.close();
  runtime.store.setCursor = () => undefined;
}
/** Close the runtime's database at the first step boundary after a matching journal event: it can write nothing more. */
function crashAfter(runtime: ArdentRuntime, match: (kind: string, detail: Record<string, unknown>) => boolean): Promise<void> {
  let armed = false;
  let crashed!: () => void;
  const done = new Promise<void>(resolve => { crashed = resolve; });
  const append = runtime.store.append.bind(runtime.store);
  runtime.store.append = (id, kind, detail) => { append(id, kind, detail); if (match(kind, (detail ?? {}) as Record<string, unknown>)) armed = true; };
  const admission = runtime.store.taskAdmission.bind(runtime.store);
  runtime.store.taskAdmission = id => {
    if (armed && runtime.store.db.open) { crash(runtime); crashed(); }
    if (!runtime.store.db.open) throw new Error('simulated crash');
    return admission(id);
  };
  return done;
}
const afterReceipt = (runtime: ArdentRuntime) => crashAfter(runtime, (kind, detail) => kind === 'tool_result' && detail.name === 'fixture_write');
const afterAttempt = (runtime: ArdentRuntime) => crashAfter(runtime, (kind, detail) => kind === 'tool_attempt' && detail.name === 'fixture_write');
function start(dir: string, config: ArdentConfig, env: NodeJS.ProcessEnv, side: string): ArdentRuntime {
  const runtime = new ArdentRuntime(dir, config, env);
  runtimes.push(runtime);
  runtime.tools.register(writeTool(side));
  return runtime;
}
async function profile(edit: (config: ArdentConfig) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-recovery-delivery-'));
  dirs.push(dir);
  await initTestProfile(dir);
  const config = (await loadConfig(dir)).config;
  config.research.enabled = false;
  edit(config);
  return { dir, config, side: join(dir, 'writes.log') };
}

describe('recovered channel tasks deliver their reply', () => {
  async function telegram() {
    const sent: Array<{ chat_id: number; text: string; reply_parameters: { message_id: number } }> = [];
    let holdSends = false;
    const api = await listen((request, response) => {
      void body(request).then(text => {
        response.setHeader('Content-Type', 'application/json');
        const method = request.url?.split('/').at(-1);
        if (method === 'getMe') response.end(JSON.stringify({ ok: true, result: { id: 999, is_bot: true, username: 'assistant_test_bot' } }));
        else if (method === 'getWebhookInfo') response.end(JSON.stringify({ ok: true, result: { url: '' } }));
        else if (method === 'getUpdates') {
          const offset = (JSON.parse(text) as { offset?: number }).offset ?? 0;
          response.end(JSON.stringify({ ok: true, result: offset <= 1 ? [{ update_id: 1, message: { message_id: 11, from: { id: 123, is_bot: false }, chat: { id: 123, type: 'private' }, text: 'Write the record' } }] : [] }));
        } else if (method === 'sendMessage') {
          const input = JSON.parse(text) as typeof sent[number];
          sent.push(input);
          // A held send reached Telegram but its outcome never comes back (the process stops first).
          if (holdSends) return;
          response.end(JSON.stringify({ ok: true, result: { message_id: 100 + sent.length, chat: { id: input.chat_id, type: 'private' } } }));
        } else response.end(JSON.stringify({ ok: true, result: true }));
      });
    });
    const model = await llama();
    const setup = await profile(config => {
      config.providers.llamacpp.base_url = model;
      config.providers.llamacpp.model = 'fixture';
      config.channels.telegram.enabled = true;
      config.channels.telegram.allowed_user_ids = [123];
    });
    return { ...setup, api: api.url, sent, env: { TELEGRAM_BOT_TOKEN: '123456:12345678901234567890' }, holdSends: (value: boolean) => { holdSends = value; } };
  }

  it('Telegram: a task resumed after a crash at a clean cut point sends exactly one reply', async () => {
    const fixture = await telegram();
    const first = start(fixture.dir, fixture.config, fixture.env, fixture.side);
    const crashed = afterReceipt(first);
    const adapter = new TelegramAdapter(first, fixture.config.channels.telegram, fixture.env, fixture.api);
    await adapter.initialize();
    void adapter.pollOnce().catch(() => undefined);
    await crashed;
    await sleep(50);
    expect(fixture.sent).toHaveLength(0);

    const restarted = start(fixture.dir, fixture.config, fixture.env, fixture.side);
    const [taskId] = restarted.recovered.resumed;
    expect(taskId).toBeDefined();
    await restarted.resumeRecovered(fixture.env);
    const next = new TelegramAdapter(restarted, fixture.config.channels.telegram, fixture.env, fixture.api);
    await next.initialize();
    const stop = new AbortController();
    const watching = next.watchRecovered(stop.signal);
    // The update is polled again too: it is already claimed and must not be answered a second time.
    await next.pollOnce();
    await until(() => restarted.store.delivery('telegram', '999', '1')?.state === 'sent');
    await next.drain();
    stop.abort();
    await watching;
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]).toMatchObject({ chat_id: 123, reply_parameters: { message_id: 11 }, text: 'Recovered answer' });
    expect(restarted.store.get(taskId!)?.state).toBe('completed');
    expect(await writes(fixture.side)).toBe(1);

    // Another start finds the recorded delivery and sends nothing.
    const again = new TelegramAdapter(restarted, fixture.config.channels.telegram, fixture.env, fixture.api);
    await again.initialize();
    const stopAgain = new AbortController();
    const watchingAgain = again.watchRecovered(stopAgain.signal);
    await sleep(100);
    stopAgain.abort();
    await watchingAgain;
    expect(fixture.sent).toHaveLength(1);
  });

  it('Telegram: a crash after the recovered reply was recorded never sends it again', async () => {
    const fixture = await telegram();
    const first = start(fixture.dir, fixture.config, fixture.env, fixture.side);
    const crashed = afterReceipt(first);
    const adapter = new TelegramAdapter(first, fixture.config.channels.telegram, fixture.env, fixture.api);
    await adapter.initialize();
    void adapter.pollOnce().catch(() => undefined);
    await crashed;
    await sleep(50);
    const second = start(fixture.dir, fixture.config, fixture.env, fixture.side);
    await second.resumeRecovered(fixture.env);
    fixture.holdSends(true);
    const sender = new TelegramAdapter(second, fixture.config.channels.telegram, fixture.env, fixture.api);
    await sender.initialize();
    const stop = new AbortController();
    void sender.watchRecovered(stop.signal);
    await until(() => fixture.sent.length === 1);
    // The delivery was recorded before the send; the process stops before its outcome.
    expect(second.store.delivery('telegram', '999', '1')?.state).toBe('queued');
    crash(second);
    fixture.holdSends(false);
    const third = start(fixture.dir, fixture.config, fixture.env, fixture.side);
    expect(third.store.delivery('telegram', '999', '1')?.state).toBe('unknown');
    await third.resumeRecovered(fixture.env);
    const next = new TelegramAdapter(third, fixture.config.channels.telegram, fixture.env, fixture.api);
    await next.initialize();
    const stopNext = new AbortController();
    const watching = next.watchRecovered(stopNext.signal);
    await sleep(150);
    stopNext.abort();
    await watching;
    expect(fixture.sent).toHaveLength(1);
  });

  it('Mattermost: resumed and continued tasks answer their post once, including after a reconnect pass', async () => {
    const replies: Array<{ channel_id: string; message: string; root_id?: string }> = [];
    const post = { id: 'post-1', user_id: 'operator', channel_id: 'dm', message: 'Write the record', create_at: Date.now() - 1000 };
    const api = await listen((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/v4/users/me') response.end(JSON.stringify({ id: 'bot', username: 'coordinator', is_bot: true }));
      else if (request.url === '/api/v4/users/me/channels') response.end(JSON.stringify([{ id: 'dm', type: 'D' }]));
      else if (request.url?.startsWith('/api/v4/channels/dm/posts')) response.end(JSON.stringify({ order: ['post-1'], posts: { 'post-1': post } }));
      else if (request.url === '/api/v4/posts' && request.method === 'POST') {
        void body(request).then(text => {
          const reply = JSON.parse(text) as typeof replies[number];
          replies.push(reply);
          response.end(JSON.stringify({ id: `reply-${replies.length}`, user_id: 'bot', create_at: Date.now(), ...reply }));
        });
      } else response.writeHead(404).end('{}');
    });
    const model = await llama();
    const { dir, config, side } = await profile(item => {
      item.providers.llamacpp.base_url = model;
      item.providers.llamacpp.model = 'fixture';
      item.channels.mattermost.base_url = api.url;
      item.channels.mattermost.allowed_user_ids = ['operator'];
    });
    const env = { MATTERMOST_TOKEN: 'fixture-token' };

    // Held at a write, then continued by an operator decision: the continuation answers the original post.
    const first = start(dir, config, env, side);
    const crashed = afterAttempt(first);
    const adapter = new MattermostAdapter(first, config.channels.mattermost, env);
    await adapter.initialize();
    await adapter.handlePost(post, 'D');
    await crashed;
    await sleep(50);
    const restarted = start(dir, config, env, side);
    await restarted.resumeRecovered(env);
    const taskId = restarted.store.db.prepare("SELECT task_id FROM channel_inbound WHERE update_id='post-1'").get() as { task_id: string };
    expect(restarted.store.get(taskId.task_id)?.state).toBe('unknown');
    const next = new MattermostAdapter(restarted, config.channels.mattermost, env);
    await next.initialize();
    const stop = new AbortController();
    const watching = next.watchRecovered(stop.signal);
    // A reconnect pass re-handles the claimed post; a held task is not answered yet.
    restarted.store.setCursor('mattermost:bot:dm:last_ms', '1');
    await next.reconcile(false);
    await sleep(100);
    expect(replies).toHaveLength(0);
    const decided = await restarted.decideRecovery(taskId.task_id, { action: 'mark_applied' }, env);
    await restarted.run(decided.continuation!.id, env);
    await until(() => restarted.store.delivery('mattermost', 'bot', 'post-1')?.state === 'sent');
    await next.reconcile(false);
    await sleep(100);
    stop.abort();
    await watching;
    expect(replies).toEqual([{ channel_id: 'dm', message: 'Recovered answer' }]);
    expect(restarted.store.delivery('mattermost', 'bot', 'post-1')?.taskId).toBe(decided.continuation!.id);
    expect(await writes(side)).toBe(0);
  });
});

describe('A2A peers see resumed, held and continued tasks', () => {
  async function surface(options: { recoveryEnabled?: boolean } = {}) {
    const pushes: Array<{ state?: string; metadata?: unknown }> = [];
    const callback = await listen((request, response) => {
      void body(request).then(text => {
        const event = JSON.parse(text) as { statusUpdate?: { status?: { state?: string }; metadata?: unknown } };
        if (event.statusUpdate) pushes.push({ ...(event.statusUpdate.status?.state ? { state: event.statusUpdate.status.state } : {}), metadata: event.statusUpdate.metadata });
        response.writeHead(200).end();
      });
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const model = await llama(gate);
    const reservation = await listen(() => undefined);
    const port = reservation.port;
    await new Promise<void>(resolve => servers.pop()!.close(() => resolve()));
    const setup = await profile(config => {
      config.providers.llamacpp.base_url = model;
      config.providers.llamacpp.model = 'fixture';
      config.a2a.public_url = `http://127.0.0.1:${port}`;
      if (options.recoveryEnabled === false) config.execution.recovery = { enabled: false };
    });
    await writeFile(join(setup.dir, 'peers.yaml'), `schema_version: 1\npeers:\n  - id: coordinator\n    url: http://127.0.0.1:${port}\n    token_env: COORDINATOR_TOKEN\n    transport_ports: [${port + 1}]\n    callback_ports: [${callback.port}]\n    allow_private_callbacks: true\n`);
    const env = { COORDINATOR_TOKEN: 'fixture-token-1234567890' };
    const plugins = [definePlugin({ name: 'grant', peerTool: tool => tool.name.startsWith('fixture_') })];
    const context = new ServerCallContext({ tenant: '', user: { isAuthenticated: true, userName: 'coordinator' }, requestedVersion: '1.0' });
    const open = async (crash?: (runtime: ArdentRuntime) => Promise<void>) => {
      const runtime = start(setup.dir, setup.config, env, setup.side);
      const crashed = crash?.(runtime);
      await runtime.usePlugins(plugins, env);
      await runtime.resumeRecovered(env);
      const created = await createA2ASurface(runtime, setup.config, env);
      return { runtime, surface: created, crashed };
    };
    /** Send a peer message that returns at once, register a push callback, then let the model answer. */
    const send = async (runtime: ArdentRuntime, created: Awaited<ReturnType<typeof createA2ASurface>>) => {
      const message = { messageId: 'peer-1', role: 1, parts: [{ content: { $case: 'text', value: 'Write the record' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
        contextId: '', taskId: '', metadata: {}, extensions: [], referenceTaskIds: [] };
      const result = await created.handler.sendMessage({ tenant: '', message, configuration: { acceptedOutputModes: [], taskPushNotificationConfig: undefined, returnImmediately: true }, metadata: undefined } as never, context);
      const a2aTaskId = (result as { id: string }).id;
      await created.pushSender.store.save(a2aTaskId, context, { tenant: '', id: 'cb', taskId: a2aTaskId, url: `${callback.url}/callback`, token: 'callback-secret', authentication: undefined });
      release();
      void runtime;
      return a2aTaskId;
    };
    const a2aState = (runtime: ArdentRuntime, id: string) => {
      const row = runtime.store.db.prepare('SELECT task_json FROM a2a_tasks WHERE id=?').get(id) as { task_json: string };
      const task = JSON.parse(row.task_json) as { status?: { state?: string }; metadata?: { ardentRecovery?: Record<string, unknown> }; artifacts?: Array<{ parts: Array<{ text?: string }> }> };
      return { status: task.status?.state, task };
    };
    const finals = () => pushes.filter(item => ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'].includes(item.state ?? ''));
    return { ...setup, env, open, send, a2aState, pushes, finals, context };
  }

  it('a resumed peer task reports completed with its answer, and its final push fires once', async () => {
    const peer = await surface();
    const first = await peer.open(afterReceipt);
    const a2aTaskId = await peer.send(first.runtime, first.surface);
    await first.crashed;
    await sleep(50);
    const second = await peer.open();
    await until(async () => { await second.surface.recovery.idle(); return peer.a2aState(second.runtime, a2aTaskId).status === 'TASK_STATE_COMPLETED'; });
    await second.surface.pushSender.drain();
    const { task } = peer.a2aState(second.runtime, a2aTaskId);
    expect(task.artifacts?.some(artifact => artifact.parts.some(part => part.text === 'Recovered answer'))).toBe(true);
    expect(peer.finals()).toEqual([expect.objectContaining({ state: 'TASK_STATE_COMPLETED' })]);
    // Another pass, or another start, publishes nothing more.
    const third = await peer.open();
    await third.surface.recovery.idle();
    await third.surface.pushSender.drain();
    expect(peer.finals()).toHaveLength(1);
    expect(await writes(peer.side)).toBe(1);
  });

  it('a held peer task stays working with its recovery reason, then follows the continuation to completed once', async () => {
    const peer = await surface();
    const first = await peer.open(afterAttempt);
    const a2aTaskId = await peer.send(first.runtime, first.surface);
    await first.crashed;
    await sleep(50);
    const second = await peer.open();
    await second.surface.recovery.idle();
    await second.surface.pushSender.drain();
    const operation = (second.runtime.store.db.prepare('SELECT operation_id FROM a2a_operation_map WHERE a2a_task_id=?').get(a2aTaskId) as { operation_id: string }).operation_id;
    expect(second.runtime.store.get(operation)?.state).toBe('unknown');
    const held = peer.a2aState(second.runtime, a2aTaskId);
    expect(held.status).toBe('TASK_STATE_WORKING');
    expect(held.task.metadata?.ardentRecovery).toMatchObject({ status: 'awaiting_decision', reason_code: 'UNSETTLED_EXTERNAL_WRITE' });
    expect(peer.finals()).toHaveLength(0);
    const decided = await second.runtime.decideRecovery(operation, { action: 'mark_applied' }, peer.env);
    await second.runtime.run(decided.continuation!.id, peer.env);
    await until(async () => { await second.surface.recovery.idle(); return peer.a2aState(second.runtime, a2aTaskId).status === 'TASK_STATE_COMPLETED'; });
    await second.surface.pushSender.drain();
    expect(peer.a2aState(second.runtime, a2aTaskId).task.metadata?.ardentRecovery).toMatchObject({ continuation_task_id: decided.continuation!.id });
    expect((second.runtime.store.db.prepare('SELECT operation_id FROM a2a_operation_map WHERE a2a_task_id=?').get(a2aTaskId) as { operation_id: string }).operation_id).toBe(decided.continuation!.id);
    expect(peer.finals()).toEqual([expect.objectContaining({ state: 'TASK_STATE_COMPLETED' })]);
    expect(await writes(peer.side)).toBe(0);
  });

  it('a peer task held unsupported reports failed with an unknown outcome, once', async () => {
    const peer = await surface({ recoveryEnabled: false });
    const first = await peer.open(afterReceipt);
    const a2aTaskId = await peer.send(first.runtime, first.surface);
    await first.crashed;
    await sleep(50);
    const second = await peer.open();
    await until(async () => { await second.surface.recovery.idle(); return peer.a2aState(second.runtime, a2aTaskId).status === 'TASK_STATE_FAILED'; });
    await second.surface.pushSender.drain();
    expect(peer.finals()).toEqual([expect.objectContaining({ state: 'TASK_STATE_FAILED', metadata: expect.objectContaining({ ardentRecovery: expect.objectContaining({ status: 'unsupported' }) }) })]);
    const third = await peer.open();
    await third.surface.recovery.idle();
    await third.surface.pushSender.drain();
    expect(peer.finals()).toHaveLength(1);
  });
});
