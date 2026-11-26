import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArdentApi, MANAGEMENT_BODY_LIMIT_BYTES } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { invalidRequest } from '../src/errors.js';
import { loadPeers } from '../src/a2a-peers.js';
import { ArdentRuntime } from '../src/runtime.js';
import { initTestProfile } from './helpers.js';

const codex = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
const token = 'fixture-management-token';
const headers = { Authorization: `Bearer ${token}` };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); vi.restoreAllMocks(); });

async function profile(edit?: (config: Awaited<ReturnType<typeof loadConfig>>['config']) => void, extraEnv: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-api-errors-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await initTestProfile(dir);
  const loaded = await loadConfig(dir);
  edit?.(loaded.config);
  const env: NodeJS.ProcessEnv = { ARDENT_API_TOKEN: token, ...extraEnv };
  const runtime = new ArdentRuntime(dir, loaded.config, env);
  cleanup.push(() => runtime.close());
  const lines: string[] = [];
  const logger = { error: vi.fn((message: string, fields?: Record<string, unknown>) => { lines.push(message); void fields; }), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => logger };
  return { dir, runtime, env, loaded, logger, lines };
}
const body = async (response: Response) => await response.json() as { error: { code: string; message: string } };

describe('typed management API errors', () => {
  it('answers an internal error with 500 whatever its message says, and logs it', async () => {
    const { runtime, loaded, env, logger } = await profile();
    const app = createArdentApi(runtime, loaded, env, undefined, { logger: logger as never });
    // Before typed errors, "missing" made this a 503 and "invalid" a 400.
    vi.spyOn(runtime.store, 'taskCounts').mockImplementation(() => { throw new Error('invalid state: column missing after timeout'); });
    const response = await app.request('/api/v1/status', { headers });
    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal request error' } });
    expect(logger.error).toHaveBeenCalledWith('Unhandled management API error', expect.objectContaining({ path: '/api/v1/status' }));
  });

  it('maps typed errors explicitly', async () => {
    const { runtime, loaded, env, logger } = await profile();
    const app = createArdentApi(runtime, loaded, env, undefined, { logger: logger as never });
    // A peer that is not configured is absent (it was a 500).
    const peer = await app.request('/api/v1/peers/nobody/test', { method: 'POST', headers });
    expect(peer.status).toBe(404);
    expect((await body(peer)).error.code).toBe('NOT_FOUND');
    // A body that is not JSON, and a body that fails validation, are invalid requests.
    const notJson = await app.request('/api/v1/tasks', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{' });
    expect(notJson.status).toBe(400);
    expect((await body(notJson)).error.code).toBe('INVALID_REQUEST');
    const short = await app.request('/api/v1/config/validate', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }) });
    expect(short.status).toBe(400);
    // A revision conflict, an unknown skill and a bad query keep their statuses.
    const config = await app.request('/api/v1/config', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: loaded.text, revision: '0'.repeat(64) }) });
    expect(config.status).toBe(409);
    expect((await body(config)).error.code).toBe('CONFLICT');
    const skill = await app.request('/api/v1/skills/no-such-skill', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, revision: loaded.revision }) });
    expect(skill.status).toBe(404);
    expect((await app.request('/api/v1/tasks?limit=0', { headers })).status).toBe(400);
    expect((await app.request('/api/v1/identity/history-of-nothing/restore', { method: 'POST', headers })).status).toBe(400);
    const restore = await app.request('/api/v1/identity/soul/restore', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ history_name: `1-${'b'.repeat(12)}-${'a'.repeat(64)}.md`, revision: 'a'.repeat(64) }) });
    expect(restore.status).toBe(404);
    // A finished task refuses a pause with the historical CONFLICT code.
    const task = runtime.accept('Prompt', 'management');
    runtime.store.setState(task.id, 'failed', null, 'fixture');
    const pause = await app.request(`/api/v1/tasks/${task.id}/pause`, { method: 'POST', headers });
    expect(pause.status).toBe(409);
    expect((await body(pause)).error.code).toBe('CONFLICT');
    // A fenced profile refuses new work with 503 (it was a 500).
    runtime.store.closeAdmission('22222222-2222-4222-8222-222222222222');
    const fenced = await app.request('/api/v1/tasks', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'After the fence' }) });
    expect(fenced.status).toBe(503);
    expect((await body(fenced)).error.code).toBe('NOT_ACCEPTING_WORK');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('keeps the message-based status of an untyped plugin route error and honours a typed one', async () => {
    const { runtime, loaded, env, logger } = await profile();
    await runtime.usePlugins([{ name: 'errs', routes(app) {
      app.get('/legacy', () => { throw new Error('Widget not found'); });
      app.get('/typed', () => { throw invalidRequest('Widget is malformed in a way that is missing'); });
      app.get('/crash', () => { throw new Error('boom'); });
    } }, { name: 'errhttp', httpRoutes: () => [{ security: 'management', app: new Hono().get('/api/v1/errhttp/legacy', () => { throw new Error('upstream timeout'); }) }] }], env);
    const app = createArdentApi(runtime, loaded, env, undefined, { logger: logger as never });
    expect((await app.request('/api/v1/plugins/errs/legacy', { headers })).status).toBe(404);
    const typed = await app.request('/api/v1/plugins/errs/typed', { headers });
    expect(typed.status).toBe(400);
    expect((await body(typed)).error.code).toBe('INVALID_REQUEST');
    expect((await app.request('/api/v1/plugins/errs/crash', { headers })).status).toBe(500);
    expect((await app.request('/api/v1/errhttp/legacy', { headers })).status).toBe(503);
  });
});

describe('management request limits and authentication', () => {
  it('refuses a management body over 1 MiB with 413', async () => {
    const { runtime, loaded, env } = await profile();
    const app = createArdentApi(runtime, loaded, env);
    const large = JSON.stringify({ prompt: 'x'.repeat(MANAGEMENT_BODY_LIMIT_BYTES) });
    const response = await app.request('/api/v1/tasks', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: large });
    expect(response.status).toBe(413);
    expect((await body(response)).error.code).toBe('BODY_TOO_LARGE');
    expect(runtime.store.list(10)).toHaveLength(0);
  });

  it('accepts only the Bearer scheme, case-insensitively', async () => {
    const { runtime, loaded, env } = await profile();
    const app = createArdentApi(runtime, loaded, env);
    const status = (authorization: string) => app.request('/api/v1/profile', { headers: { Authorization: authorization } }).then(response => response.status);
    expect(await status(`Bearer ${token}`)).toBe(200);
    expect(await status(`bearer ${token}`)).toBe(200);
    expect(await status(token)).toBe(401);
    expect(await status(`Basic ${token}`)).toBe(401);
    expect(await status(`Bearer ${token} extra`)).toBe(401);
  });
});

describe('A2A peer authentication', () => {
  it('accepts only the Bearer scheme, case-insensitively, with one token', async () => {
    const { dir, loaded } = await profile();
    await writeFile(join(dir, 'peers.yaml'), 'schema_version: 1\npeers:\n  - id: coordinator\n    url: https://coordinator.example.com\n    token_env: COORDINATOR_TOKEN\n');
    const peerToken = 'fixture-peer-token-0123456789';
    const { authenticate } = await loadPeers(dir, loaded.config, { COORDINATOR_TOKEN: peerToken });
    expect(authenticate(`Bearer ${peerToken}`)).toBe('coordinator');
    expect(authenticate(`bearer ${peerToken}`)).toBe('coordinator');
    expect(authenticate(peerToken)).toBeUndefined();
    expect(authenticate(`Bearer ${peerToken} trailing`)).toBeUndefined();
    expect(authenticate(undefined)).toBeUndefined();
  });
});

describe('health and providers', () => {
  it('serves the HiveCommon health bodies and keeps the readiness problems', async () => {
    const { runtime, loaded, env } = await profile();
    const app = createArdentApi(runtime, loaded, env);
    const live = await app.request('/health/live');
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ status: 'live', service: 'ardent', version: expect.any(String), time: expect.any(String) });
    const ready = await app.request('/health/ready');
    expect(ready.status).toBe(503);
    const readyBody = await ready.json() as { status: string; service: string; problems: string[]; checks: Record<string, { status: string }> };
    expect(readyBody).toMatchObject({ status: 'degraded', service: 'ardent', checks: { configuration: { status: 'down' } } });
    expect(readyBody.problems).toContain('providers.llamacpp.base_url is unresolved');
  });

  it('does not start Codex for GET /providers on a llama.cpp profile, and caches the Codex account status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ardent-providers-rpc-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const rpc = join(dir, 'rpc.log');
    const llama = await profile(config => { config.providers.codex.command = codex; }, { ARDENT_FIXTURE_RPC_FILE: rpc });
    const app = createArdentApi(llama.runtime, llama.loaded, llama.env);
    const providers = await (await app.request('/api/v1/providers', { headers })).json() as { selected: string; codex: { auth_mode: string } };
    expect(providers).toMatchObject({ selected: 'llamacpp', codex: { auth_mode: 'not_selected' } });
    await expect(readFile(rpc, 'utf8')).rejects.toThrow();
    // Asked explicitly, it probes once and serves the cached status to the next call.
    for (let call = 0; call < 2; call += 1)
      expect(await (await app.request('/api/v1/providers?probe=codex', { headers })).json()).toMatchObject({ codex: { auth_mode: 'chatgpt' } });
    expect((await readFile(rpc, 'utf8')).split('\n').filter(line => line === 'initialize')).toHaveLength(1);

    const codexProfile = await profile(config => { config.execution.backend = 'codex'; config.providers.codex.command = codex; config.providers.codex.model = 'fixture'; config.a2a.enabled = false; },
      { ARDENT_FIXTURE_RPC_FILE: `${rpc}.codex` });
    const codexApp = createArdentApi(codexProfile.runtime, codexProfile.loaded, codexProfile.env);
    const codexReady = await codexApp.request('/health/ready');
    expect(await codexReady.json()).toMatchObject({ problems: [] });
    expect(codexReady.status).toBe(200);
    expect(await (await codexApp.request('/api/v1/providers', { headers })).json()).toMatchObject({ selected: 'codex', codex: { auth_mode: 'chatgpt' } });
    // Readiness and GET /providers share one probe.
    expect((await readFile(`${rpc}.codex`, 'utf8')).split('\n').filter(line => line === 'initialize')).toHaveLength(1);
  });
});
