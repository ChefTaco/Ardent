import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@hivemagnus/hive-common/log';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArdentApi } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { initTestProfile } from './helpers.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); vi.restoreAllMocks(); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-logging-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await initTestProfile(dir);
  const loaded = await loadConfig(dir);
  const env: NodeJS.ProcessEnv = { ARDENT_API_TOKEN: 'fixture-management-token' };
  const runtime = new ArdentRuntime(dir, loaded.config, env);
  cleanup.push(() => runtime.close());
  const lines: Array<Record<string, unknown>> = [];
  const write = (line: string) => { lines.push(JSON.parse(line) as Record<string, unknown>); };
  return { runtime, loaded, env, lines, write };
}

describe('structured operational logging', () => {
  it('logs an unhandled management API error as JSON with the request and trace ids, and echoes x-request-id', async () => {
    const { runtime, loaded, env, lines, write } = await setup();
    const app = createArdentApi(runtime, loaded, env, undefined, { logger: createLogger({ bindings: { service: 'ardent' }, write }) });
    vi.spyOn(runtime.store, 'taskCounts').mockImplementation(() => { throw new Error('fixture failure with a password=hunter2'); });
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const response = await app.request('/api/v1/status', { headers: { Authorization: 'Bearer fixture-management-token', 'x-request-id': 'req-fixture-1', traceparent } });
    expect(response.status).toBe(500);
    expect(response.headers.get('x-request-id')).toBe('req-fixture-1');
    const line = lines.find(entry => entry['msg'] === 'Unhandled management API error');
    expect(line).toMatchObject({ level: 'error', service: 'ardent', method: 'GET', path: '/api/v1/status', requestId: 'req-fixture-1', traceId: '0af7651916cd43dd8448eb211c80319c' });
    // HiveCommon redaction keeps secrets out of the line.
    expect(JSON.stringify(line)).not.toContain('hunter2');
    // A request without an id gets one.
    expect((await app.request('/health/live')).headers.get('x-request-id')).toMatch(/\S+/);
  });

  it('logs settled tasks with their ids, as a warning when they fail', async () => {
    const { runtime, lines, write } = await setup();
    runtime.logger = createLogger({ write, context: () => undefined });
    // The model endpoint is unresolved, so the task fails.
    const task = runtime.accept('Prompt', 'management');
    await runtime.run(task.id).catch(() => undefined);
    const line = lines.find(entry => entry['msg'] === 'Task settled');
    expect(line).toMatchObject({ level: 'warn', task_id: task.id, state: 'failed', caller: 'management', context: 'direct', request_id: expect.any(String), trace_id: expect.any(String) });
  });

  it('stays silent when the host gives the runtime no logger', async () => {
    const { runtime } = await setup();
    const stderr = vi.spyOn(process.stderr, 'write');
    const task = runtime.accept('Prompt', 'management');
    await runtime.run(task.id).catch(() => undefined);
    expect(stderr.mock.calls.filter(([chunk]) => String(chunk).includes('Task settled'))).toEqual([]);
  });
});
