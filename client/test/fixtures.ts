import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { parseExecutionRef } from '@hivemagnus/hive-common/execution';
import { loadConfig, type LoadedConfig } from '../../src/config.js';
import { ArdentRuntime } from '../../src/runtime.js';
import { createArdentApi } from '../../src/api.js';
import { defineTool } from '../../src/tools.js';
import { initTestProfile } from '../../test/helpers.js';

export const TOKEN = 'fixture-token';
type Turn = { text: string } | { calls: Array<{ id: string; name: string; args: unknown }> };
type Body = { messages: Array<{ role: string; content: string | null }> };

const cleanups: Array<() => Promise<void> | void> = [];
export async function cleanup(): Promise<void> {
  for (const step of cleanups.splice(0).reverse()) { try { await step(); } catch { /* best effort */ } }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return `http://127.0.0.1:${address.port}`;
}

async function body(request: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return text;
}

/** A llama.cpp fixture whose reply is computed from the conversation, after `delayMs`. */
export async function llama(script: (body: Body) => Turn, delayMs = 0): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    void body(req).then(async text => {
      const turn = script(JSON.parse(text) as Body);
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      res.setHeader('Content-Type', 'text/event-stream');
      if ('text' in turn) for (const word of turn.text.split(/(?<= )/)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
      else turn.calls.forEach((call, index) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] })}\n\n`));
      res.end('data: [DONE]\n\n');
    });
  });
  return `${await listen(server)}/`;
}

async function profile(modelUrl: string): Promise<{ dir: string; loaded: LoadedConfig }> {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-client-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await initTestProfile(dir);
  const loaded = await loadConfig(dir);
  loaded.config.providers.llamacpp.base_url = modelUrl;
  loaded.config.providers.llamacpp.model = 'fixture';
  loaded.config.research.enabled = false;
  loaded.config.execution.max_parallel_tasks = 1;
  return { dir, loaded };
}

/** Serve a runtime's management API on loopback. */
export async function serveApi(runtime: ArdentRuntime, loaded: LoadedConfig): Promise<string> {
  const app = createArdentApi(runtime, loaded, { ARDENT_API_TOKEN: TOKEN });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  cleanups.push(() => new Promise<void>(resolve => { (server as Server).closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No API address');
  return `http://127.0.0.1:${address.port}`;
}

/**
 * A standalone Ardent whose model first calls `fixture_report`, which registers a
 * `size`-byte artifact for the task, and then answers. Each model reply waits `delayMs`, so a
 * follower sees the task run.
 */
export async function ardent(options: { size?: number; delayMs?: number } = {}) {
  // A PDF-shaped body: Ardent registers only supported media types.
  const size = Math.max(options.size ?? 3 * 1024 * 1024, 32);
  const head = Buffer.from('%PDF-1.7\n');
  const tail = Buffer.from('\n%%EOF\n');
  const content = Buffer.concat([head, randomBytes(size - head.length - tail.length), tail]);
  const modelUrl = await llama(request => request.messages.at(-1)?.role === 'user'
    ? { calls: [{ id: 'call-report', name: 'fixture_report', args: {} }] } : { text: 'The report is ready.' }, options.delayMs ?? 300);
  const { dir, loaded } = await profile(modelUrl);
  loaded.config.artifacts.max_bytes = 64 * 1024 * 1024;
  const runtime = new ArdentRuntime(dir, loaded.config, {});
  cleanups.push(() => runtime.close());
  runtime.tools.register(defineTool({ name: 'fixture_report', description: 'Write the fixture report', input: z.object({}).passthrough(),
    output: z.object({ sha256: z.string() }), effect: 'artifact-write', contexts: ['direct'], timeoutMs: 10_000,
    handler: async (_input, _signal, ctx) => {
      const taskId = parseExecutionRef(ctx?.execution?.self)?.id;
      if (!taskId) throw new Error('No task in the execution context');
      const record = await runtime.artifactManifests.registerStream({ taskId, name: 'report.pdf', mime: 'application/pdf', stream: Readable.from([content]), source: 'fixture' });
      return { sha256: record.manifest.sha256 };
    } }));
  return { runtime, loaded, dir, content, url: await serveApi(runtime, loaded) };
}

/** Crash the runtime at the first boundary after a journal event matches (see test/recovery.test.ts). */
function crashAfter(runtime: ArdentRuntime, match: (kind: string, detail: Record<string, unknown>) => boolean): Promise<void> {
  let armed = false;
  let crashed!: () => void;
  const done = new Promise<void>(resolve => { crashed = resolve; });
  const append = runtime.store.append.bind(runtime.store);
  runtime.store.append = (id, kind, detail) => { append(id, kind, detail); if (match(kind, (detail ?? {}) as Record<string, unknown>)) armed = true; };
  const admission = runtime.store.taskAdmission.bind(runtime.store);
  runtime.store.taskAdmission = id => {
    if (armed && runtime.store.db.open) { runtime.store.db.close(); crashed(); }
    if (!runtime.store.db.open) throw new Error('simulated crash');
    return admission(id);
  };
  return done;
}

/** A profile with one task held `unknown` (awaiting a decision) after a crash during an external write, served by the restarted runtime. */
export async function heldTask() {
  const modelUrl = await llama(request => request.messages.at(-1)?.role === 'user'
    ? { calls: [{ id: 'call-w1', name: 'fixture_write', args: { text: 'hello' } }] } : { text: 'Done.' });
  const { dir, loaded } = await profile(modelUrl);
  const side = join(dir, 'fixture-writes.log');
  const writeTool = () => defineTool({ name: 'fixture_write', description: 'Write one fixture record', input: z.object({ text: z.string() }).strict(),
    output: z.object({ written: z.literal(true), key: z.string() }).strict(), effect: 'external-write', contexts: ['direct'], timeoutMs: 10_000,
    handler: async (_input, _signal, ctx) => { await appendFile(side, `${ctx?.idempotencyKey ?? 'none'}\n`); return { written: true as const, key: ctx?.idempotencyKey ?? 'none' }; } });
  const first = new ArdentRuntime(dir, loaded.config, {});
  first.tools.register(writeTool());
  const task = first.accept('Write the record', 'management', 'direct');
  const crashed = crashAfter(first, (kind, detail) => kind === 'tool_attempt' && detail['name'] === 'fixture_write');
  void first.run(task.id, {}).catch(() => undefined);
  await crashed;
  await new Promise(resolve => setTimeout(resolve, 30));
  const runtime = new ArdentRuntime(dir, loaded.config, {});
  cleanups.push(() => runtime.close());
  runtime.tools.register(writeTool());
  await runtime.resumeRecovered({});
  const done = runtime.accept('Say hello', 'management', 'direct');
  await runtime.run(done.id, {}).catch(() => undefined);
  return { runtime, taskId: task.id, completedId: done.id, url: await serveApi(runtime, loaded) };
}

export interface ProxyLog { url: string; range: string | undefined; ifRange: string | undefined; lastEventId: string | undefined }

/**
 * A loopback proxy that drops the first `streamDrops` task streams right after their first
 * journaled event, cuts the first `contentResets` artifact bodies after `resetAfter` bytes,
 * and can flip one byte of artifact content.
 */
export async function faultyProxy(upstream: string, faults: { streamDrops?: number; contentResets?: number; resetAfter?: number; corrupt?: boolean } = {}) {
  const log: ProxyLog[] = [];
  let streamDrops = faults.streamDrops ?? 0;
  let contentResets = faults.contentResets ?? 0;
  const target = new URL(upstream);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    log.push({ url, range: req.headers.range, ifRange: req.headers['if-range'] as string | undefined, lastEventId: req.headers['last-event-id'] as string | undefined });
    const stream = /\/tasks\/[^/]+\/stream/.test(url);
    const content = /\/content(?:\?|$)/.test(url);
    const drop = stream && streamDrops > 0 ? (streamDrops--, true) : false;
    const reset = content && contentResets > 0 ? (contentResets--, true) : false;
    const forward = httpRequest({ host: target.hostname, port: target.port, path: url, method: req.method, headers: { ...req.headers, host: target.host } }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      let buffered = '';
      let sent = 0;
      upstreamRes.on('data', (chunk: Buffer) => {
        if (drop) {
          buffered += chunk.toString('utf8');
          let boundary: number;
          while ((boundary = buffered.indexOf('\n\n')) >= 0) {
            const block = buffered.slice(0, boundary + 2);
            buffered = buffered.slice(boundary + 2);
            if (block.includes('event: task.done')) { forward.destroy(); res.destroy(); return; }
            // Cut the connection once the event reached the client.
            if (block.includes('event: task.event')) { upstreamRes.removeAllListeners('data'); forward.destroy(); res.write(block, () => res.destroy()); return; }
            res.write(block);
          }
          return;
        }
        let out = chunk;
        if (faults.corrupt && content && sent === 0 && out.length) { out = Buffer.from(out); out[0] = out[0]! ^ 0xff; }
        if (reset && sent + out.length >= (faults.resetAfter ?? 1024 * 1024)) {
          upstreamRes.removeAllListeners('data');
          forward.destroy();
          res.write(out.subarray(0, (faults.resetAfter ?? 1024 * 1024) - sent), () => res.destroy());
          return;
        }
        sent += out.length;
        res.write(out);
      });
      upstreamRes.on('end', () => res.end());
      upstreamRes.on('error', () => undefined);
    });
    forward.on('error', () => res.destroy());
    res.on('close', () => { if (!res.writableFinished) forward.destroy(); });
    req.pipe(forward);
  });
  return { url: await listen(server), log };
}

type Capabilities = Record<string, number>;
const CURRENT_READ = /^(?:openapi|status|profile|config|config\/schema|providers|channels|peers|peers\/config|memory\/status|skills|sessions|tasks|tasks\/[0-9a-f-]{36}(?:\/events|\/artifacts)?|artifacts\/[a-f0-9]{64}\/manifest|development|sessions\/[0-9a-f-]{36}\/messages|identity\/(?:soul|identity)(?:\/history)?)$/;
const NEXT_READ = /^(?:tasks\/[0-9a-f-]{36}\/(?:recovery|lineage)|artifacts\/[a-f0-9]{64}\/(?:renditions|manifest\/v2)|artifacts\/imports(?:\/[0-9a-f-]{36})?)$/;
const CURRENT_ACTIONS = new Set(['session-open', 'task-submit', 'task-cancel', 'task-pause', 'task-resume']);

/**
 * A small Magnus Control API: its read allowlist, stream relay and action shapes as of
 * Magnus 3.2 (`release: 'current'`), or with the routes, actions and top-level `execution`
 * that Magnus 3.3.0 adds (`release: 'next'`). Answers in Magnus's `{ success, data }` envelope.
 */
export async function fakeMagnus(ardentUrl: string, options: { release: 'current' | 'next'; nodeId?: string; profile?: string; capabilities?: Capabilities;
  oldProfile?: boolean; readableReport?: boolean }) {
  const nodeId = options.nodeId ?? 'node-1';
  const profile = options.profile ?? 'assistant';
  const next = options.release === 'next';
  const capabilities = options.capabilities ?? (next ? { studio: 4, recovery: 1, lineage: 1, artifact_transfer: 2 } : { studio: 3 });
  const actions: Array<Record<string, unknown>> = [];
  const fail = (res: ServerResponse, status: number, code: string, message: string, extra: Record<string, unknown> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ success: false, error: { code, message, ...extra } }));
  };
  const ok = (res: ServerResponse, data: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, data })); };
  const ardentFetch = (path: string, init: RequestInit = {}) => fetch(`${ardentUrl}/api/v1/${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...init.headers } });
  const relay = async (res: ServerResponse, upstream: Response) => {
    const headers: Record<string, string> = {};
    upstream.headers.forEach((value, key) => { if (!['content-encoding', 'transfer-encoding', 'connection'].includes(key)) headers[key] = value; });
    res.writeHead(upstream.status, headers);
    if (!upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();
    res.on('close', () => { void reader.cancel().catch(() => undefined); });
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      res.write(value);
    }
    res.end();
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://magnus.invalid');
      if (req.headers.authorization !== 'Bearer magnus-fixture-token') return fail(res, 401, 'UNAUTHORIZED', 'Authentication required');
      const base = `/api/v1/ardent/installations/${nodeId}`;
      if (url.pathname === base) {
        if (options.readableReport === false) return fail(res, 403, 'FORBIDDEN', 'Requires one of: ADMIN');
        return ok(res, { nodeId, installed: true, version: '3.2.0', capabilities, profiles: [{ id: profile, name: 'Assistant', running: true }] });
      }
      const prefix = `${base}/profiles/${profile}/`;
      if (!url.pathname.startsWith(prefix)) return fail(res, 404, 'NOT_FOUND', 'Managed node not found');
      const resource = url.pathname.slice(prefix.length);
      if (req.method === 'POST' && resource === 'action') {
        const input = JSON.parse(await body(req)) as Record<string, unknown>;
        actions.push(input);
        const allowed = new Set([...CURRENT_ACTIONS, ...(next ? ['task-recovery', 'artifact-import'] : [])]);
        const keys = Object.keys(input).filter(key => !['action', 'target', 'body', ...(next ? ['execution'] : [])].includes(key));
        if (typeof input['action'] !== 'string' || !allowed.has(input['action']) || keys.length) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid Ardent action');
        const target = typeof input['target'] === 'string' ? input['target'] : '';
        const action = input['action'];
        const payload = (input['body'] ?? {}) as Record<string, unknown>;
        if (action === 'task-submit' && (typeof payload['idempotency_key'] !== 'string' || !/^[0-9a-f-]{36}$/.test(payload['idempotency_key'])))
          return fail(res, 400, 'VALIDATION_ERROR', 'Invalid Ardent action body');
        if (options.oldProfile && (action === 'task-recovery' || action === 'artifact-import'))
          return fail(res, 409, 'unsupported_capability', 'The profile runs Ardent 3.1.4', { capability: 'ardent.recovery.v1', required_version: '3.2.0', installed_version: '3.1.4' });
        const route: Record<string, string> = { 'task-submit': 'tasks', 'task-cancel': `tasks/${target}/cancel`, 'task-pause': `tasks/${target}/pause`,
          'task-resume': `tasks/${target}/resume`, 'session-open': 'sessions', 'task-recovery': `tasks/${target}/recovery`, 'artifact-import': 'artifacts/imports' };
        const sent = action === 'task-submit' && input['execution'] ? { ...payload, execution: input['execution'] } : payload;
        const upstream = await ardentFetch(route[action]!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sent) });
        const answer = await upstream.json() as Record<string, unknown>;
        if (!upstream.ok) return fail(res, upstream.status >= 500 ? 503 : upstream.status, upstream.status === 404 ? 'NOT_FOUND' : upstream.status === 409 ? 'CONFLICT' : 'VALIDATION_ERROR', 'Ardent refused the request');
        return ok(res, answer);
      }
      if (req.method !== 'GET') return fail(res, 404, 'NOT_FOUND', 'Not found');
      if (/^tasks\/[0-9a-f-]{36}\/stream$/.test(resource)) {
        const after = url.searchParams.get('after');
        const lastEventId = req.headers['last-event-id'];
        const query = after ? `?after=${after}` : '';
        return relay(res, await ardentFetch(`${resource}${query}`, { headers: typeof lastEventId === 'string' ? { 'last-event-id': lastEventId } : {} }));
      }
      if (next && /^artifacts\/[a-f0-9]{64}\/content$/.test(resource)) {
        const headers: Record<string, string> = {};
        for (const name of ['range', 'if-range']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
        return relay(res, await ardentFetch(resource, { headers }));
      }
      if (!CURRENT_READ.test(resource) && !(next && NEXT_READ.test(resource))) return fail(res, 404, 'NOT_FOUND', 'Ardent resource unavailable');
      if (options.oldProfile && NEXT_READ.test(resource))
        return fail(res, 409, 'unsupported_capability', 'The profile runs Ardent 3.1.4', { capability: 'ardent.recovery.v1', required_version: '3.2.0', installed_version: '3.1.4' });
      const query = new URLSearchParams();
      for (const key of ['after', 'limit', 'kind', 'context']) { const value = url.searchParams.get(key); if (value !== null) query.set(key, value); }
      const upstream = await ardentFetch(`${resource}${query.size ? `?${query}` : ''}`);
      if (!upstream.ok) return fail(res, upstream.status === 404 ? 404 : 503, upstream.status === 404 ? 'NOT_FOUND' : 'DEPENDENCY_UNAVAILABLE', upstream.status === 404 ? 'Ardent resource not found' : 'Ardent node unavailable');
      return ok(res, await upstream.json());
    })().catch(error => { if (!res.headersSent) fail(res, 500, 'INTERNAL_ERROR', String(error)); else res.destroy(); });
  });
  return { url: await listen(server), nodeId, profile, actions };
}
