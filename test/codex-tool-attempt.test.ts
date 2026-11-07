import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { initTestProfile } from './helpers.js';
import { ArdentRuntime } from '../src/runtime.js';
import { defineTool } from '../src/tools.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it('records a Codex tool attempt before dispatch so cancellation stays unknown and a late result is not journaled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-codex-attempt-')); dirs.push(dir);
  await initTestProfile(dir);
  const config = (await loadConfig(dir)).config;
  config.execution.backend = 'codex';
  config.providers.codex.command = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
  config.providers.codex.model = 'fixture-model';
  const env = { ARDENT_FIXTURE_TOOL: 'fixture_effect', ARDENT_FIXTURE_TOOL_ARGS: '{}' };
  const runtime = new ArdentRuntime(dir, config, env);
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let invoked = false;
  // The fixture effect ignores cancellation, like a provider request already in flight.
  runtime.tools.register(defineTool({ name: 'fixture_effect', description: 'Fixture external effect', input: z.object({}), output: z.object({ sent: z.boolean() }),
    effect: 'external-write', contexts: ['direct'], timeoutMs: 10_000, handler: async () => { invoked = true; await released; return { sent: true }; } }));
  try {
    const task = runtime.accept('Send the fixture effect');
    const pending = runtime.run(task.id, env);
    for (let attempt = 0; attempt < 500 && !invoked; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(invoked).toBe(true);
    expect(runtime.store.events(task.id).some(event => event.kind === 'tool_attempt' &&
      JSON.stringify(event.detail) === JSON.stringify({ id: 'call-1', name: 'fixture_effect', args: {} }))).toBe(true);
    runtime.cancel(task.id);
    await expect(pending).rejects.toThrow();
    expect(runtime.store.get(task.id)?.state).toBe('unknown');
    release();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(runtime.store.events(task.id, 0, 500).some(event => event.kind === 'tool_result')).toBe(false);
    expect(runtime.store.get(task.id)?.state).toBe('unknown');
  } finally { release(); runtime.close(); }
});
