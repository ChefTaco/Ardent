import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskState, type StreamResponse, type TaskPushNotificationConfig } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { TaskStore } from '../src/store.js';
import { DeliveryVetoError, SafeA2APushSender, SqliteA2APushStore } from '../src/a2a-push.js';
import type { PeerConfig } from '../src/a2a-peers.js';
import { loadConfig } from '../src/config.js';
import { initTestProfile } from './helpers.js';
import { ArdentRuntime } from '../src/runtime.js';
import { createA2ASurface } from '../src/a2a-server.js';
import { ArdentA2AClient } from '../src/a2a-client.js';


const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('A2A push notifications', () => {
  it('does not send a vetoed result during a delayed callback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ardent-push-price-'));
    dirs.push(dir);
    const tasks = new TaskStore(join(dir, 'state', 'ardent.sqlite'));
    try {
      const peer: PeerConfig = { id: 'coordinator', url: 'http://127.0.0.1:19999', token_env: 'COORDINATOR_TOKEN', enabled: true, transport_ports: [], callback_ports: [], allow_private_callbacks: true };
      const store = new SqliteA2APushStore(tasks.db, [peer]);
      const caller = new ServerCallContext({ tenant: '', user: { isAuthenticated: true, userName: 'coordinator' }, requestedVersion: '1.0' });
      await store.save('price-task', caller, { tenant: '', taskId: 'price-task', id: '', url: 'http://127.0.0.1:19999/push', token: 'fixture-secret', authentication: undefined });
      const sender = new SafeA2APushSender(store, () => { throw new DeliveryVetoError('Result expired before callback delivery'); });
      await sender.send({ payload: { $case: 'statusUpdate', value: { taskId: 'price-task', contextId: 'price-context', status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString(), message: undefined }, metadata: undefined } } }, caller);
      const state = tasks.db.prepare('SELECT state,error FROM a2a_push_deliveries').get() as { state: string; error: string };
      expect(state.state).toBe('failed');
      expect(state.error).toContain('Result expired before callback delivery');
    } finally { tasks.close(); }
  });
  it('persists owner-scoped config, validates destinations, retries a definite 429, and journals delivery', async () => {
    let calls = 0;
    const server = createServer((request, response) => {
      calls++;
      expect(request.headers['x-a2a-notification-token']).toBe('callback-secret');
      if (calls === 1) response.writeHead(429, { 'Retry-After': '1' }).end();
      else response.writeHead(200).end();
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No callback port');
    const base = `http://127.0.0.1:${address.port}`;
    const dir = await mkdtemp(join(tmpdir(), 'ardent-push-'));
    dirs.push(dir);
    const tasks = new TaskStore(join(dir, 'state', 'ardent.sqlite'));
    try {
      const peer: PeerConfig = { id: 'coordinator', url: base, token_env: 'COORDINATOR_TOKEN', enabled: true, transport_ports: [], callback_ports: [], allow_private_callbacks: true };
      const store = new SqliteA2APushStore(tasks.db, [peer]);
      const caller = new ServerCallContext({ tenant: 'team', user: { isAuthenticated: true, userName: 'coordinator' }, requestedVersion: '1.0' });
      const other = new ServerCallContext({ tenant: 'team', user: { isAuthenticated: true, userName: 'peerb' }, requestedVersion: '1.0' });
      const config: TaskPushNotificationConfig = { tenant: 'team', id: '', taskId: 'task-1', url: `${base}/callback`, token: 'callback-secret', authentication: undefined };
      await store.save('task-1', caller, config);
      expect(config.id).toBeTruthy();
      expect(await store.load('task-1', caller)).toHaveLength(1);
      expect(await store.load('task-1', other)).toHaveLength(0);
      await expect(store.save('task-1', caller, { ...config, id: '', url: 'http://127.0.0.1:9/metadata' })).rejects.toThrow('outside');
      const event: StreamResponse = { payload: { $case: 'statusUpdate', value: { taskId: 'task-1', contextId: 'context-1', status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString(), message: undefined }, metadata: undefined } } };
      const sender = new SafeA2APushSender(store);
      await sender.send(event, caller);
      expect(calls).toBe(2);
      await sender.send(event, caller);
      expect(calls).toBe(2);
      const state = tasks.db.prepare('SELECT state,http_status FROM a2a_push_deliveries').get() as { state: string; http_status: number };
      expect(state).toEqual({ state: 'sent', http_status: 200 });
      await store.delete('task-1', caller, config.id);
      expect(await store.load('task-1', caller)).toHaveLength(0);
    } finally { tasks.close(); }
  });
  it('delivers callbacks from a canonical HTTP+JSON message request', async () => {
    const notifications: unknown[] = [];
    const callback = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => { notifications.push(JSON.parse(body) as unknown); response.writeHead(200).end(); });
    });
    servers.push(callback);
    await new Promise<void>(resolve => callback.listen(0, '127.0.0.1', resolve));
    const callbackAddress = callback.address();
    if (!callbackAddress || typeof callbackAddress === 'string') throw new Error('No callback port');
    const callbackBase = `http://127.0.0.1:${callbackAddress.port}`;
    const model = createServer((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', 'text/event-stream');
      response.end('data: {"choices":[{"delta":{"content":"PUSH_OK"}}]}\n\ndata: [DONE]\n\n');
    });
    servers.push(model);
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
    const modelAddress = model.address();
    if (!modelAddress || typeof modelAddress === 'string') throw new Error('No model port');
    const dir = await mkdtemp(join(tmpdir(), 'ardent-push-http-'));
    dirs.push(dir);
    await initTestProfile(dir);
    await writeFile(join(dir, 'peers.yaml'), `schema_version: 1\npeers:\n  - id: coordinator\n    url: ${callbackBase}\n    token_env: COORDINATOR_TOKEN\n    allow_private_callbacks: true\n`);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = `http://127.0.0.1:${modelAddress.port}/`;
    config.providers.llamacpp.model = 'fixture';
    config.a2a.public_url = 'http://127.0.0.1:9900';
    const runtime = new ArdentRuntime(dir, config);
    let surface: Awaited<ReturnType<typeof createA2ASurface>> | undefined;
    const savedConfigs = vi.spyOn(SqliteA2APushStore.prototype, 'save');
    try {
      surface = await createA2ASurface(runtime, config, { COORDINATOR_TOKEN: 'fixture-token-1234567890' });
      const server = surface.app.listen(0, '127.0.0.1');
      servers.push(server);
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No A2A port');
      const response = await fetch(`http://127.0.0.1:${address.port}/a2a/rest/message:send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' },
        body: JSON.stringify({ message: { role: 'ROLE_USER', messageId: 'push-task-1', parts: [{ text: 'Return PUSH_OK' }] }, configuration: { taskPushNotificationConfig: { url: `${callbackBase}/callback`, token: 'callback-secret' } } }),
      });
      const body = await response.json() as { task?: { id?: string; status?: { state?: string } }; error?: unknown };
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.task?.status?.state).toBe('TASK_STATE_COMPLETED');
      expect(notifications.length).toBeGreaterThan(0);
      const delivered = runtime.store.db.prepare("SELECT COUNT(*) AS count FROM a2a_push_deliveries WHERE state='sent'").get() as { count: number };
      expect(delivered.count).toBeGreaterThan(0);
      const taskId = body.task?.id;
      if (!taskId) throw new Error('A2A task ID missing');
      const root = `http://127.0.0.1:${address.port}/a2a/rest/tasks/${taskId}/pushNotificationConfigs`;
      const headers = { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture-token-1234567890' };
      const created = await fetch(root, { method: 'POST', headers, body: JSON.stringify({ url: `${callbackBase}/callback`, token: 'second-secret' }) });
      const createdBody = await created.json() as { id?: string };
      expect(savedConfigs.mock.calls.at(-1)?.[2].url).toBe(`${callbackBase}/callback`);
      expect(created.status, JSON.stringify(createdBody)).toBe(201);
      const deniedCallback = await fetch(root, { method: 'POST', headers, body: JSON.stringify({ url: 'http://127.0.0.1:9/private', token: 'bad' }) });
      expect(deniedCallback.status).toBe(400);
      const configId = createdBody.id;
      if (!configId) throw new Error('Created callback ID missing');
      const listed = await fetch(root, { headers });
      expect(listed.status).toBe(200);
      expect((await listed.json() as { configs?: unknown[] }).configs?.length).toBe(2);
      const found = await fetch(`${root}/${configId}`, { headers });
      expect(found.status).toBe(200);
      const deleted = await fetch(`${root}/${configId}`, { method: 'DELETE', headers });
      expect(deleted.status).toBe(204);
      expect((await (await fetch(root, { headers })).json() as { configs?: unknown[] }).configs?.length).toBe(1);
      const inbound = surface.pushInbox.register('coordinator', 'outbound-1');
      const pushUrl = `http://127.0.0.1:${address.port}/a2a/push/coordinator`;
      const pushEvent = { statusUpdate: { taskId: 'remote-task-1', contextId: 'remote-context-1', status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() } } };
      const pushHeaders = { 'Content-Type': 'application/a2a+json', 'X-A2A-Notification-Token': inbound.token };
      expect((await fetch(pushUrl, { method: 'POST', headers: { ...pushHeaders, 'X-A2A-Notification-Token': 'wrong' }, body: JSON.stringify(pushEvent) })).status).toBe(401);
      const firstPush = await fetch(pushUrl, { method: 'POST', headers: pushHeaders, body: JSON.stringify(pushEvent) });
      const firstPushBody = await firstPush.json() as { duplicate?: boolean; error?: string };
      expect(firstPush.status, firstPushBody.error).toBe(202);
      expect(firstPushBody.duplicate).toBe(false);
      const secondPush = await fetch(pushUrl, { method: 'POST', headers: pushHeaders, body: JSON.stringify(pushEvent) });
      expect((await secondPush.json() as { duplicate: boolean }).duplicate).toBe(true);
      expect(surface.pushInbox.events(inbound.id)).toHaveLength(1);
      expect(() => surface.pushInbox.bind(inbound.id, 'other-task')).toThrow('mismatch');
      surface.pushInbox.bind(inbound.id, 'remote-task-1');
    } finally { savedConfigs.mockRestore(); await surface?.pushSender.drain(); runtime.close(); }
  });
  it('receives authenticated callbacks for an outbound client call and binds them to the returned task', async () => {
    const model = createServer((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', 'text/event-stream');
      response.end('data: {"choices":[{"delta":{"content":"ROUNDTRIP_OK"}}]}\n\ndata: [DONE]\n\n');
    });
    servers.push(model);
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
    const modelAddress = model.address();
    if (!modelAddress || typeof modelAddress === 'string') throw new Error('No model port');
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const reserved = reservation.address();
    if (!reserved || typeof reserved === 'string') throw new Error('No A2A port');
    const port = reserved.port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const dir = await mkdtemp(join(tmpdir(), 'ardent-push-roundtrip-'));
    dirs.push(dir);
    await initTestProfile(dir);
    await writeFile(join(dir, 'peers.yaml'), `schema_version: 1\npeers:\n  - id: coordinator\n    url: http://127.0.0.1:${port}\n    token_env: COORDINATOR_TOKEN\n    transport_ports: [${port + 1}]\n    allow_private_callbacks: true\n`);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = `http://127.0.0.1:${modelAddress.port}/`;
    config.providers.llamacpp.model = 'fixture';
    config.a2a.public_url = `http://127.0.0.1:${port}`;
    const env = { COORDINATOR_TOKEN: 'fixture-token-1234567890' };
    const runtime = new ArdentRuntime(dir, config, env);
    let surface: Awaited<ReturnType<typeof createA2ASurface>> | undefined;
    try {
      surface = await createA2ASurface(runtime, config, env);
      const server = surface.app.listen(port, '127.0.0.1');
      servers.push(server);
      await new Promise<void>(resolve => server.once('listening', resolve));
      const client = new ArdentA2AClient(dir, config, env, surface.pushInbox);
      const sent = await client.sendWithReceipt('coordinator', 'Return ROUNDTRIP_OK');
      expect('id' in sent.result && sent.result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      await surface.pushSender.drain();
      expect(sent.outboundId).toBeTruthy();
      expect(surface.pushInbox.events(sent.outboundId ?? '')).not.toHaveLength(0);
    } finally { await surface?.pushSender.drain(); runtime.close(); }
  });
});
