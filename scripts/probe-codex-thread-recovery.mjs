#!/usr/bin/env node
// Live probe of Codex thread recovery against the installed Codex CLI and its
// signed-in account. It runs real model turns, so it is opt-in
// (ARDENT_CODEX_LIVE_PROBE=1) and never part of `npm run verify`.
//
//   npm run build && ARDENT_CODEX_LIVE_PROBE=1 node scripts/probe-codex-thread-recovery.mjs
//
// 1. Starts a durable thread with one read-only dynamic tool, asks the model to
//    call it once, and kills the App Server (SIGKILL) as soon as the tool call
//    item completes: a crash after a settled tool call.
// 2. A new App Server reads the thread (`thread/read` with `includeTurns`) and
//    checks that it lists the dynamic tool call under the id the call used.
// 3. Ardent's own recovery path (`CodexHarnessBackend.run` with
//    `execution.resume`) reads the thread, resumes it (`thread/resume`) and
//    runs a turn that must complete and recall a code word from the first turn.
// 4. A final `thread/read` checks the history is intact, then the probe thread
//    is archived.
//
// It uses the Codex home the CLI already uses (CODEX_HOME or its default) and
// never reads or prints credentials. The probe thread's rollout is archived in
// that home. Output is protocol evidence only: method names, a hash of the
// thread id, statuses and pass/fail. CODEX_COMMAND overrides `codex`, and
// ARDENT_CODEX_PROBE_MODEL / ARDENT_CODEX_PROBE_EFFORT the model choice.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

if (process.env.ARDENT_CODEX_LIVE_PROBE !== '1') {
  console.error('This probe runs live model turns on the signed-in Codex account. Set ARDENT_CODEX_LIVE_PROBE=1 to run it.');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '..');
const { CodexAppServer, CodexHarnessBackend, assertCodexProtocol, threadToolCallIds } = await import(join(root, 'dist/codex.js'));
const { CODEX_PROTOCOL_LOCK } = await import(join(root, 'dist/codex-protocol.js'));
const { ToolRegistry, defineTool } = await import(join(root, 'dist/tools.js'));

const command = process.env.CODEX_COMMAND ?? 'codex';
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
const codeWord = `kestrel-${randomBytes(3).toString('hex')}`;
const token = `tok-${randomBytes(4).toString('hex')}`;
const evidence = { cli_version: '', auth_mode: '', model: '', client_requests: [], server_messages: [], checks: {}, passed: false };
const requests = new Set();
const messages = new Set();
const check = (name, ok) => { evidence.checks[name] = Boolean(ok); return Boolean(ok); };

// Record method names (only) of every App Server, including the one Ardent's backend opens.
const { request: rawRequest, onMessage: rawOnMessage } = CodexAppServer.prototype;
CodexAppServer.prototype.request = function (method, params, timeoutMs) { requests.add(method); return rawRequest.call(this, method, params, timeoutMs); };
CodexAppServer.prototype.onMessage = function (listener) { return rawOnMessage.call(this, message => { messages.add(message.method); listener(message); }); };
const track = server => { server.onMessage(() => undefined); return server; };
function turnsOf(read) {
  const parsed = z.object({ thread: z.object({ turns: z.array(z.object({ status: z.string().optional(), items: z.array(z.object({ type: z.string(), id: z.string().optional() }).passthrough()) }).passthrough()) }).passthrough() }).safeParse(read);
  return parsed.success ? parsed.data.thread.turns : undefined;
}
function textOf(turns) { return JSON.stringify(turns ?? []); }
function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolveWait, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const value = predicate();
      if (value) { resolveWait(value); return; }
      if (Date.now() >= deadline) { reject(new Error(`${label} timed out`)); return; }
      setTimeout(poll, 50);
    };
    poll();
  });
}

const cwd = await mkdtemp(join(tmpdir(), 'ardent-codex-probe-'));
let threadId = '';
let probeModel = '';
let probeEffort;
try {
  evidence.cli_version = await assertCodexProtocol(command);

  // 1. Durable thread, one dynamic tool call, then a crash.
  const first = track(new CodexAppServer(command, cwd));
  let callId = '';
  let itemId = '';
  let crashed = false;
  let firstTurnEnded = '';
  try {
    await first.initialize();
    const auth = await first.accountStatus();
    evidence.auth_mode = auth;
    if (auth !== 'chatgpt' && auth !== 'api_key') throw new Error(`Codex is not signed in (${auth})`);
    const listed = z.object({ data: z.array(z.object({ model: z.string(), hidden: z.boolean().optional(), isDefault: z.boolean().optional(), defaultReasoningEffort: z.string().optional(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })) }).passthrough()) }).passthrough().parse(await first.request('model/list', { limit: 100 }));
    const chosen = listed.data.find(entry => entry.model === process.env.ARDENT_CODEX_PROBE_MODEL) ?? listed.data.find(entry => entry.isDefault) ?? listed.data.find(entry => !entry.hidden);
    if (!chosen) throw new Error('model/list returned no usable model');
    const effort = process.env.ARDENT_CODEX_PROBE_EFFORT ?? (chosen.supportedReasoningEfforts.some(entry => entry.reasoningEffort === 'low') ? 'low' : chosen.defaultReasoningEffort);
    probeModel = chosen.model;
    probeEffort = effort;
    evidence.model = effort ? `${chosen.model} (${effort})` : chosen.model;
    first.onMessage(message => {
      if (message.method === 'item/tool/call' && message.id !== undefined) {
        const params = z.object({ threadId: z.string(), callId: z.string(), tool: z.string() }).passthrough().safeParse(message.params);
        if (!params.success || params.data.threadId !== threadId) return;
        callId = params.data.callId;
        first.respond(message.id, { contentItems: [{ type: 'inputText', text: JSON.stringify({ ok: true, value: { token } }) }], success: true });
      } else if (message.method === 'item/completed') {
        const params = z.object({ threadId: z.string(), item: z.object({ type: z.string(), id: z.string().optional() }).passthrough() }).safeParse(message.params);
        if (!params.success || params.data.threadId !== threadId || params.data.item.type !== 'dynamicToolCall' || crashed) return;
        itemId = params.data.item.id ?? '';
        crashed = true;
        first.child.kill('SIGKILL');
      } else if (message.method === 'turn/completed') {
        const params = z.object({ threadId: z.string(), turn: z.object({ status: z.string() }).passthrough() }).safeParse(message.params);
        if (params.success && params.data.threadId === threadId) firstTurnEnded = params.data.turn.status;
      }
    });
    threadId = z.object({ thread: z.object({ id: z.string().min(1) }).passthrough() }).parse(await first.request('thread/start', {
      model: chosen.model, ...(effort ? { config: { model_reasoning_effort: effort } } : {}), cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false, serviceName: 'magnus-ardent',
      baseInstructions: 'You are a protocol probe. Follow the user instructions exactly and keep replies short.',
      dynamicTools: [{ type: 'function', name: 'probe_echo', description: 'Returns a probe token. Read-only.', inputSchema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false } }]
    }, 30000)).thread.id;
    evidence.thread_id_sha256_12 = hash(threadId);
    await first.request('turn/start', { threadId, input: [{ type: 'text', text: `Remember this code word for later: ${codeWord}. Now call the probe_echo tool exactly once with {"word":"probe"}. After it returns, reply with only: PROBE_TURN_ONE_DONE` }],
      cwd, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, model: chosen.model, ...(effort ? { effort } : {}) }, 30000);
    await waitFor(() => crashed || firstTurnEnded, 180000, 'first turn');
    // The crash point is evidence; a turn that ended before the tool item
    // completed still leaves a settled call to verify.
    evidence.killed_mid_turn = crashed;
    if (!check('first_turn_called_dynamic_tool', callId)) throw new Error(`first turn ended ${firstTurnEnded || 'unknown'} without a dynamic tool call`);
    if (crashed) await waitFor(() => first.child.exitCode !== null || first.child.signalCode !== null, 10000, 'App Server exit');
  } finally { first.close(); }

  // 2. A new App Server lists the settled tool call in thread/read.
  const reader = track(new CodexAppServer(command, cwd));
  let before;
  try {
    await reader.initialize();
    before = await reader.request('thread/read', { threadId, includeTurns: true }, 30000);
  } finally { reader.close(); }
  const listedCalls = threadToolCallIds(before) ?? [];
  const beforeTurns = turnsOf(before);
  evidence.turns_before_resume = beforeTurns?.map(turn => ({ status: turn.status, items: turn.items.map(item => item.type) }));
  if (crashed) check('tool_call_item_id_equals_call_id', itemId && itemId === callId);
  check('thread_read_lists_every_dynamic_tool_call', listedCalls.length === 1 && listedCalls[0] === callId);
  check('thread_read_keeps_first_user_message', textOf(beforeTurns).includes(codeWord));

  // 3. Ardent's recovery path resumes the thread. The lock is set for this
  //    process only, for the installed CLI, so codexThreadRecoveryProblem passes.
  Object.assign(CODEX_PROTOCOL_LOCK, { observed_cli_version: evidence.cli_version, thread_resume_verified: true, thread_read_items_verified: true });
  const registry = new ToolRegistry();
  registry.register(defineTool({ name: 'probe_echo', description: 'Returns a probe token. Read-only.', input: z.object({ word: z.string() }), output: z.object({ token: z.string() }), effect: 'read', contexts: ['direct'], timeoutMs: 5000, handler: async () => ({ token }) }));
  const backend = new CodexHarnessBackend({ command, model: probeModel, auth_mode: evidence.auth_mode, approval_policy: 'never', sandbox: 'read-only', durable_threads: true }, cwd);
  let resumed;
  try {
    resumed = await backend.run('', 'You are a protocol probe.', registry, 'direct', AbortSignal.timeout(180000), 1, undefined, undefined, undefined, probeEffort, [], {
      durableThread: true,
      resume: { threadId, settledCallIds: new Set([callId]), input: 'Ardent resumed this thread after an interruption. Do not call any tool. Reply with exactly: ARDENT_RESUME_OK <code word>, using the code word the user gave you at the start of this thread.' }
    });
  } catch (error) { evidence.resume_error = error instanceof Error ? `${error.constructor.name}: ${error.message.slice(0, 200)}` : 'unknown'; }
  check('resume_turn_completed', resumed?.answer);
  check('resume_kept_thread_id', resumed?.threadId === threadId);
  check('resumed_turn_recalls_first_turn', resumed?.answer.includes('ARDENT_RESUME_OK') && resumed.answer.includes(codeWord));
  evidence.resume_tool_calls = resumed?.toolCalls;
  evidence.resume_recalled_tool_output = Boolean(resumed?.answer.includes(token));

  // 4. History after the resumed turn, then archive the probe thread.
  const after = track(new CodexAppServer(command, cwd));
  try {
    await after.initialize();
    const read = await after.request('thread/read', { threadId, includeTurns: true }, 30000);
    const afterTurns = turnsOf(read);
    evidence.turns_after_resume = afterTurns?.map(turn => ({ status: turn.status, items: turn.items.map(item => item.type) }));
    check('history_intact_after_resume', afterTurns && beforeTurns && afterTurns.length === beforeTurns.length + 1 && textOf(afterTurns).includes(codeWord) && (threadToolCallIds(read) ?? []).join() === callId);
    check('last_turn_completed', afterTurns?.at(-1)?.status === 'completed');
  } finally { after.close(); }
  evidence.passed = Object.values(evidence.checks).every(Boolean);
} catch (error) {
  evidence.error = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
} finally {
  if (threadId) {
    const archiver = new CodexAppServer(command, cwd);
    try { await archiver.initialize(); await archiver.request('thread/archive', { threadId }, 15000); evidence.probe_thread_archived = true; }
    catch { evidence.probe_thread_archived = false; }
    finally { archiver.close(); }
  }
  await rm(cwd, { recursive: true, force: true });
}
evidence.client_requests = [...requests].sort();
evidence.server_messages = [...messages].sort();
console.log(JSON.stringify(evidence, null, 2));
process.exit(evidence.passed ? 0 : 1);
