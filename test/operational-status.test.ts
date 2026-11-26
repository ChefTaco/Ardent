import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@hivemagnus/hive-common/log';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArdentApi } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { JobEngine } from '../src/job-engine.js';
import { ArdentRuntime } from '../src/runtime.js';
import { JOB_TICK_ERROR_CURSOR } from '../src/store.js';
import { initTestProfile } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-status-'));
  dirs.push(dir);
  await initTestProfile(dir);
  const loaded = await loadConfig(dir);
  const env = { ARDENT_API_TOKEN: 'fixture-management-token' };
  const runtime = new ArdentRuntime(dir, loaded.config, env);
  const lines: string[] = [];
  const logger = createLogger({ level: 'info', write: line => { lines.push(line); } });
  const jobEngine = new JobEngine(runtime.store.db, dir, loaded.config.profile, {}, async () => {});
  const app = createArdentApi(runtime, loaded, env, jobEngine, { logger });
  const get = (path: string) => app.request(path, { headers: { Authorization: 'Bearer fixture-management-token' } });
  return { runtime, lines, get };
}

describe('operational status', () => {
  it('counts every task by state and reports the last job tick failure', async () => {
    const { runtime, get } = await setup();
    try {
      for (let index = 0; index < 12; index++)
        runtime.store.accept({ caller: 'management', context: 'direct', prompt: `task ${index}`, backend: 'llamacpp', deadlineMs: Date.now() + 60_000 });
      const first = runtime.store.list(100).at(-1)!;
      runtime.store.setState(first.id, 'completed', 'done');
      let status = await (await get('/api/v1/status')).json() as Record<string, unknown>;
      expect(status).toMatchObject({ tasks: 12, task_states: { queued: 11, completed: 1 }, jobs: { last_tick_error: null } });

      const before = Date.now();
      runtime.store.setCursor(JOB_TICK_ERROR_CURSOR, 'definitions could not be read');
      status = await (await get('/api/v1/status')).json() as Record<string, unknown>;
      const recorded = (status.jobs as { last_tick_error: { message: string; at: string } }).last_tick_error;
      expect(recorded.message).toBe('definitions could not be read');
      expect(Date.parse(recorded.at)).toBeGreaterThanOrEqual(before - 1000);
      const jobs = await (await get('/api/v1/jobs/definitions/status')).json() as Record<string, unknown>;
      expect(jobs.last_tick_error).toEqual(recorded);
    } finally { runtime.close(); }
  });

  it('logs an unhandled 500 while returning only a generic message', async () => {
    const { runtime, lines, get } = await setup();
    try {
      vi.spyOn(runtime.store.executionState, 'counts').mockImplementation(() => { throw new Error('internal failure detail'); });
      const response = await get('/api/v1/status');
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal request error' } });
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(entry).toMatchObject({ level: 'error', method: 'GET', path: '/api/v1/status' });
      expect(JSON.stringify(entry)).toContain('internal failure detail');
    } finally { vi.restoreAllMocks(); runtime.close(); }
  });
});
