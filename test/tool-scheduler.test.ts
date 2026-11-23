import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { initProfile, loadConfig } from '../src/config.js';
import { LlamaCppBackend } from '../src/llamacpp.js';
import { ArdentRuntime } from '../src/runtime.js';
import { ToolScheduler, toolIdempotencyKey, type ScheduledToolCall } from '../src/tool-scheduler.js';
import { defineTool, ToolCallLimitError, ToolRegistry, type Tool, type ToolEffect } from '../src/tools.js';
import { initTestProfile } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'ardent-scheduler-')); dirs.push(dir); return dir; }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Tools that record when each invocation starts and ends, and the peak overlap. */
function timeline() {
  const events: string[] = [];
  let active = 0;
  const state = { peak: 0, keys: new Map<string, string>() };
  const tool = (name: string, effect: ToolEffect, ms: number, options: Partial<Pick<Tool, 'concurrency'>> & { honorAbort?: boolean } = {}): Tool => defineTool({
    name, description: `Fixture ${name}`, input: z.object({}).passthrough(), output: z.object({ name: z.string() }), effect, contexts: ['direct'], timeoutMs: 10_000,
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    handler: async (_input, signal, ctx) => {
      if (ctx) state.keys.set(name, ctx.idempotencyKey);
      events.push(`start:${name}`);
      active++; state.peak = Math.max(state.peak, active);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          if (options.honorAbort) signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
        });
      } finally { active--; events.push(`end:${name}`); }
      return { name };
    } });
  return { events, state, tool };
}

function scheduler(tools: ToolRegistry, options: { limit?: number; maxToolCalls?: number; signal?: AbortSignal; pause?: () => Promise<void> } = {}) {
  const journal: { kind: string; detail: Record<string, unknown> }[] = [];
  const instance = new ToolScheduler({ taskId: 'task-1', context: 'direct', tools, limit: options.limit ?? 4, maxToolCalls: options.maxToolCalls ?? 80,
    signal: options.signal ?? new AbortController().signal, journal: (kind, detail) => journal.push({ kind, detail: detail as Record<string, unknown> }),
    pauseGate: async () => { await options.pause?.(); }, admissionGate: async () => {} });
  return { instance, journal };
}
const calls = (...names: string[]): ScheduledToolCall[] => names.map((name, index) => ({ id: `call-${index + 1}`, name, arguments: {} }));

describe('tool scheduler', () => {
  it('overlaps independent reads up to the configured limit', async () => {
    const { state, tool } = timeline();
    const tools = new ToolRegistry();
    for (const name of ['read_a', 'read_b', 'read_c']) tools.register(tool(name, 'read', 200));
    const started = Date.now();
    const results = await scheduler(tools).instance.runBatch(calls('read_a', 'read_b', 'read_c'));
    expect(Date.now() - started).toBeLessThan(450);
    expect(state.peak).toBe(3);
    expect(results.map(item => item.result.ok)).toEqual([true, true, true]);

    const bounded = timeline();
    const limited = new ToolRegistry();
    for (const name of ['read_a', 'read_b', 'read_c']) limited.register(bounded.tool(name, 'read', 120));
    await scheduler(limited, { limit: 2 }).instance.runBatch(calls('read_a', 'read_b', 'read_c'));
    expect(bounded.state.peak).toBe(2);
  });

  it('treats a write as a barrier and keeps model order around it', async () => {
    const { events, tool } = timeline();
    const tools = new ToolRegistry();
    tools.register(tool('read_a', 'read', 80));
    tools.register(tool('write_b', 'external-write', 30));
    tools.register(tool('read_c', 'read', 10));
    await scheduler(tools).instance.runBatch(calls('read_a', 'write_b', 'read_c'));
    expect(events).toEqual(['start:read_a', 'end:read_a', 'start:write_b', 'end:write_b', 'start:read_c', 'end:read_c']);
  });

  it('honours explicit parallel and serial declarations', async () => {
    const { events, state, tool } = timeline();
    const tools = new ToolRegistry();
    tools.register(tool('write_a', 'artifact-write', 60, { concurrency: 'parallel' }));
    tools.register(tool('write_b', 'artifact-write', 60, { concurrency: 'parallel' }));
    tools.register(tool('read_serial', 'read', 10, { concurrency: 'serial' }));
    await scheduler(tools).instance.runBatch(calls('write_a', 'write_b', 'read_serial'));
    expect(state.peak).toBe(2);
    expect(events.indexOf('start:read_serial')).toBeGreaterThan(Math.max(events.indexOf('end:write_a'), events.indexOf('end:write_b')));
  });

  it('returns results in emitted order bound to call ids when completion order differs', async () => {
    const { events, tool } = timeline();
    const tools = new ToolRegistry();
    tools.register(tool('read_slow', 'read', 120));
    tools.register(tool('read_fast', 'read', 10));
    const { instance, journal } = scheduler(tools);
    const results = await instance.runBatch(calls('read_slow', 'read_fast'));
    expect(events.indexOf('end:read_fast')).toBeLessThan(events.indexOf('end:read_slow'));
    expect(results.map(item => [item.call.id, item.result.ok && (item.result.value as { name: string }).name])).toEqual([['call-1', 'read_slow'], ['call-2', 'read_fast']]);
    // The journal records completion order, each result with its call id.
    expect(journal.filter(item => item.kind === 'tool_result').map(item => item.detail.id)).toEqual(['call-2', 'call-1']);
  });

  it('passes each tool a stable idempotency key derived from the task and call id', async () => {
    const { state, tool } = timeline();
    const tools = new ToolRegistry();
    tools.register(tool('read_a', 'read', 1));
    await scheduler(tools).instance.runBatch(calls('read_a'));
    const expected = createHash('sha256').update('task-1:call-1').digest('hex');
    expect(state.keys.get('read_a')).toBe(expected);
    expect(toolIdempotencyKey('task-1', 'call-1')).toBe(expected);
  });

  it('enforces max_tool_calls across a batch and across turns without dispatching the excess', async () => {
    const { events, tool } = timeline();
    const tools = new ToolRegistry();
    for (const name of ['read_a', 'read_b', 'read_c']) tools.register(tool(name, 'read', 20));
    const { instance, journal } = scheduler(tools, { maxToolCalls: 2 });
    await expect(instance.runBatch(calls('read_a', 'read_b', 'read_c'))).rejects.toBeInstanceOf(ToolCallLimitError);
    expect(journal.filter(item => item.kind === 'tool_attempt')).toHaveLength(2);
    expect(journal.find(item => item.kind === 'tool_not_dispatched')?.detail).toEqual({ id: 'call-3', name: 'read_c', reason: 'tool_call_limit', effect: 'none' });
    expect(events).not.toContain('start:read_c');

    const next = scheduler(tools, { maxToolCalls: 2 });
    await next.instance.runBatch(calls('read_a', 'read_b'));
    await expect(next.instance.runBatch([{ id: 'call-9', name: 'read_c', arguments: {} }])).rejects.toThrow('Tool-call limit reached');
  });

  it('settles queued calls without dispatch on abort and keeps started calls uncertain', async () => {
    const { events, tool } = timeline();
    const tools = new ToolRegistry();
    tools.register(tool('write_a', 'external-write', 500, { honorAbort: true }));
    tools.register(tool('read_b', 'read', 10));
    const abort = new AbortController();
    const { instance, journal } = scheduler(tools, { signal: abort.signal });
    const batch = instance.runBatch(calls('write_a', 'read_b'));
    await sleep(50);
    abort.abort('cancelled');
    const results = await batch;
    expect(results[0]?.result).toMatchObject({ ok: false, code: 'CANCELLED_OR_TIMEOUT', effect: 'unknown' });
    expect(results[1]?.result).toMatchObject({ ok: false, code: 'CANCELLED', effect: 'none' });
    expect(journal.find(item => item.kind === 'tool_not_dispatched')?.detail).toEqual({ id: 'call-2', name: 'read_b', reason: 'cancelled', effect: 'none' });
    expect(events).not.toContain('start:read_b');
  });
});

describe('runtime tool scheduling', () => {
  async function llamaRuntime(configure?: (config: Awaited<ReturnType<typeof loadConfig>>['config']) => void) {
    const dir = await temp(); await initProfile(dir);
    const config = (await loadConfig(dir)).config;
    configure?.(config);
    vi.spyOn(LlamaCppBackend.prototype, 'discover').mockResolvedValue({ modelListed: true, contextTokens: 32768, supportsTools: true, supportsReasoningEffort: false, sampling: { temperature: null, topP: null }, reasoningFormat: null, chatFormat: null });
    vi.spyOn(LlamaCppBackend.prototype, 'countInputTokens').mockResolvedValue(100);
    const complete = vi.spyOn(LlamaCppBackend.prototype, 'complete');
    return { runtime: new ArdentRuntime(dir, config, {}), complete };
  }
  const toolCalls = (...names: string[]) => names.map((name, index) => ({ id: `call-${index + 1}`, type: 'function' as const, function: { name, arguments: '{}' } }));

  it('feeds llama.cpp tool results back in emitted order after overlapping reads', async () => {
    const { runtime, complete } = await llamaRuntime();
    const { state, tool } = timeline();
    runtime.tools.register(tool('read_slow', 'read', 150));
    runtime.tools.register(tool('read_fast', 'read', 10));
    complete.mockResolvedValueOnce({ content: '', toolCalls: toolCalls('read_slow', 'read_fast') }).mockResolvedValueOnce({ content: 'Done', toolCalls: [] });
    try {
      const task = runtime.accept('Read both');
      expect((await runtime.run(task.id, {})).answer).toBe('Done');
      expect(state.peak).toBe(2);
      const followUp = complete.mock.calls[1]?.[0] ?? [];
      expect(followUp.filter(message => message.role === 'tool').map(message => message.tool_call_id)).toEqual(['call-1', 'call-2']);
      const results = runtime.store.events(task.id, 0, 500).filter(event => event.kind === 'tool_result');
      expect(results.every(event => typeof (event.detail as { id?: unknown }).id === 'string')).toBe(true);
    } finally { runtime.close(); }
  });

  it('cancels mid-batch: the started write is uncertain, queued calls are not dispatched', async () => {
    const { runtime, complete } = await llamaRuntime();
    const { events, tool } = timeline();
    runtime.tools.register(tool('write_a', 'external-write', 5_000, { honorAbort: true }));
    runtime.tools.register(tool('read_b', 'read', 10));
    complete.mockResolvedValueOnce({ content: '', toolCalls: toolCalls('write_a', 'read_b') });
    try {
      const task = runtime.accept('Write then read');
      const pending = runtime.run(task.id, {});
      for (let i = 0; i < 200 && !events.includes('start:write_a'); i++) await sleep(10);
      runtime.cancel(task.id);
      await expect(pending).rejects.toThrow();
      expect(runtime.store.get(task.id)?.state).toBe('unknown');
      const journal = runtime.store.events(task.id, 0, 500);
      expect(journal.find(event => event.kind === 'tool_result')?.detail).toMatchObject({ id: 'call-1', result: { ok: false, effect: 'unknown' } });
      expect(journal.find(event => event.kind === 'tool_not_dispatched')?.detail).toEqual({ id: 'call-2', name: 'read_b', reason: 'cancelled', effect: 'none' });
      expect(events).not.toContain('start:read_b');
    } finally { runtime.close(); }
  });

  it('stops further dispatch while paused mid-batch and continues on resume', async () => {
    const { runtime, complete } = await llamaRuntime();
    const { events, tool } = timeline();
    runtime.tools.register(tool('read_a', 'read', 150));
    runtime.tools.register(tool('write_b', 'external-write', 10));
    complete.mockResolvedValueOnce({ content: '', toolCalls: toolCalls('read_a', 'write_b') }).mockResolvedValueOnce({ content: 'Resumed', toolCalls: [] });
    try {
      const task = runtime.accept('Read then write');
      const pending = runtime.run(task.id, {});
      for (let i = 0; i < 200 && !events.includes('start:read_a'); i++) await sleep(5);
      runtime.pause(task.id);
      await sleep(400);
      expect(events).toEqual(['start:read_a', 'end:read_a']);
      expect(runtime.store.events(task.id, 0, 500).filter(event => event.kind === 'tool_attempt').map(event => (event.detail as { name: string }).name)).toEqual(['read_a']);
      runtime.resume(task.id);
      expect((await pending).answer).toBe('Resumed');
      expect(events).toEqual(['start:read_a', 'end:read_a', 'start:write_b', 'end:write_b']);
    } finally { runtime.close(); }
  });

  it('fails a turn that exceeds max_tool_calls without dispatching the excess call', async () => {
    const { runtime, complete } = await llamaRuntime(config => { config.execution.max_tool_calls = 2; });
    const { events, tool } = timeline();
    for (const name of ['read_a', 'read_b', 'read_c']) runtime.tools.register(tool(name, 'read', 10));
    complete.mockResolvedValueOnce({ content: '', toolCalls: toolCalls('read_a', 'read_b', 'read_c') });
    try {
      const task = runtime.accept('Too many');
      await expect(runtime.run(task.id, {})).rejects.toThrow('Tool-call limit reached');
      expect(runtime.store.get(task.id)?.state).toBe('failed');
      expect(events).not.toContain('start:read_c');
    } finally { runtime.close(); }
  });

  it('applies the same limit and barrier to concurrent Codex tool calls', async () => {
    const dir = await temp(); await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.execution.backend = 'codex';
    config.execution.max_parallel_tool_calls = 2;
    config.providers.codex.command = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
    config.providers.codex.model = 'fixture-model';
    const env = { ARDENT_FIXTURE_TOOL: 'read_a', ARDENT_FIXTURE_TOOLS_JSON: JSON.stringify([{ tool: 'read_a' }, { tool: 'read_b' }, { tool: 'read_c' }, { tool: 'write_d' }, { tool: 'read_e' }]) };
    const runtime = new ArdentRuntime(dir, config, env);
    const { events, state, tool } = timeline();
    for (const name of ['read_a', 'read_b', 'read_c', 'read_e']) runtime.tools.register(tool(name, 'read', 120));
    runtime.tools.register(tool('write_d', 'external-write', 20));
    try {
      const task = runtime.accept('Use the fixture tools');
      expect((await runtime.run(task.id, env)).answer).toBe('Sourced fixture answer');
      expect(state.peak).toBe(2);
      const writeStart = events.indexOf('start:write_d');
      for (const name of ['read_a', 'read_b', 'read_c']) expect(events.indexOf(`end:${name}`)).toBeLessThan(writeStart);
      expect(events.indexOf('start:read_e')).toBeGreaterThan(events.indexOf('end:write_d'));
      const journal = runtime.store.events(task.id, 0, 500);
      expect(journal.filter(event => event.kind === 'tool_result').map(event => (event.detail as { id: string }).id).sort())
        .toEqual(['call-1', 'call-2', 'call-3', 'call-4', 'call-5']);
      expect(journal.filter(event => event.kind === 'backend_event' && (event.detail as { kind: string }).kind === 'tool_result')
        .every(event => typeof (event.detail as { id?: unknown }).id === 'string')).toBe(true);
    } finally { runtime.close(); }
  });

  it('journals the Codex pause before the attempt, so a paused call stays undispatched', async () => {
    const dir = await temp(); await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.execution.backend = 'codex';
    config.providers.codex.command = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
    config.providers.codex.model = 'fixture-model';
    const env = { ARDENT_FIXTURE_TOOL: 'read_a', ARDENT_FIXTURE_TOOLS_JSON: JSON.stringify([{ tool: 'read_a' }, { tool: 'write_b' }]) };
    const runtime = new ArdentRuntime(dir, config, env);
    const { events, tool } = timeline();
    runtime.tools.register(tool('read_a', 'read', 200));
    runtime.tools.register(tool('write_b', 'external-write', 10));
    try {
      const task = runtime.accept('Pause between calls');
      const pending = runtime.run(task.id, env);
      for (let i = 0; i < 300 && !events.includes('start:read_a'); i++) await sleep(5);
      runtime.pause(task.id);
      await sleep(400);
      runtime.cancel(task.id);
      await expect(pending).rejects.toThrow();
      const journal = runtime.store.events(task.id, 0, 500);
      expect(journal.filter(event => event.kind === 'tool_attempt').map(event => (event.detail as { name: string }).name)).toEqual(['read_a']);
      expect(journal.find(event => event.kind === 'tool_not_dispatched')?.detail).toMatchObject({ id: 'call-2', name: 'write_b', reason: 'cancelled' });
      expect(events).not.toContain('start:write_b');
    } finally { runtime.close(); }
  });
});
