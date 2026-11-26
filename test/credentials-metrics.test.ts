import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPeers } from '../src/a2a-peers.js';
import { createArdentApi } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { initTestProfile } from './helpers.js';

const OLD = 'fixture-management-token-old';
const NEW = 'fixture-management-token-new';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); vi.restoreAllMocks(); });

async function setup(withPeers = false) {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-rotation-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await initTestProfile(dir);
  if (withPeers) await writeFile(join(dir, 'peers.yaml'), 'schema_version: 1\npeers:\n  - id: coordinator\n    url: https://coordinator.example.com\n    inbound_token_env: COORDINATOR_IN\n    outbound_token_env: COORDINATOR_OUT\n');
  const loaded = await loadConfig(dir);
  const env: NodeJS.ProcessEnv = { ARDENT_API_TOKEN: OLD, COORDINATOR_IN: 'fixture-inbound-token-1', COORDINATOR_OUT: 'fixture-outbound-token-1' };
  const runtime = new ArdentRuntime(dir, loaded.config, env);
  cleanup.push(() => runtime.close());
  const peers = withPeers ? await loadPeers(dir, loaded.config, env) : undefined;
  const app = createArdentApi(runtime, loaded, env, undefined, { peerAuthenticator: () => peers?.authenticator });
  const writeEnv = (text: string) => writeFile(join(dir, '.env'), text, { mode: 0o600 });
  const call = (path: string, token: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  return { dir, runtime, env, app, peers, writeEnv, call };
}
const post = (body?: unknown): RequestInit => ({ method: 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });

describe('management credential rotation', () => {
  it('switches to the token in the environment file and accepts the old one for the overlap', async () => {
    const { env, writeEnv, call } = await setup();
    let now = 1_790_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await writeEnv(`ARDENT_API_TOKEN=${NEW}\n`);
    const response = await call('/api/v1/credentials/management/reload', OLD, post({ overlap_seconds: 60 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reloaded: true, token_env: 'ARDENT_API_TOKEN', changed: true, previous_valid_until: new Date(now + 60_000).toISOString() });
    expect(env.ARDENT_API_TOKEN).toBe(NEW);
    expect((await call('/api/v1/profile', NEW)).status).toBe(200);
    expect((await call('/api/v1/profile', OLD)).status).toBe(200);
    now += 61_000;
    expect((await call('/api/v1/profile', OLD)).status).toBe(401);
    expect((await call('/api/v1/profile', NEW)).status).toBe(200);
    // A repeat with the same file changes nothing.
    expect(await (await call('/api/v1/credentials/management/reload', NEW, post())).json()).toMatchObject({ changed: false, previous_valid_until: null });
  });

  it('ends the old token at once with overlap 0, and keeps the token in use when the file holds a bad one', async () => {
    const { writeEnv, call } = await setup();
    await writeEnv('ARDENT_API_TOKEN=tiny\n');
    const refused = await call('/api/v1/credentials/management/reload', OLD, post());
    expect(refused.status).toBe(422);
    expect(JSON.stringify(await refused.json())).not.toContain('tiny');
    expect((await call('/api/v1/profile', OLD)).status).toBe(200);
    expect((await call('/api/v1/credentials/management/reload', OLD, post({ overlap_seconds: 7200 }))).status).toBe(400);
    await writeEnv(`ARDENT_API_TOKEN=${NEW}\n`);
    expect((await call('/api/v1/credentials/management/reload', OLD, post({ overlap_seconds: 0 }))).status).toBe(200);
    expect((await call('/api/v1/profile', OLD)).status).toBe(401);
    expect((await call('/api/v1/credentials/management/reload', OLD, post())).status).toBe(401);
  });
});

describe('A2A peer credential rotation', () => {
  it('reloads inbound and outbound peer tokens with an overlap, and changes nothing when they are invalid', async () => {
    const { env, peers, writeEnv, call } = await setup(true);
    let now = 1_790_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const auth = peers!.authenticator;
    expect(auth.authenticate('Bearer fixture-inbound-token-1')).toBe('coordinator');
    await writeEnv('COORDINATOR_IN=fixture-inbound-token-2\nCOORDINATOR_OUT=fixture-inbound-token-2\n');
    const invalid = await call('/api/v1/credentials/peers/reload', OLD, post());
    expect(invalid.status).toBe(422);
    expect(auth.authenticate('Bearer fixture-inbound-token-2')).toBeUndefined();
    await writeEnv('COORDINATOR_IN=fixture-inbound-token-2\nCOORDINATOR_OUT=fixture-outbound-token-2\n');
    const response = await call('/api/v1/credentials/peers/reload', OLD, post({ overlap_seconds: 30 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reloaded: true, peers: 1, changed: ['coordinator'], service_environment: [], previous_valid_until: new Date(now + 30_000).toISOString() });
    expect(env.COORDINATOR_OUT).toBe('fixture-outbound-token-2');
    expect(auth.authenticate('Bearer fixture-inbound-token-2')).toBe('coordinator');
    expect(auth.authenticate('Bearer fixture-inbound-token-1')).toBe('coordinator');
    now += 31_000;
    expect(auth.authenticate('Bearer fixture-inbound-token-1')).toBeUndefined();
    expect(auth.authenticate('Bearer fixture-inbound-token-2')).toBe('coordinator');
  });

  it('answers 409 when the A2A surface is not running', async () => {
    const { call } = await setup();
    expect((await call('/api/v1/credentials/peers/reload', OLD, post())).status).toBe(409);
  });
});

describe('GET /api/v1/metrics', () => {
  it('serves OpenMetrics text behind the management token', async () => {
    const { runtime, call, app } = await setup();
    runtime.accept('One', 'management');
    const failed = runtime.accept('Two', 'management');
    runtime.store.setState(failed.id, 'failed', null, 'fixture');
    runtime.counters.increment('a2a_rate_limited', { scope: 'ip' });
    runtime.counters.increment('a2a_rate_limited', { scope: 'ip' });
    expect((await app.request('/api/v1/metrics')).status).toBe(401);
    const response = await call('/api/v1/metrics', OLD);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/openmetrics-text; version=1\.0\.0/);
    const text = await response.text();
    expect(text).toContain('# TYPE ardent_tasks gauge');
    expect(text).toContain('ardent_tasks{state="queued"} 1');
    expect(text).toContain('ardent_tasks{state="failed"} 1');
    expect(text).toContain('ardent_recovery_tasks{status="awaiting_decision"} 0');
    expect(text).toContain('ardent_a2a_rate_limited_total{scope="ip"} 2');
    expect(text).toContain('ardent_a2a_rate_limited_total{scope="peer"} 0');
    expect(text).toMatch(/ardent_build_info\{version="[^"]+",profile="[^"]+",backend="llamacpp"\} 1/);
    expect(text.endsWith('# EOF\n')).toBe(true);
    // Every sample line names a declared family.
    const families = new Set([...text.matchAll(/^# TYPE (\S+) /gm)].map(match => match[1]!));
    for (const line of text.split('\n').filter(line => line && !line.startsWith('#')))
      expect([...families].some(name => line.startsWith(name)), line).toBe(true);
  });
});
