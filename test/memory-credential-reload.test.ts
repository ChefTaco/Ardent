import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createArdentApi } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { registerMemoryTools } from '../src/memory-tools.js';
import { pluginContext } from '../src/plugins.js';
import { ArdentRuntime } from '../src/runtime.js';
import type { Task } from '../src/store.js';
import { ToolRegistry } from '../src/tools.js';
import { initTestProfile } from './helpers.js';

const OLD = 'fixture-header.old-payload.fixture-signature';
const NEW = 'fixture-header.new-payload.fixture-signature';
const headers = { Authorization: 'Bearer fixture-management-token' };
const task = { id: 'task-1', context: 'direct', caller: 'local', session_id: null } as unknown as Task;

let dir: string;
let runtime: ArdentRuntime | undefined;
let authorizations: string[];

async function gateway(provider: 'hivemem' | 'none' = 'hivemem', envFile?: string) {
  const loaded = await loadConfig(dir);
  if (provider === 'hivemem') loaded.config.memory = { provider: 'hivemem', base_url: 'https://hivemem.example.com/', token_env: 'ARDENT_HIVEMEM_TOKEN',
    agent_id: 'assistant', workspace_id: 'ws-1', default_scope: 'private' };
  const env: NodeJS.ProcessEnv = { ARDENT_API_TOKEN: 'fixture-management-token', ARDENT_HIVEMEM_TOKEN: OLD, UNRELATED: 'kept' };
  runtime = new ArdentRuntime(dir, loaded.config, env);
  const app = createArdentApi(runtime, loaded, env, undefined, envFile ? { envFile } : {});
  const reload = (body?: string, auth = true) => app.request('/api/v1/memory/credential/reload',
    { method: 'POST', headers: auth ? { ...headers, 'Content-Type': 'application/json' } : {}, ...(body === undefined ? {} : { body }) });
  const memoryStatus = async () => {
    const response = await app.request('/api/v1/memory/status', { headers });
    return (await response.json() as { status: string }).status;
  };
  return { app, env, runtime, reload, memoryStatus };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ardent-credential-'));
  await initTestProfile(dir);
  authorizations = [];
  vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get('Authorization') ?? '');
    return Promise.resolve(new Response(JSON.stringify({ retrieval: 'lexical', storage: 'sqlite' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  runtime?.close();
  runtime = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe('HiveMem credential reload', () => {
  it('swaps only the memory credential for every later HiveMem client', async () => {
    const { env, reload, memoryStatus } = await gateway();
    // The file also names other keys; only memory.token_env may change.
    await writeFile(join(dir, '.env'), `ARDENT_HIVEMEM_TOKEN=${NEW}\nARDENT_API_TOKEN=fixture-other-token\nUNRELATED=changed\nADDED=new\n`, { mode: 0o600 });
    const before = { ...env };
    expect(await memoryStatus()).toBe('ready');
    expect(authorizations.at(-1)).toBe(`Bearer ${OLD}`);

    const response = await reload();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ reloaded: true, token_env: 'ARDENT_HIVEMEM_TOKEN', changed: true });
    expect(text).not.toContain('payload');
    expect(env).toEqual({ ...before, ARDENT_HIVEMEM_TOKEN: NEW });

    expect(await memoryStatus()).toBe('ready');
    expect(authorizations.at(-1)).toBe(`Bearer ${NEW}`);
    // Runtime tools and plugins share the same environment object.
    const tools = new ToolRegistry();
    registerMemoryTools(tools, runtime!.config, env, task);
    await tools.call('hivemem_status', {}, 'direct', new AbortController().signal);
    expect(authorizations.at(-1)).toBe(`Bearer ${NEW}`);
    expect(pluginContext(runtime!, env).env.ARDENT_HIVEMEM_TOKEN).toBe(NEW);

    const again = await reload('{}');
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ reloaded: true, token_env: 'ARDENT_HIVEMEM_TOKEN', changed: false });
  });

  it('keeps the previous credential when the file has none or a malformed one', async () => {
    const { env, reload, memoryStatus } = await gateway();
    for (const content of ['UNRELATED=changed\n', 'ARDENT_HIVEMEM_TOKEN=\n', 'ARDENT_HIVEMEM_TOKEN=not-a-jwt\n', 'ARDENT_HIVEMEM_TOKEN=a.b.c.d\n', 'ARDENT_HIVEMEM_TOKEN="a.b c.d"\n']) {
      await writeFile(join(dir, '.env'), content, { mode: 0o600 });
      const response = await reload();
      expect(response.status).toBe(422);
      expect((await response.json() as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIAL');
      expect(env.ARDENT_HIVEMEM_TOKEN).toBe(OLD);
      expect(env.UNRELATED).toBe('kept');
    }
    await rm(join(dir, '.env'));
    expect((await reload()).status).toBe(422);
    expect(await memoryStatus()).toBe('ready');
    expect(authorizations.at(-1)).toBe(`Bearer ${OLD}`);
  });

  it('reloads from the explicit protected environment file the gateway started from', async () => {
    const file = join(dir, 'explicit.env');
    await writeFile(join(dir, '.env'), 'ARDENT_HIVEMEM_TOKEN=ignored.default.file\n', { mode: 0o600 });
    await writeFile(file, `ARDENT_HIVEMEM_TOKEN=${NEW}\n`, { mode: 0o600 });
    const { env, reload } = await gateway('hivemem', file);
    expect((await reload()).status).toBe(200);
    expect(env.ARDENT_HIVEMEM_TOKEN).toBe(NEW);
    await writeFile(file, 'ARDENT_HIVEMEM_TOKEN=other.shared.file\n');
    await chmod(file, 0o644);
    expect((await reload()).status).toBe(422);
    expect(env.ARDENT_HIVEMEM_TOKEN).toBe(NEW);
  });

  it('rejects request bodies other than an empty object', async () => {
    const { env, reload } = await gateway();
    await writeFile(join(dir, '.env'), `ARDENT_HIVEMEM_TOKEN=${NEW}\n`, { mode: 0o600 });
    for (const body of ['{"token":"x.y.z"}', '[]', 'null', 'not json']) {
      const response = await reload(body);
      expect(response.status).toBe(400);
      expect(env.ARDENT_HIVEMEM_TOKEN).toBe(OLD);
    }
  });

  it('refuses without HiveMem or without management authentication', async () => {
    await writeFile(join(dir, '.env'), `ARDENT_HIVEMEM_TOKEN=${NEW}\n`, { mode: 0o600 });
    const hivemem = await gateway();
    expect((await hivemem.reload(undefined, false)).status).toBe(401);
    expect(hivemem.env.ARDENT_HIVEMEM_TOKEN).toBe(OLD);
    hivemem.runtime.close();
    const none = await gateway('none');
    const response = await none.reload();
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('CONFLICT');
    expect(none.env.ARDENT_HIVEMEM_TOKEN).toBe(OLD);
  });
});
