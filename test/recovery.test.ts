import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig, type LoadedConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { createArdentApi } from '../src/api.js';
import { definePlugin, type ArdentPlugin } from '../src/plugins.js';
import { defineTool, type Tool, type ToolEffect } from '../src/tools.js';
import { toolIdempotencyKey } from '../src/tool-scheduler.js';
import { CODEX_PROTOCOL_LOCK } from '../src/codex-protocol.js';
import Database from '../src/sqlite.js';
import { initTestProfile } from './helpers.js';

type Message = { role: string; content: string | null; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
type Body = { messages: Message[]; tools?: Array<{ function: { name: string } }> };
type Turn = { text: string } | { calls: Array<{ id: string; name: string; args: unknown }> };

const dirs: string[] = [];
const servers: Server[] = [];
const open: ArdentRuntime[] = [];
afterEach(async () => {
  for (const runtime of open.splice(0)) { try { if (runtime.store.db.open) runtime.close(); } catch { /* a crashed runtime is abandoned */ } }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function body(request: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return text;
}
/** A llama.cpp fixture whose reply is computed from the conversation it is sent. */
async function llama(script: (body: Body, index: number) => Turn | Promise<Turn>): Promise<{ url: string; requests: Body[] }> {
  const requests: Body[] = [];
  const server = createServer((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    void body(request).then(async text => {
      const parsed = JSON.parse(text) as Body;
      requests.push(parsed);
      const turn = await script(parsed, requests.length - 1);
      response.setHeader('Content-Type', 'text/event-stream');
      if ('text' in turn) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: turn.text } }] })}\n\n`);
      else turn.calls.forEach((call, index) => response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] })}\n\n`));
      response.end('data: [DONE]\n\n');
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return { url: `http://127.0.0.1:${address.port}/`, requests };
}
/**
 * The standard script: write once, then answer. A "not applied" result makes
 * the model ask for the write again once, under a new call id.
 */
function writeScript(calls: Array<{ id: string; name: string; args: unknown }> = [{ id: 'call-w1', name: 'fixture_write', args: { text: 'hello' } }]) {
  return (request: Body): Turn => {
    const last = request.messages.at(-1);
    const asked = (id: string) => request.messages.some(message => message.tool_calls?.some(call => call.id === id));
    if (last?.role === 'user') return { calls };
    if (last?.role === 'tool' && last.content?.includes('NOT_APPLIED') && !asked('call-w2')) return { calls: [{ id: 'call-w2', name: 'fixture_write', args: { text: 'hello' } }] };
    return { text: 'Done.' };
  };
}

async function profile(modelUrl: string, edit?: (loaded: LoadedConfig) => void): Promise<{ dir: string; loaded: LoadedConfig; side: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-recovery-'));
  dirs.push(dir);
  await initTestProfile(dir);
  const loaded = await loadConfig(dir);
  loaded.config.providers.llamacpp.base_url = modelUrl;
  loaded.config.providers.llamacpp.model = 'fixture';
  loaded.config.research.enabled = false;
  loaded.config.execution.max_parallel_tasks = 1;
  edit?.(loaded);
  return { dir, loaded, side: join(dir, 'fixture-writes.log') };
}
async function writes(side: string): Promise<string[]> {
  try { return (await readFile(side, 'utf8')).split('\n').filter(Boolean); } catch { return []; }
}

type WriteOptions = { reconcile?: 'service' | 'unknown'; idempotent?: boolean; name?: string; effect?: ToolEffect; afterWrite?: () => void | Promise<void>; beforeWrite?: () => Promise<void> };
/** `fixture_write` counts every real invocation in a side file, by idempotency key. Its optional reconcile asks that "service". */
function writeTool(side: string, options: WriteOptions = {}): Tool {
  return defineTool({ name: options.name ?? 'fixture_write', description: 'Write one fixture record', input: z.object({ text: z.string() }).strict(),
    output: z.object({ written: z.literal(true), key: z.string() }).strict(), effect: options.effect ?? 'external-write', contexts: ['direct', 'peer'], timeoutMs: 10_000,
    ...(options.idempotent ? { idempotent: true } : {}),
    ...(options.reconcile ? { reconcile: async (_input: { text: string }, ctx) => options.reconcile === 'unknown' ? { status: 'unknown' as const }
      : (await writes(side)).includes(ctx.idempotencyKey) ? { status: 'applied' as const, value: { written: true, key: ctx.idempotencyKey } } : { status: 'not_applied' as const } } : {}),
    handler: async (_input, _signal, ctx) => {
      await options.beforeWrite?.();
      await appendFile(side, `${ctx?.idempotencyKey ?? 'none'}\n`);
      await options.afterWrite?.();
      return { written: true as const, key: ctx?.idempotencyKey ?? 'none' };
    } });
}
const readTool = (name = 'fixture_read', wait?: () => Promise<void>): Tool => defineTool({ name, description: 'Read a fixture value', input: z.object({}).passthrough(),
  output: z.object({ value: z.string() }), effect: 'read', contexts: ['direct', 'peer'], timeoutMs: 10_000,
  handler: async () => { await wait?.(); return { value: 'fixture' }; } });

/** The runtime "crashes": its database closes and it can write nothing more. */
function crash(runtime: ArdentRuntime): void { runtime.store.db.close(); }
/**
 * Crash at the first step boundary (pause check) after a journal event
 * matches: before the next tool attempt, before invocation (after an
 * attempt), or before the next model call.
 */
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
function start(dir: string, loaded: LoadedConfig, env: NodeJS.ProcessEnv = {}): ArdentRuntime {
  const runtime = new ArdentRuntime(dir, loaded.config, env);
  open.push(runtime);
  return runtime;
}
async function settle(runtime: ArdentRuntime, id: string): Promise<string> {
  await runtime.run(id, {}).catch(() => undefined);
  return runtime.store.get(id)?.state ?? 'missing';
}
function kinds(runtime: ArdentRuntime, id: string): string[] { return runtime.store.events(id, 0, 500).map(event => event.kind); }
function api(runtime: ArdentRuntime, loaded: LoadedConfig) {
  const app = createArdentApi(runtime, loaded, { ARDENT_API_TOKEN: 'fixture-token' });
  const headers = { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' };
  return {
    get: async (path: string) => { const response = await app.request(path, { headers }); return { status: response.status, body: await response.json() as Record<string, unknown> }; },
    post: async (path: string, value: unknown) => { const response = await app.request(path, { method: 'POST', headers, body: JSON.stringify(value) }); return { status: response.status, body: await response.json() as Record<string, unknown> }; }
  };
}
type Recovery = { status: string; reason: { code: string }; attempt: number; actions: string[]; continuation_task_id?: string; checkpoint?: { pending_calls: Array<{ call_id: string; reconcilable: boolean }> }; decided?: { action: string } };

type Interrupt = { write?: WriteOptions | ((first: ArdentRuntime) => WriteOptions); script?: (body: Body) => Turn; edit?: (loaded: LoadedConfig) => void;
  sessionKey?: string; restartWrite?: WriteOptions; plugins?: ArdentPlugin[]; accept?: (runtime: ArdentRuntime, sessionId?: string) => { id: string } };
/** Run the first attempt until it crashes at the cut point, then start a new runtime on the same profile. */
async function interrupted(cut: (runtime: ArdentRuntime) => Promise<void>, options: Interrupt = {}) {
  const model = await llama(options.script ?? writeScript());
  const { dir, loaded, side } = await profile(model.url, options.edit);
  const first = start(dir, loaded);
  first.tools.register(writeTool(side, typeof options.write === 'function' ? options.write(first) : options.write));
  first.tools.register(readTool());
  if (options.plugins) await first.usePlugins(options.plugins, {});
  const session = options.sessionKey ? first.store.session('management', 'direct', options.sessionKey) : undefined;
  const task = options.accept ? options.accept(first, session?.id) : first.accept('Write the record', 'management', 'direct', undefined, session?.id);
  const crashed = cut(first);
  void first.run(task.id, {}).catch(() => undefined);
  await crashed;
  await sleep(30);
  const restarted = start(dir, loaded);
  restarted.tools.register(writeTool(side, options.restartWrite ?? (typeof options.write === 'function' ? {} : options.write)));
  restarted.tools.register(readTool());
  if (options.plugins) await restarted.usePlugins(options.plugins, {});
  return { model, dir, loaded, side, task, restarted, first, session };
}
/** Crash inside the tool, after its real write and before its receipt is persisted. */
function crashAfterWrite(): { write: (first: ArdentRuntime) => WriteOptions; crashed: Promise<void> } {
  let done!: () => void;
  const crashed = new Promise<void>(resolve => { done = resolve; });
  return { crashed, write: first => ({ afterWrite: () => { crash(first); done(); } }) };
}

describe('execution recovery: llama.cpp cut points', () => {
  it('(1) before tool_attempt: resumes under the same id, reuses the settled read and writes once', async () => {
    const run = await interrupted(runtime => crashAfter(runtime, (kind, detail) => kind === 'tool_result' && detail.name === 'fixture_read'),
      { script: writeScript([{ id: 'call-r1', name: 'fixture_read', args: {} }, { id: 'call-w1', name: 'fixture_write', args: { text: 'hello' } }]) });
    expect(run.restarted.store.get(run.task.id)?.state).toBe('running');
    expect(run.restarted.recoveryFor(run.task.id)).toMatchObject({ status: 'ready', reason: { code: 'RESUME_FROM_CHECKPOINT' }, attempt: 1 });
    expect(await writes(run.side)).toHaveLength(0);
    expect(await run.restarted.resumeRecovered({})).toEqual([run.task.id]);
    expect(await settle(run.restarted, run.task.id)).toBe('completed');
    expect(await writes(run.side)).toEqual([toolIdempotencyKey(run.task.id, 'call-w1')]);
    expect(run.restarted.store.get(run.task.id)?.result).toBe('Done.');
    const resumed = run.restarted.store.events(run.task.id, 0, 500).find(event => event.kind === 'execution_resumed');
    expect(resumed?.detail).toMatchObject({ attempt: 2, from_step: 0, reused_calls: 1, redispatched_calls: 0 });
    // The settled read was reused, not run again: one attempt for it in the journal.
    expect(run.restarted.store.events(run.task.id, 0, 500).filter(event => event.kind === 'tool_attempt' && (event.detail as { name: string }).name === 'fixture_read')).toHaveLength(1);
    expect(run.restarted.recoveryFor(run.task.id)?.status).toBe('resumed');
    // Only two model calls: the reply that asked for the tools was reused.
    expect(run.model.requests).toHaveLength(2);
  });

  it('(2) after dispatched, before invoke, without reconcile: held awaiting a decision', async () => {
    const run = await interrupted(runtime => crashAfter(runtime, (kind, detail) => kind === 'tool_attempt' && detail.name === 'fixture_write'));
    expect(await writes(run.side)).toHaveLength(0);
    // Until the startup check knows the task's tools, the call is pending a check; it never runs.
    expect(run.restarted.recoveryFor(run.task.id)).toMatchObject({ status: 'reconciling', reason: { code: 'TOOL_CHECK_PENDING' } });
    expect(await run.restarted.resumeRecovered({})).toEqual([]);
    const task = run.restarted.store.get(run.task.id);
    expect(task?.state).toBe('unknown');
    const recovery = run.restarted.recoveryFor(run.task.id) as Recovery | undefined;
    expect(recovery).toMatchObject({ status: 'awaiting_decision', reason: { code: 'UNSETTLED_EXTERNAL_WRITE' }, attempt: 1,
      actions: ['mark_applied', 'mark_not_applied', 'retry_with_new_deadline', 'abandon'] });
    expect(recovery?.checkpoint?.pending_calls).toEqual([expect.objectContaining({ call_id: 'call-w1', reconcilable: false })]);
    expect(await writes(run.side)).toHaveLength(0);
  });

  it('(2) with reconcile: not applied by its service, the model is told and writes once under a new call', async () => {
    const run = await interrupted(runtime => crashAfter(runtime, (kind, detail) => kind === 'tool_attempt' && detail.name === 'fixture_write'), { write: { reconcile: 'service' } });
    expect(run.restarted.recoveryFor(run.task.id)).toMatchObject({ status: 'reconciling', reason: { code: 'TOOL_CHECK_PENDING' } });
    await run.restarted.resumeRecovered({});
    expect(await settle(run.restarted, run.task.id)).toBe('completed');
    expect(await writes(run.side)).toEqual([toolIdempotencyKey(run.task.id, 'call-w2')]);
    const journal = run.restarted.store.events(run.task.id, 0, 500);
    expect(journal.find(event => event.kind === 'tool_reconciled')?.detail).toMatchObject({ id: 'call-w1', status: 'not_applied' });
    expect(run.restarted.store.executionState.invocation(run.task.id, 'call-w1')?.state).toBe('reconciled_not_applied');
  });


  it('(3) after invoke, before the receipt: held without reconcile, never written twice', async () => {
    const after = crashAfterWrite();
    const run = await interrupted(() => after.crashed, { write: after.write });
    expect(await writes(run.side)).toHaveLength(1);
    await run.restarted.resumeRecovered({});
    expect(run.restarted.store.get(run.task.id)?.state).toBe('unknown');
    expect(run.restarted.recoveryFor(run.task.id)).toMatchObject({ status: 'awaiting_decision', reason: { code: 'UNSETTLED_EXTERNAL_WRITE' } });
    expect(await writes(run.side)).toHaveLength(1);
  });

  it('(3) with reconcile applied: resumed with the service result, the count stays 1', async () => {
    const after = crashAfterWrite();
    const run = await interrupted(() => after.crashed, { write: first => ({ ...after.write(first), reconcile: 'service' }), restartWrite: { reconcile: 'service' } });
    await run.restarted.resumeRecovered({});
    expect(await settle(run.restarted, run.task.id)).toBe('completed');
    expect(await writes(run.side)).toEqual([toolIdempotencyKey(run.task.id, 'call-w1')]);
    expect(run.restarted.store.executionState.invocation(run.task.id, 'call-w1')).toMatchObject({ state: 'reconciled_applied', result: { ok: true, value: { written: true } } });
    // The model saw the reconciled result as the call's tool result.
    expect(run.model.requests.at(-1)?.messages.find(message => message.tool_call_id === 'call-w1')?.content).toContain('"written":true');
  });

  it('(3) with reconcile unknown: held awaiting a decision as inconclusive', async () => {
    const after = crashAfterWrite();
    const run = await interrupted(() => after.crashed, { write: first => ({ ...after.write(first), reconcile: 'unknown' }), restartWrite: { reconcile: 'unknown' } });
    await run.restarted.resumeRecovered({});
    expect(await settle(run.restarted, run.task.id)).toBe('unknown');
    expect(run.restarted.recoveryFor(run.task.id)).toMatchObject({ status: 'awaiting_decision', reason: { code: 'RECONCILIATION_INCONCLUSIVE' },
      checkpoint: { pending_calls: [expect.objectContaining({ call_id: 'call-w1', reconcilable: true })] } });
    expect(await writes(run.side)).toHaveLength(1);
  });

  it('(4) after the receipt: resumes under the same id without writing again', async () => {
    const run = await interrupted(runtime => crashAfter(runtime, (kind, detail) => kind === 'tool_result' && detail.name === 'fixture_write'));
    expect(await writes(run.side)).toHaveLength(1);
    expect(run.restarted.recoveryFor(run.task.id)).toMatchObject({ status: 'ready', reason: { code: 'RESUME_FROM_CHECKPOINT' } });
    await run.restarted.resumeRecovered({});
    expect(await settle(run.restarted, run.task.id)).toBe('completed');
    expect(await writes(run.side)).toHaveLength(1);
    expect(run.restarted.store.events(run.task.id, 0, 500).find(event => event.kind === 'execution_resumed')?.detail)
      .toMatchObject({ attempt: 2, from_step: 0, reused_calls: 1, redispatched_calls: 0 });
  });

  it('(5) after a model reply with tool calls, before dispatch: resumes and writes once', async () => {
    const run = await interrupted(runtime => crashAfter(runtime, (kind, detail) => kind === 'model_result' && Array.isArray(detail.calls) && detail.calls.length > 0));
    expect(await writes(run.side)).toHaveLength(0);
    expect(run.restarted.store.executionState.invocations(run.task.id)).toEqual([]);
    expect(run.restarted.recoveryFor(run.task.id)).toMatchObject({ status: 'ready', reason: { code: 'RESUME_FROM_CHECKPOINT' } });
    await run.restarted.resumeRecovered({});
    expect(await settle(run.restarted, run.task.id)).toBe('completed');
    expect(await writes(run.side)).toEqual([toolIdempotencyKey(run.task.id, 'call-w1')]);
    // The extended model_result records the calls with compacted arguments.
    expect(run.restarted.store.events(run.task.id, 0, 500).find(event => event.kind === 'model_result')?.detail)
      .toMatchObject({ tool_calls: ['fixture_write'], calls: [{ id: 'call-w1', name: 'fixture_write', arguments: { text: 'hello' } }] });
    expect(run.model.requests).toHaveLength(2);
  });

  it('(6) deadline passing during downtime: failed when nothing is uncertain, held when a write is', async () => {
    const clean = await interrupted(runtime => crashAfter(runtime, (kind, detail) => kind === 'tool_result' && detail.name === 'fixture_write'));
    clean.restarted.close();
    const db = new Database(join(clean.dir, 'state', 'ardent.sqlite'));
    db.prepare('UPDATE tasks SET deadline_ms=? WHERE id=?').run(Date.now() - 1000, clean.task.id);
    db.close();
    const later = start(clean.dir, clean.loaded);
    expect(later.store.get(clean.task.id)?.state).toBe('failed');
    expect(later.recoveryFor(clean.task.id)).toMatchObject({ status: 'resolved', reason: { code: 'DEADLINE_ELAPSED_DURING_OUTAGE' }, actions: [] });
    expect(await writes(clean.side)).toHaveLength(1);

    const uncertain = await interrupted(runtime => crashAfter(runtime, (kind, detail) => kind === 'tool_attempt' && detail.name === 'fixture_write'));
    uncertain.restarted.close();
    const second = new Database(join(uncertain.dir, 'state', 'ardent.sqlite'));
    second.prepare('UPDATE tasks SET deadline_ms=? WHERE id=?').run(Date.now() - 1000, uncertain.task.id);
    second.close();
    const held = start(uncertain.dir, uncertain.loaded);
    held.tools.register(writeTool(uncertain.side));
    expect(held.store.get(uncertain.task.id)?.state).toBe('unknown');
    // The original deadline is never extended: only a retry with a new deadline, or abandoning, is valid.
    expect(held.recoveryFor(uncertain.task.id)).toMatchObject({ status: 'awaiting_decision', reason: { code: 'DEADLINE_ELAPSED_DURING_OUTAGE' },
      actions: ['retry_with_new_deadline', 'abandon'] });
    const decided = await held.decideRecovery(uncertain.task.id, { action: 'retry_with_new_deadline', deadline_seconds: 60 }, {});
    expect(decided.continuation).toBeDefined();
    expect(await settle(held, decided.continuation!.id)).toBe('completed');
    // The retry dispatched the pending call again under its original idempotency key: one write.
    expect(await writes(uncertain.side)).toEqual([toolIdempotencyKey(uncertain.task.id, 'call-w1')]);
    expect(held.store.get(decided.continuation!.id)?.deadline_ms).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});

describe('execution recovery: operator decisions', () => {
  async function heldAt2(sessionKey?: string) {
    const run = await interrupted(runtime => crashAfter(runtime, (kind, detail) => kind === 'tool_attempt' && detail.name === 'fixture_write'), sessionKey ? { sessionKey } : {});
    await run.restarted.resumeRecovered({});
    expect(run.restarted.store.get(run.task.id)?.state).toBe('unknown');
    return { ...run, http: api(run.restarted, run.loaded) };
  }

  it('GET and POST /api/v1/tasks/{id}/recovery: mark_applied continues without dispatching, idempotently', async () => {
    const run = await heldAt2('decisions');
    const got = await run.http.get(`/api/v1/tasks/${run.task.id}/recovery`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ status: 'awaiting_decision', attempt: 1, reason: { code: 'UNSETTLED_EXTERNAL_WRITE' } });
    expect((await run.http.get(`/api/v1/tasks/${run.task.id}`)).body.recovery).toMatchObject({ status: 'awaiting_decision' });
    expect((await run.http.get('/api/v1/status')).body.recovery).toEqual({ ready: 0, reconciling: 0, awaiting_decision: 1, unsupported: 0 });
    // A result must match the tool's output schema and stay under 64 KiB.
    expect((await run.http.post(`/api/v1/tasks/${run.task.id}/recovery`, { action: 'mark_applied', result: { written: 'yes' } })).status).toBe(400);
    expect((await run.http.post(`/api/v1/tasks/${run.task.id}/recovery`, { action: 'mark_applied', result: { written: true, key: 'x'.repeat(70_000) } })).status).toBe(400);
    expect((await run.http.post(`/api/v1/tasks/${run.task.id}/recovery`, { action: 'mark_applied', call_id: 'call-nope' })).status).toBe(400);
    const decided = await run.http.post(`/api/v1/tasks/${run.task.id}/recovery`, { action: 'mark_applied', result: { written: true, key: 'operator' }, note: 'Checked the target system' });
    expect(decided.status).toBe(200);
    const recovery = decided.body as unknown as Recovery;
    expect(recovery).toMatchObject({ status: 'resolved', decided: { action: 'mark_applied' }, actions: [] });
    const continuation = recovery.continuation_task_id!;
    expect(continuation).toMatch(/^[0-9a-f-]{36}$/);
    expect(await settle(run.restarted, continuation)).toBe('completed');
    expect(await writes(run.side)).toHaveLength(0);
    // Repeating the decision returns the same outcome; another action conflicts.
    const again = await run.http.post(`/api/v1/tasks/${run.task.id}/recovery`, { action: 'mark_applied' });
    expect(again.status).toBe(200);
    expect((again.body as unknown as Recovery).continuation_task_id).toBe(continuation);
    expect((await run.http.post(`/api/v1/tasks/${run.task.id}/recovery`, { action: 'abandon' })).status).toBe(409);
    // The original stays unknown (terminal); the continuation is linked both ways and in lineage.
    expect(run.restarted.store.get(run.task.id)?.state).toBe('unknown');
    const next = run.restarted.store.get(continuation)!;
    expect(next).toMatchObject({ caller: 'management', context: 'direct', session_id: run.session!.id, prompt: run.task.prompt, idempotency_key: `recovery:${run.task.id}:2` });
    expect(kinds(run.restarted, run.task.id)).toContain('recovery_continued');
    expect(kinds(run.restarted, continuation)).toContain('recovery_continuation_of');
    expect(run.restarted.store.executionState.invocation(continuation, 'call-w1')).toMatchObject({ state: 'operator_applied', result: { ok: true, value: { written: true, key: 'operator' } } });
    const lineage = await run.http.get(`/api/v1/tasks/${run.task.id}/lineage`);
    expect((lineage.body.continuations as Array<{ local_task_id: string; source: string }>).map(item => [item.local_task_id, item.source])).toEqual([[continuation, 'continuation']]);
    expect(run.restarted.executionFor(continuation)).toMatchObject({ attempt: 2 });
    // The session holds the prompt once and one answer.
    const messages = run.restarted.store.sessionMessages(run.session!.id, 'management');
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0]?.content).toBe('Write the record');
  });

  it('mark_not_applied: the model is told, and writes once under a new call', async () => {
    const run = await heldAt2();
    const decided = await run.restarted.decideRecovery(run.task.id, { action: 'mark_not_applied' }, {});
    expect(await settle(run.restarted, decided.continuation!.id)).toBe('completed');
    expect(await writes(run.side)).toEqual([toolIdempotencyKey(decided.continuation!.id, 'call-w2')]);
    expect(run.restarted.store.executionState.invocation(decided.continuation!.id, 'call-w1')?.state).toBe('operator_not_applied');
  });

  it('retry_with_new_deadline: dispatches the pending call again under its idempotency key, bounded by the configured maximum', async () => {
    const run = await heldAt2();
    await expect(run.restarted.decideRecovery(run.task.id, { action: 'retry_with_new_deadline', deadline_seconds: 86_400 }, {})).rejects.toThrow(/recovery_max_new_deadline_seconds/);
    const decided = await run.restarted.decideRecovery(run.task.id, { action: 'retry_with_new_deadline' }, {});
    expect(await settle(run.restarted, decided.continuation!.id)).toBe('completed');
    expect(await writes(run.side)).toEqual([toolIdempotencyKey(run.task.id, 'call-w1')]);
  });

  it('abandon: records the decision and creates no continuation', async () => {
    const run = await heldAt2();
    const decided = await run.http.post(`/api/v1/tasks/${run.task.id}/recovery`, { action: 'abandon', note: 'Not needed' });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ status: 'resolved', decided: { action: 'abandon', note: 'Not needed' } });
    expect(decided.body.continuation_task_id).toBeUndefined();
    expect(run.restarted.store.get(run.task.id)?.state).toBe('unknown');
    expect((await run.http.post(`/api/v1/tasks/${run.task.id}/recovery`, { action: 'abandon' })).status).toBe(200);
    expect(await writes(run.side)).toHaveLength(0);
  });

  it('a task that was never interrupted has no recovery, and decisions on it conflict', async () => {
    const model = await llama(() => ({ text: 'Plain.' }));
    const { dir, loaded } = await profile(model.url);
    const runtime = start(dir, loaded);
    const task = runtime.accept('Hello');
    expect(await settle(runtime, task.id)).toBe('completed');
    const http = api(runtime, loaded);
    expect((await http.get(`/api/v1/tasks/${task.id}/recovery`)).status).toBe(404);
    expect((await http.get(`/api/v1/tasks/${task.id}`)).body.recovery).toBeUndefined();
    expect((await http.post(`/api/v1/tasks/${task.id}/recovery`, { action: 'abandon' })).status).toBe(409);
    expect((await http.post(`/api/v1/tasks/${task.id}/recovery`, { action: 'explode' })).status).toBe(400);
  });
});

describe('execution recovery: cancellation, pause, queue and sessions', () => {
  it('cancel requested before the crash: cancelled when nothing was uncertain, held when a write was', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const model = await llama(writeScript([{ id: 'call-r1', name: 'fixture_slow', args: {} }]));
    const { dir, loaded, side } = await profile(model.url);
    const first = start(dir, loaded);
    let entered!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    first.tools.register(readTool('fixture_slow', async () => { entered(); await hold; crash(first); }));
    const task = first.accept('Read slowly');
    void first.run(task.id, {}).catch(() => undefined);
    await inside;
    first.cancel(task.id);
    release();
    await sleep(50);
    const restarted = start(dir, loaded);
    expect(restarted.store.get(task.id)?.state).toBe('cancelled');
    expect(restarted.recoveryFor(task.id)).toMatchObject({ status: 'resolved', reason: { code: 'CANCELLED_DURING_OUTAGE' } });
    expect(await writes(side)).toHaveLength(0);

    let releaseWrite!: () => void;
    const writeHold = new Promise<void>(resolve => { releaseWrite = resolve; });
    let writing!: () => void;
    const started = new Promise<void>(resolve => { writing = resolve; });
    const run = await interrupted(async runtime => { await started; runtime.cancel(taskOf(runtime)); releaseWrite(); },
      { write: first2 => ({ beforeWrite: async () => { writing(); await writeHold; crash(first2); } }) });
    expect(run.restarted.store.get(run.task.id)?.state).toBe('unknown');
    expect(run.restarted.recoveryFor(run.task.id)).toMatchObject({ status: 'awaiting_decision', reason: { code: 'CANCELLED_WITH_UNSETTLED_EFFECT' },
      actions: ['mark_applied', 'mark_not_applied', 'abandon'] });
    // A cancelled task is not continued: the decision only records what the operator established.
    const decided = await run.restarted.decideRecovery(run.task.id, { action: 'mark_not_applied' }, {});
    expect(decided).toMatchObject({ recovery: { status: 'resolved', decided: { action: 'mark_not_applied' } } });
    expect(decided.continuation).toBeUndefined();
  });

  it('paused before the crash: still paused after restart, and continues on resume', async () => {
    let releaseReply!: () => void;
    const replyGate = new Promise<void>(resolve => { releaseReply = resolve; });
    const script = writeScript();
    const model = await llama(async (request, index) => { if (index === 0) await replyGate; return script(request); });
    const { dir, loaded, side } = await profile(model.url);
    const first = start(dir, loaded);
    first.tools.register(writeTool(side));
    const task = first.accept('Write the record');
    void first.run(task.id, {}).catch(() => undefined);
    for (let i = 0; i < 200 && model.requests.length === 0; i++) await sleep(5);
    first.pause(task.id);
    releaseReply();
    // The reply is checkpointed; the write waits at the pause boundary.
    for (let i = 0; i < 200 && !kinds(first, task.id).includes('paused'); i++) await sleep(5);
    crash(first);
    await sleep(150);
    const restarted = start(dir, loaded);
    restarted.tools.register(writeTool(side));
    expect(restarted.store.taskAdmission(task.id)).toBe('paused');
    expect(await restarted.resumeRecovered({})).toEqual([task.id]);
    await sleep(300);
    expect(restarted.store.get(task.id)?.state).toBe('running');
    expect(await writes(side)).toHaveLength(0);
    restarted.resume(task.id);
    expect(await settle(restarted, task.id)).toBe('completed');
    expect(await writes(side)).toHaveLength(1);
  });

  it('resumes interrupted work ahead of queued tasks, which keep their order; session messages are not duplicated', async () => {
    const order: string[] = [];
    const model = await llama(request => {
      const user = [...request.messages].reverse().find(message => message.role === 'user')?.content ?? '';
      if (request.messages.at(-1)?.role === 'user') order.push(user);
      return writeScript()(request);
    });
    const { dir, loaded, side } = await profile(model.url);
    const first = start(dir, loaded);
    first.tools.register(writeTool(side));
    const session = first.store.session('management', 'direct', 'order');
    const interruptedTask = first.accept('Interrupted', 'management', 'direct', undefined, session.id);
    const crashed = crashAfter(first, (kind, detail) => kind === 'tool_result' && detail.name === 'fixture_write');
    void first.run(interruptedTask.id, {}).catch(() => undefined);
    await crashed;
    const restarted = start(dir, loaded);
    restarted.tools.register(writeTool(side));
    const q1 = restarted.accept('Queued one');
    const q2 = restarted.accept('Queued two');
    // As the gateway does: interrupted work resumes first, then queued work is admitted.
    await restarted.resumeRecovered({});
    await Promise.all([restarted.run(q1.id, {}), restarted.run(q2.id, {})]);
    expect(await settle(restarted, interruptedTask.id)).toBe('completed');
    // The resumed task needed no new first call; queued tasks ran in order.
    expect(order).toEqual(['Interrupted', 'Queued one', 'Queued two']);
    const firstStarts = [q1.id, q2.id].map(id => restarted.store.events(id, 0, 500).find(event => event.kind === 'state' && (event.detail as { to: string }).to === 'running')?.sequence ?? 0);
    expect(firstStarts[0]).toBeLessThan(firstStarts[1]!);
    const resumedDone = restarted.store.events(interruptedTask.id, 0, 500).find(event => event.kind === 'state' && (event.detail as { to: string }).to === 'completed')?.sequence ?? Infinity;
    expect(resumedDone).toBeLessThan(firstStarts[0]!);
    expect(restarted.store.sessionMessages(session.id, 'management').map(message => message.role)).toEqual(['user', 'assistant']);
    // One write per task: the interrupted one was not written again.
    expect((await writes(side)).filter(key => key === toolIdempotencyKey(interruptedTask.id, 'call-w1'))).toHaveLength(1);
    expect(await writes(side)).toHaveLength(3);
  });

  it('a cancel after only a plugin-denied call is cancelled, not unknown', async () => {
    let releaseSecond!: () => void;
    const gate = new Promise<void>(resolve => { releaseSecond = resolve; });
    const model = await llama(async (request, index) => {
      if (index === 0) return { calls: [{ id: 'call-w1', name: 'fixture_write', args: { text: 'hello' } }] };
      await gate;
      return { text: 'late' };
    });
    const { dir, loaded, side } = await profile(model.url);
    const runtime = start(dir, loaded);
    runtime.tools.register(writeTool(side));
    await runtime.usePlugins([definePlugin({ name: 'deny', beforeToolCall: () => ({ deny: { code: 'DENIED_BY_POLICY', message: 'No writes' } }) })], {});
    const task = runtime.accept('Write the record');
    const pending = runtime.run(task.id, {});
    for (let i = 0; i < 400 && model.requests.length < 2; i++) await sleep(5);
    runtime.cancel(task.id);
    await expect(pending).rejects.toThrow();
    releaseSecond();
    expect(runtime.store.get(task.id)?.state).toBe('cancelled');
    expect(runtime.store.executionState.invocation(task.id, 'call-w1')?.state).toBe('failed_no_effect');
    expect(await writes(side)).toHaveLength(0);
  });
});

/** The id of the first task a runtime accepted (for cut callbacks that only get the runtime). */
function taskOf(runtime: ArdentRuntime): string { return runtime.store.list(1)[0]!.id; }

function mission(resources: string[]) {
  return { id: 'recovery-mission', revision: 1, parent_task: null, constraints: [], allowed_actions: ['observe', 'analyze', 'create_artifact'] as Array<'observe' | 'analyze' | 'create_artifact'>,
    resources, deadline: Math.floor(Date.now() / 1000) + 600, acceptance_criteria: ['The record is written'], expected_artifacts: [] };
}
const toolNames = (request: Body | undefined) => (request?.tools ?? []).map(tool => tool.function.name).sort();

describe('execution recovery: scope is re-derived, never taken from the checkpoint', () => {
  it('a peer task with a validated team envelope resumes with an identical tool list', async () => {
    const run = await interrupted(runtime => crashAfter(runtime, (kind, detail) => kind === 'model_result' && Array.isArray(detail.calls) && detail.calls.length > 0), {
      accept: runtime => {
        const task = runtime.accept('Write the record', 'peer-a', 'peer');
        runtime.store.append(task.id, 'team_envelope', { version: '1.0', caller: 'peer-a', task_id: 'remote-task-1', objective: 'Write the record', mission: mission(['tool:fixture_write', 'tool:fixture_read']) });
        return task;
      } });
    expect(toolNames(run.model.requests[0])).toEqual(['fixture_read', 'fixture_write']);
    await run.restarted.resumeRecovered({});
    expect(await settle(run.restarted, run.task.id)).toBe('completed');
    expect(toolNames(run.model.requests[1])).toEqual(toolNames(run.model.requests[0]));
    expect(await writes(run.side)).toHaveLength(1);
  });

  it('a mission task resumes with an identical tool list; a continuation reports operator decisions in its TeamResult', async () => {
    const accept = (runtime: ArdentRuntime) => runtime.acceptMission({ objective: 'Write the record', mission: mission(['tool:fixture_write', 'tool:artifact_write']), idempotency_key: 'mission-1' });
    const resumed = await interrupted(runtime => crashAfter(runtime, (kind, detail) => kind === 'model_result' && Array.isArray(detail.calls) && detail.calls.length > 0), { accept });
    expect(toolNames(resumed.model.requests[0])).toEqual(['artifact_write', 'fixture_write']);
    await resumed.restarted.resumeRecovered({});
    expect(await settle(resumed.restarted, resumed.task.id)).toBe('completed');
    expect(toolNames(resumed.model.requests[1])).toEqual(toolNames(resumed.model.requests[0]));

    const held = await interrupted(runtime => crashAfter(runtime, (kind, detail) => kind === 'tool_attempt' && detail.name === 'fixture_write'), { accept });
    await held.restarted.resumeRecovered({});
    expect(held.restarted.store.get(held.task.id)?.state).toBe('unknown');
    const decided = await held.restarted.decideRecovery(held.task.id, { action: 'mark_applied' }, {});
    const continuation = decided.continuation!;
    expect(continuation.context).toBe('mission');
    expect(await settle(held.restarted, continuation.id)).toBe('completed');
    // The continuation re-reads the same mission from its own copied mission event.
    expect(toolNames(held.model.requests.at(-1))).toEqual(['artifact_write', 'fixture_write']);
    const result = JSON.parse(held.restarted.store.get(continuation.id)?.result ?? '{}') as { task_id: string; uncertain_effects: string[]; mission_id: string; outcome: string };
    expect(result.outcome).toBe('partial');
    expect(result.task_id).toBe(continuation.id);
    expect(result.mission_id).toBe('recovery-mission');
    expect(result.uncertain_effects).toEqual([expect.stringContaining('fixture_write call call-w1 applied')]);
    expect(await writes(held.side)).toHaveLength(0);
  });

  it('artifact_write is idempotent: a registration interrupted before its receipt is found again, not duplicated', async () => {
    const args = { name: 'record.md', mime: 'text/markdown', text: '# Record' };
    let crashed!: () => void;
    const done = new Promise<void>(resolve => { crashed = resolve; });
    const run = await interrupted(() => done, {
      script: writeScript([{ id: 'call-a1', name: 'artifact_write', args }]),
      accept: runtime => {
        const register = runtime.artifactManifests.register.bind(runtime.artifactManifests);
        runtime.artifactManifests.register = async input => { const record = await register(input); crash(runtime); crashed(); return record; };
        return runtime.acceptMission({ objective: 'Save the record', mission: mission(['tool:artifact_write']), idempotency_key: 'mission-artifact' });
      } });
    expect(run.restarted.artifactManifests.forTask(run.task.id)).toHaveLength(1);
    await run.restarted.resumeRecovered({});
    expect(await settle(run.restarted, run.task.id)).toBe('completed');
    expect(run.restarted.artifactManifests.forTask(run.task.id)).toHaveLength(1);
    expect(run.restarted.store.executionState.invocation(run.task.id, 'call-a1')).toMatchObject({ state: 'succeeded' });
    expect(run.restarted.store.events(run.task.id, 0, 500).find(event => event.kind === 'execution_resumed')?.detail).toMatchObject({ redispatched_calls: 1 });
  });
});

describe('execution recovery: compatibility', () => {
  it('an older database without the new tables upgrades; in-flight tasks follow the no-checkpoint rules', async () => {
    const model = await llama(writeScript());
    const { dir, loaded, side } = await profile(model.url);
    const first = start(dir, loaded);
    const dispatched = first.accept('Dispatched before the upgrade');
    const clean = first.accept('Nothing dispatched before the upgrade');
    for (const task of [dispatched, clean]) first.store.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(task.id);
    first.store.append(dispatched.id, 'tool_attempt', { id: 'call-old', name: 'fixture_write', args: { text: 'x' } });
    first.close();
    const db = new Database(join(dir, 'state', 'ardent.sqlite'));
    db.exec('DROP TABLE execution_state; DROP TABLE tool_invocations; DROP TABLE task_recovery;');
    db.close();
    const restarted = start(dir, loaded);
    restarted.tools.register(writeTool(side));
    expect(restarted.store.get(dispatched.id)?.state).toBe('unknown');
    expect(restarted.recoveryFor(dispatched.id)).toMatchObject({ status: 'unsupported', reason: { code: 'NO_EXECUTION_CHECKPOINT' }, actions: [],
      checkpoint: { pending_calls: [expect.objectContaining({ call_id: 'call-old', tool: 'fixture_write' })] } });
    expect(restarted.recoveryFor(clean.id)).toMatchObject({ status: 'ready', reason: { code: 'RESTART_NO_EFFECT' } });
    expect(await restarted.resumeRecovered({})).toEqual([clean.id]);
    expect(await settle(restarted, clean.id)).toBe('completed');
    expect(restarted.store.events(clean.id, 0, 500).find(event => event.kind === 'execution_resumed')?.detail).toMatchObject({ mode: 'restart', from_step: 0 });
    expect(await writes(side)).toEqual([toolIdempotencyKey(clean.id, 'call-w1')]);
  });

  it('with recovery disabled, interrupted tasks are held unknown as before', async () => {
    const run = await interrupted(runtime => crashAfter(runtime, (kind, detail) => kind === 'tool_result' && detail.name === 'fixture_write'),
      { edit: loaded => { loaded.config.execution.recovery = { enabled: false }; } });
    expect(run.restarted.store.get(run.task.id)?.state).toBe('unknown');
    expect(run.restarted.recoveryFor(run.task.id)).toMatchObject({ status: 'unsupported', reason: { code: 'RECOVERY_DISABLED' }, actions: [] });
    expect(await run.restarted.resumeRecovered({})).toEqual([]);
    await expect(run.restarted.run(run.task.id, {})).rejects.toThrow('Task is unknown');
    expect(await writes(run.side)).toHaveLength(1);
  });

  it('holds preview tasks and extension executors with a possible effect as unsupported', async () => {
    const model = await llama(writeScript());
    const { dir, loaded } = await profile(model.url);
    const first = start(dir, loaded);
    const preview = first.store.accept({ caller: 'management', context: 'preview', prompt: 'Preview', backend: 'llamacpp', deadlineMs: Date.now() + 60_000 });
    const extension = first.accept('Extension');
    for (const task of [preview, extension]) first.store.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(task.id);
    first.store.append(extension.id, 'extension_execution_attempt', { plugin: 'fixture', id: 'flow', effect: 'possible' });
    first.close();
    const restarted = start(dir, loaded);
    expect(restarted.recoveryFor(preview.id)).toMatchObject({ status: 'unsupported', reason: { code: 'PREVIEW_NOT_RESUMABLE' } });
    expect(restarted.recoveryFor(extension.id)).toMatchObject({ status: 'unsupported', reason: { code: 'EXTENSION_EXECUTION_NOT_RESUMABLE' } });
    expect([preview, extension].map(task => restarted.store.get(task.id)?.state)).toEqual(['unknown', 'unknown']);
  });

  it('never uses a checkpoint that fails its digest', async () => {
    const run = await interrupted(runtime => crashAfter(runtime, (kind, detail) => kind === 'tool_result' && detail.name === 'fixture_write'));
    run.restarted.close();
    const db = new Database(join(run.dir, 'state', 'ardent.sqlite'));
    db.prepare("UPDATE execution_state SET messages_json='[]' WHERE task_id=?").run(run.task.id);
    db.close();
    const later = start(run.dir, run.loaded);
    expect(later.recoveryFor(run.task.id)).toMatchObject({ status: 'unsupported', reason: { code: 'CHECKPOINT_INVALID' } });
    expect(later.store.get(run.task.id)?.state).toBe('unknown');
  });

  it('ships the Codex protocol lock thread-recovery flags it is tested against', async () => {
    const lock = JSON.parse(await readFile(new URL('../codex-protocol.lock.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    expect({ observed_cli_version: lock.observed_cli_version, thread_resume_verified: lock.thread_resume_verified, thread_read_items_verified: lock.thread_read_items_verified })
      .toEqual(CODEX_PROTOCOL_LOCK);
  });
});

describe('execution recovery: Codex', () => {
  const fake = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
  async function codexRun(tool: 'fixture_write' | 'fixture_read', cut: (runtime: ArdentRuntime) => Promise<void>, env: NodeJS.ProcessEnv = {}) {
    const { dir, loaded, side } = await profile('http://127.0.0.1:9/', item => {
      item.config.execution.backend = 'codex';
      item.config.providers.codex.command = fake;
      item.config.providers.codex.model = 'fixture-model';
    });
    const fixtureEnv = { ARDENT_FIXTURE_TOOL: tool, ARDENT_FIXTURE_TOOL_ARGS: JSON.stringify(tool === 'fixture_write' ? { text: 'hello' } : {}), ...env };
    const first = start(dir, loaded, fixtureEnv);
    first.tools.register(writeTool(side));
    first.tools.register(readTool());
    const task = first.accept('Use the fixture tool');
    const crashed = cut(first);
    void first.run(task.id, fixtureEnv).catch(() => undefined);
    await crashed;
    await sleep(100);
    const restarted = start(dir, loaded, fixtureEnv);
    restarted.tools.register(writeTool(side));
    restarted.tools.register(readTool());
    return { dir, loaded, side, task, restarted, env: fixtureEnv };
  }
  const afterWriteReceipt = (runtime: ArdentRuntime) => crashAfter(runtime, (kind, detail) => kind === 'tool_result' && detail.name === 'fixture_write');

  it('records the durable thread and its turns', async () => {
    const run = await codexRun('fixture_write', afterWriteReceipt);
    // durable_threads defaults to true; a state upsert never forgets the thread.
    let state: ReturnType<typeof run.restarted.store.executionState.get>;
    try { state = run.restarted.store.executionState.get(run.task.id); } catch { state = undefined; }
    expect(state?.codex).toMatchObject({ thread_id: 'thread-1', durable: true, turns: [{ id: 'turn-1' }] });
    expect(state?.backend).toBe('codex');
  });

  it('(a) resumes a verified durable thread without dispatching the settled write again', async () => {
    const saved = { ...CODEX_PROTOCOL_LOCK };
    Object.assign(CODEX_PROTOCOL_LOCK, { thread_resume_verified: true, thread_read_items_verified: true });
    try {
      const run = await codexRun('fixture_write', afterWriteReceipt);
      expect(run.restarted.recoveryFor(run.task.id)).toMatchObject({ status: 'ready', reason: { code: 'CODEX_THREAD_RESUME' } });
      expect(await run.restarted.resumeRecovered(run.env)).toEqual([run.task.id]);
      expect(await settle(run.restarted, run.task.id)).toBe('completed');
      expect(run.restarted.store.get(run.task.id)?.result).toBe('Sourced fixture answer');
      expect(await writes(run.side)).toHaveLength(1);
      expect(run.restarted.store.events(run.task.id, 0, 500).find(event => event.kind === 'execution_resumed')?.detail).toMatchObject({ mode: 'codex_thread', reused_calls: 1 });
    } finally { Object.assign(CODEX_PROTOCOL_LOCK, saved); }
  });

  it('(a) is held when thread/read lists a tool call without a settled invocation', async () => {
    const saved = { ...CODEX_PROTOCOL_LOCK };
    Object.assign(CODEX_PROTOCOL_LOCK, { thread_resume_verified: true, thread_read_items_verified: true });
    try {
      const run = await codexRun('fixture_write', afterWriteReceipt, { ARDENT_FIXTURE_THREAD_ITEMS: JSON.stringify(['call-1', 'call-9']) });
      await run.restarted.resumeRecovered(run.env);
      expect(await settle(run.restarted, run.task.id)).toBe('unknown');
      expect(run.restarted.recoveryFor(run.task.id)).toMatchObject({ status: 'unsupported', reason: { code: 'CODEX_THREAD_NOT_VERIFIABLE' } });
      expect(await writes(run.side)).toHaveLength(1);
    } finally { Object.assign(CODEX_PROTOCOL_LOCK, saved); }
  });

  it('(b) restarts on a fresh thread when no effectful tool was dispatched', async () => {
    const run = await codexRun('fixture_read', runtime => crashAfter(runtime, (kind, detail) => kind === 'tool_attempt' && detail.name === 'fixture_read'));
    expect(run.restarted.recoveryFor(run.task.id)).toMatchObject({ status: 'ready', reason: { code: 'CODEX_RESTART_NO_EFFECT' } });
    await run.restarted.resumeRecovered(run.env);
    expect(await settle(run.restarted, run.task.id)).toBe('completed');
    expect(run.restarted.store.events(run.task.id, 0, 500).find(event => event.kind === 'execution_resumed')?.detail).toMatchObject({ mode: 'restart' });
  });

  it('(c) holds a task that dispatched an effectful tool when thread recovery is not verified for the installed CLI', async () => {
    const run = await codexRun('fixture_write', afterWriteReceipt);
    expect(run.restarted.store.get(run.task.id)?.state).toBe('unknown');
    const recovery = run.restarted.recoveryFor(run.task.id);
    expect(recovery).toMatchObject({ status: 'unsupported', reason: { code: 'CODEX_THREAD_NOT_VERIFIABLE' }, actions: [] });
    expect(recovery?.reason.message).toContain('not verified in the Codex protocol lock');
    expect(await writes(run.side)).toHaveLength(1);
  });
});

describe('execution recovery: graceful restarts', () => {
  it('a task stopped by the shutdown deadline with nothing uncertain stays running and resumes on the next start', async () => {
    let releaseReply!: () => void;
    const gate = new Promise<void>(resolve => { releaseReply = resolve; });
    const script = writeScript();
    const model = await llama(async (request, index) => { if (index === 1) await gate; return script(request); });
    const { dir, loaded, side } = await profile(model.url);
    const first = start(dir, loaded);
    first.tools.register(writeTool(side));
    const task = first.accept('Write the record');
    const pending = first.run(task.id, {}).catch(() => undefined);
    for (let i = 0; i < 400 && model.requests.length < 2; i++) await sleep(5);
    expect(await first.drain(50)).toBe(true);
    await pending;
    releaseReply();
    expect(first.store.get(task.id)?.state).toBe('running');
    expect(kinds(first, task.id)).toContain('execution_suspended');
    first.close();
    const restarted = start(dir, loaded);
    restarted.tools.register(writeTool(side));
    expect(restarted.recoveryFor(task.id)).toMatchObject({ status: 'ready', reason: { code: 'RESUME_FROM_CHECKPOINT' } });
    await restarted.resumeRecovered({});
    expect(await settle(restarted, task.id)).toBe('completed');
    expect(await writes(side)).toHaveLength(1);
  });

  it('does not resume interrupted work while admission is fenced for a rollback', async () => {
    const run = await interrupted(runtime => crashAfter(runtime, (kind, detail) => kind === 'tool_result' && detail.name === 'fixture_write'));
    run.restarted.store.closeAdmission('11111111-1111-4111-8111-111111111111');
    await run.restarted.resumeRecovered({});
    await expect(run.restarted.run(run.task.id, {})).rejects.toThrow('fenced');
    expect(run.restarted.store.get(run.task.id)?.state).toBe('running');
    expect(await writes(run.side)).toHaveLength(1);
  });
});
