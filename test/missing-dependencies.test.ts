import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createArdentApi } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { initTestProfile } from './helpers.js';
import { ArdentRuntime } from '../src/runtime.js';

const codex = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));

describe('missing backend and channel dependencies', () => {
  it('reports degraded readiness and specific provider, channel, and memory errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ardent-missing-'));
    try {
      await initTestProfile(dir);
      const loaded = await loadConfig(dir);
      const env = { ARDENT_API_TOKEN: 'fixture-management-token' };
      const runtime = new ArdentRuntime(dir, loaded.config, env);
      try {
        const app = createArdentApi(runtime, loaded, env);
        const request = (path: string, method = 'GET') => app.request(path, { method, headers: { Authorization: 'Bearer fixture-management-token' } });
        const ready = await app.request('/health/ready');
        expect(ready.status).toBe(503);
        expect((await ready.json() as { problems: string[] }).problems).toContain('providers.llamacpp.base_url is unresolved');
        const provider = await request('/api/v1/providers/test', 'POST');
        expect(provider.status).toBe(503);
        expect((await provider.json() as { error: { message: string } }).error.message).toContain('unconfigured');
        const channels = await request('/api/v1/channels');
        expect(channels.status).toBe(200);
        const channelState = await channels.json() as { telegram: { token_configured: boolean }; mattermost: { token_configured: boolean } };
        expect(channelState.telegram.token_configured).toBe(false);
        expect(channelState.mattermost.token_configured).toBe(false);
        for (const channel of ['telegram', 'mattermost']) {
          const result = await request(`/api/v1/channels/${channel}/test`, 'POST');
          expect(result.status).toBe(503);
          expect((await result.json() as { error: { message: string } }).error.message).toContain('missing');
        }
        const memory = await request('/api/v1/memory/status');
        expect(memory.status).toBe(200);
        expect((await memory.json() as { status: string }).status).toBe('degraded');
      } finally { runtime.close(); }

      for (const authMode of ['none', 'wrong'] as const) {
        const config = (await loadConfig(dir)).config;
        config.execution.backend = 'codex';
        config.providers.codex.command = codex;
        config.providers.codex.model = 'fixture';
        const codexEnv = { ARDENT_API_TOKEN: 'fixture-management-token', ARDENT_FIXTURE_AUTH_MODE: authMode };
        const codexRuntime = new ArdentRuntime(dir, config, codexEnv);
        try {
          const app = createArdentApi(codexRuntime, await loadConfig(dir), codexEnv);
          const headers = { Authorization: 'Bearer fixture-management-token' };
          expect((await app.request('/health/ready')).status).toBe(503);
          const probe = await app.request('/api/v1/providers/test', { method: 'POST', headers });
          expect(probe.status).toBe(503);
          expect((await probe.json() as { error: { message: string } }).error.message).toMatch(authMode === 'none' ? /login required/ : /wrong auth mode/);
        } finally { codexRuntime.close(); }
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
