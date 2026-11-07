import { mkdtemp, readFile, rm, stat, mkdir, writeFile, symlink } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServer, CodexHarnessBackend, assertCodexProtocol } from '../src/codex.js';
import { ToolRegistry, defineTool } from '../src/tools.js';
import { z } from 'zod';
import type { CodexOutputLimitWitness } from '../src/codex-output-budget.js';

const command = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'ardent-codex-protocol-')); dirs.push(dir); return dir; }

describe('Codex App Server account and lifecycle protocol', () => {
  it('separates login-required and wrong-auth modes, completes/cancels device login, and resumes a thread', async () => {
    const dir = await temp();
    const server = new CodexAppServer(command, dir, { ARDENT_FIXTURE_AUTH_MODE: 'none', ARDENT_FIXTURE_LOGIN_RESULT: 'complete', OPENAI_API_KEY: 'must-not-leak' });
    try {
      await server.initialize();
      expect(await server.accountStatus()).toBe('login-required');
      const flow = await server.startDeviceLogin();
      expect(flow.loginId).toBe('fixture-login-1');
      expect(flow.verificationUrl).toBe('https://example.test/device');
      expect(await server.accountStatus()).toBe('chatgpt');
      expect(await server.resumeThread('thread-1')).toBe('thread-1');
    } finally { server.close(); }
    const expired = new CodexAppServer(command, dir, { ARDENT_FIXTURE_AUTH_MODE: 'none', ARDENT_FIXTURE_LOGIN_RESULT: 'expired' });
    try {
      await expired.initialize();
      const flow = await expired.startDeviceLogin();
      expect(await expired.accountStatus()).toBe('login-required');
      await expired.cancelLogin(flow.loginId);
      expect(await expired.accountStatus()).toBe('login-required');
    } finally { expired.close(); }
    const wrong = new CodexAppServer(command, dir, { ARDENT_FIXTURE_AUTH_MODE: 'wrong' });
    try { await wrong.initialize(); expect(await wrong.accountStatus()).toBe('api_key'); }
    finally { wrong.close(); }
  });

  it('denies an unadvertised peer tool and acknowledges interruption of an active turn', async () => {
    const dir = await temp();
    const registry = new ToolRegistry();
    let invoked = false;
    registry.register(defineTool({ name: 'fixture_search', description: 'Direct-only fixture', input: z.object({ query: z.string() }), output: z.object({ found: z.boolean() }), effect: 'read', contexts: ['direct'], timeoutMs: 1000, handler: async () => { invoked = true; return { found: true }; } }));
    const config = { command, model: 'fixture-model', auth_mode: 'chatgpt' as const, approval_policy: 'never' as const, sandbox: 'read-only' as const };
    const denied = new CodexHarnessBackend(config, dir, { ARDENT_FIXTURE_FORCE_TOOL_CALL: '1' });
    const denial = await denied.run('Try the unavailable tool', 'Peer tools are limited', registry, 'peer', new AbortController().signal, 2);
    expect(denial.answer).toBe('Tool failed');
    expect(denial.toolCalls).toBe(1);
    expect(invoked).toBe(false);
    const turnFile = join(dir, 'started-turn');
    const interruptFile = join(dir, 'interrupted-turn');
    const hanging = new CodexHarnessBackend(config, dir, { ARDENT_FIXTURE_FORCE_TOOL_CALL: '1', ARDENT_FIXTURE_HANG_TURN: '1', ARDENT_FIXTURE_TURN_FILE: turnFile, ARDENT_FIXTURE_INTERRUPT_FILE: interruptFile });
    const abort = new AbortController();
    const pending = hanging.run('Wait for cancellation', 'Read only', registry, 'peer', abort.signal, 2);
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = async () => {
        if (await stat(turnFile).then(() => true).catch(() => false)) { resolve(); return; }
        if (Date.now() >= deadline) { reject(new Error('Codex fixture turn did not start')); return; }
        setTimeout(() => { void poll(); }, 10);
      };
      void poll();
    });
    abort.abort('fixture cancellation');
    await expect(pending).rejects.toThrow('cancelled');
    expect(await readFile(interruptFile, 'utf8')).toBe('turn-1');
  });
});

it('passes exact local images and configured effort through the isolated Codex protocol', async () => {
  const dir = await temp(); const artifacts = join(dir, 'artifacts'); await mkdir(artifacts, { mode: 0o700 });
  const file = join(artifacts, 'page.png'); await writeFile(file, Buffer.from('verified image fixture'), { mode: 0o600 });
  const receipt = join(dir, 'protocol');
  const backend = new CodexHarnessBackend({ command, model: 'configured-model', auth_mode: 'chatgpt', approval_policy: 'never', sandbox: 'read-only' }, dir, { ARDENT_FIXTURE_FORCE_TOOL_CALL: '1', ARDENT_FIXTURE_IMAGE_PROTOCOL_FILE: receipt });
  const result = await backend.run('Inspect page', 'Isolated reviewer', new ToolRegistry(), 'peer', AbortSignal.timeout(5000), 0, undefined, undefined, undefined, 'high', [file]);
  expect(result.answer).toBe('Exact image reviewed');
  const thread = JSON.parse(await readFile(receipt + '.thread', 'utf8')); const turn = JSON.parse(await readFile(receipt + '.turn', 'utf8'));
  expect(thread).toMatchObject({ model: 'configured-model', config: { model_reasoning_effort: 'high' }, ephemeral: true, sandbox: 'read-only', dynamicTools: [] });
  expect(turn).toMatchObject({ model: 'configured-model', effort: 'high', input: [{ type: 'text', text: 'Inspect page' }, { type: 'localImage', path: file }], sandboxPolicy: { type: 'readOnly' } });
  const linked = join(artifacts, 'linked.png'); await symlink(file, linked);
  await expect(backend.run('Inspect', 'Reviewer', new ToolRegistry(), 'peer', AbortSignal.timeout(5000), 0, undefined, undefined, undefined, 'high', [linked])).rejects.toThrow('IMAGE_PATH_DENIED');
});

it('accepts newer Codex clients and rejects an unidentified executable', async () => {
  expect(await assertCodexProtocol(command, { ARDENT_FIXTURE_CODEX_VERSION: '0.160.0' })).toBe('0.160.0');
  expect(await assertCodexProtocol(command, { ARDENT_FIXTURE_CODEX_VERSION: '0.162.1' })).toBe('0.162.1');
  expect(await assertCodexProtocol(command, { ARDENT_FIXTURE_CODEX_VERSION: '0.162.2' })).toBe('0.162.2');
  expect(await assertCodexProtocol(command, { ARDENT_FIXTURE_CODEX_VERSION: '99.0.0' })).toBe('99.0.0');
  expect(await assertCodexProtocol(command, { ARDENT_FIXTURE_CODEX_VERSION: '99.0.0-beta.1+build.2' })).toBe('99.0.0-beta.1+build.2');
  await expect(assertCodexProtocol(command, { ARDENT_FIXTURE_CODEX_VERSION: 'unidentified' })).rejects.toThrow('CODEX_VERSION_UNAVAILABLE');
});

it('retains dispatch identities and verifies observed Sol medium with structured output', async () => {
  const dir = await temp(); const receipt = join(dir, 'sol-protocol'); const identifiers: unknown[] = [];
  const backend = new CodexHarnessBackend({ command, model: 'gpt-6.1-sol', auth_mode: 'chatgpt', approval_policy: 'never', sandbox: 'read-only' }, dir, { ARDENT_FIXTURE_FORCE_TOOL_CALL: '1', ARDENT_FIXTURE_IMAGE_PROTOCOL_FILE: receipt, ARDENT_FIXTURE_CODEX_VERSION: '0.160.0' });
  const outputSchema = { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'], additionalProperties: false };
  const result = await backend.run('Bounded structured call', 'No tools', new ToolRegistry(), 'peer', AbortSignal.timeout(5000), 0, undefined, undefined, undefined, 'medium', [], { verifyRoute: true, outputSchema, onIdentifiers: async identity => { identifiers.push(identity); } });
  expect(result.observation).toMatchObject({ model: 'gpt-6.1-sol', reasoningEffort: 'medium', codexVersion: '0.160.0' });
  expect(identifiers).toEqual([{ threadId: result.threadId, turnId: null }, { threadId: result.threadId, turnId: result.turnId }]);
  expect(JSON.parse(await readFile(receipt + '.turn', 'utf8'))).toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium', outputSchema });
  const wrong = new CodexHarnessBackend(backend.config, dir, { ARDENT_FIXTURE_FORCE_TOOL_CALL: '1', ARDENT_FIXTURE_OBSERVED_MODEL: 'gpt-6-sol', ARDENT_FIXTURE_IMAGE_PROTOCOL_FILE: receipt });
  await expect(wrong.run('Bounded', 'No tools', new ToolRegistry(), 'peer', AbortSignal.timeout(5000), 0, undefined, undefined, undefined, 'medium', [], { verifyRoute: true })).rejects.toThrow('CODEX_MODEL_MISMATCH');
});

it.each(['delta', 'completed', 'aggregate'] as const)('retains the %s output bound witness before exactly one interrupt, without another provider turn', async mode => {
  const dir = await temp(); const rpc = join(dir, 'rpc'); const witnessFile = join(dir, 'witness'); const observed = join(dir, 'witness-observed');
  const messages = mode === 'aggregate' ? [{ id: 'commentary', text: '12345', phase: 'commentary' }, { id: 'final', text: '678901' }] : [{ id: 'final', text: '海海海海', ...(mode === 'delta' ? { deltas: ['海海', '海海'], completed: false } : {}) }];
  const witnesses: CodexOutputLimitWitness[] = []; const identifiers: unknown[] = [];
  const backend = new CodexHarnessBackend({ command, model: 'gpt-6.1-sol', auth_mode: 'chatgpt', approval_policy: 'never', sandbox: 'read-only' }, dir,
    { ARDENT_FIXTURE_FORCE_TOOL_CALL: '1', ARDENT_FIXTURE_CODEX_VERSION: '0.160.0', ARDENT_FIXTURE_AGENT_MESSAGES: JSON.stringify(messages), ARDENT_FIXTURE_WAIT_INTERRUPT: '1', ARDENT_FIXTURE_RPC_FILE: rpc, ARDENT_FIXTURE_WITNESS_FILE: witnessFile, ARDENT_FIXTURE_WITNESS_OBSERVATION_FILE: observed });
  await expect(backend.run('Bounded output', 'No tools', new ToolRegistry(), 'peer', AbortSignal.timeout(10000), 0, undefined, undefined, undefined, 'medium', [], {
    verifyRoute: true, durableThread: true, outputBounds: { maxAgentBytes: 10, requestedOutputTokens: 12000 },
    onIdentifiers: async value => { identifiers.push(value); }, onOutputLimit: value => { witnesses.push(value); writeFileSync(witnessFile, JSON.stringify(value)); }
  })).rejects.toThrow('CODEX_OUTPUT_BYTES_EXCEEDED');
  expect(witnesses).toHaveLength(1);
  expect(witnesses[0]).toMatchObject({ threadId: 'thread-1', turnId: 'turn-1', limit: 10, observed: mode === 'aggregate' ? 11 : 12 });
  expect(identifiers).toEqual([{ threadId: 'thread-1', turnId: null }, { threadId: 'thread-1', turnId: 'turn-1' }]);
  expect(JSON.parse(await readFile(observed, 'utf8'))).toEqual({ witnessPresent: true });
  const methods = (await readFile(rpc, 'utf8')).trim().split('\n');
  expect(methods.filter(value => value === 'turn/start')).toHaveLength(1);
  expect(methods.filter(value => value === 'turn/interrupt')).toHaveLength(1);
  expect(methods).not.toContain('thread/resume');
});

it('accepts exact Unicode boundaries, ignores unrelated threads, keeps actual usage and treats requested tokens as advisory', async () => {
  const dir = await temp(); const receipt = join(dir, 'bounded-protocol'); const events: unknown[] = [];
  const usage = { last: { inputTokens: 20, outputTokens: 7, reasoningOutputTokens: 3 }, total: { inputTokens: 20, outputTokens: 7 }, modelContextWindow: 200000 };
  const backend = new CodexHarnessBackend({ command, model: 'gpt-6.1-sol', auth_mode: 'chatgpt', approval_policy: 'never', sandbox: 'read-only' }, dir,
    { ARDENT_FIXTURE_FORCE_TOOL_CALL: '1', ARDENT_FIXTURE_AGENT_MESSAGES: JSON.stringify([{ id: 'final', deltas: ['\ud83e', '\udd91'], text: '🦑' }]), ARDENT_FIXTURE_OTHER_THREAD_DELTA: '1', ARDENT_FIXTURE_OTHER_TURN_DELTA: '1', ARDENT_FIXTURE_IMAGE_PROTOCOL_FILE: receipt, ARDENT_FIXTURE_TOKEN_USAGE: JSON.stringify(usage) });
  const result = await backend.run('Bounded', 'No tools', new ToolRegistry(), 'peer', AbortSignal.timeout(5000), 0, undefined, undefined, event => events.push(event), 'medium', [], { verifyRoute: true, outputBounds: { maxAgentBytes: 4, requestedOutputTokens: 1 } });
  expect(result.answer).toBe('🦑'); expect(result.observation?.usage).toEqual(usage);
  expect(events).toContainEqual({ kind: 'completed', backend: 'codex', output_chars: 2, tool_calls: 0, reasoning_chars: 0, usage: { promptTokens: 20, completionTokens: 7 } });
  const turn = JSON.parse(await readFile(receipt + '.turn', 'utf8'));
  expect(turn).not.toHaveProperty('maxOutputTokens'); expect(turn).not.toHaveProperty('maxAgentBytes');
});

it('does not impose production stream bounds on an ordinary Codex conversation', async () => {
  const dir = await temp(); const backend = new CodexHarnessBackend({ command, model: 'gpt-6.1-sol', auth_mode: 'chatgpt', approval_policy: 'never', sandbox: 'read-only' }, dir,
    { ARDENT_FIXTURE_FORCE_TOOL_CALL: '1', ARDENT_FIXTURE_AGENT_MESSAGES: JSON.stringify([{ id: 'final', text: '12345' }]) });
  const result = await backend.run('Ordinary', 'Read only', new ToolRegistry(), 'direct', AbortSignal.timeout(5000), 0, undefined, undefined, undefined, 'medium', [], { outputBounds: { maxAgentBytes: 1 } });
  expect(result.answer).toBe('12345');
});

it.each([undefined, '', 42])('rejects malformed native production item identity %s without replay', async id => {
  const dir = await temp(); const rpc = join(dir, 'rpc');
  const backend = new CodexHarnessBackend({ command, model: 'gpt-6.1-sol', auth_mode: 'chatgpt', approval_policy: 'never', sandbox: 'read-only' }, dir,
    { ARDENT_FIXTURE_FORCE_TOOL_CALL: '1', ARDENT_FIXTURE_AGENT_MESSAGES: JSON.stringify([{ id, text: '123' }, { id, text: '456' }]), ARDENT_FIXTURE_WAIT_INTERRUPT: '1', ARDENT_FIXTURE_RPC_FILE: rpc });
  await expect(backend.run('Bounded', 'No tools', new ToolRegistry(), 'peer', AbortSignal.timeout(5000), 0, undefined, undefined, undefined, 'medium', [], { verifyRoute: true, outputBounds: { maxAgentBytes: 4 } })).rejects.toThrow('CODEX_PRODUCTION_ITEM_ID_INVALID');
  const methods = (await readFile(rpc, 'utf8')).trim().split('\n');
  expect(methods.filter(value => value === 'turn/start')).toHaveLength(1);
  expect(methods.filter(value => value === 'turn/interrupt')).toHaveLength(1);
});

it('does not replay a turn or its interrupt when the interrupt acknowledgement is lost', async () => {
  const dir = await temp(); const rpc = join(dir, 'rpc');
  const backend = new CodexHarnessBackend({ command, model: 'gpt-6.1-sol', auth_mode: 'chatgpt', approval_policy: 'never', sandbox: 'read-only' }, dir,
    { ARDENT_FIXTURE_FORCE_TOOL_CALL: '1', ARDENT_FIXTURE_AGENT_MESSAGES: JSON.stringify([{ id: 'final', deltas: ['12345'], text: '12345', completed: false }]), ARDENT_FIXTURE_WAIT_INTERRUPT: '1', ARDENT_FIXTURE_LOSE_INTERRUPT_REPLY: '1', ARDENT_FIXTURE_RPC_FILE: rpc });
  await expect(backend.run('Bounded', 'No tools', new ToolRegistry(), 'peer', AbortSignal.timeout(15000), 0, undefined, undefined, undefined, 'medium', [], { verifyRoute: true, outputBounds: { maxAgentBytes: 4 } })).rejects.toThrow('CODEX_OUTPUT_BYTES_EXCEEDED');
  const methods = (await readFile(rpc, 'utf8')).trim().split('\n');
  expect(methods.filter(value => value === 'turn/start')).toHaveLength(1);
  expect(methods.filter(value => value === 'turn/interrupt')).toHaveLength(1);
}, 10000);
