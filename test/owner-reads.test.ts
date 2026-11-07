import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tools.js';
import { registerMagnusControlTools } from '../src/magnus-control.js';
import { acquireGatewayLock, createLockFile } from '../src/gateway-lock.js';
import { boundOwnerData } from '../src/owner-read.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

async function fixture(handler: (url: string, method: string) => unknown): Promise<{ origin: string; urls: string[]; server: Server }> {
  const urls: string[] = [];
  const server = createServer((request, response) => {
    urls.push(`${request.method} ${request.url}`);
    expect(request.headers.authorization).toBe('Bearer fixture-read-token');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ success: true, data: handler(request.url ?? '', request.method ?? '') }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return { origin: `http://127.0.0.1:${address.port}/`, urls, server };
}

function tools(_role: 'magnus', origin: string): ToolRegistry {
  const registry = new ToolRegistry();
  registerMagnusControlTools(registry, { ARDENT_MAGNUS_API_URL: origin, ARDENT_MAGNUS_READ_TOKEN: 'fixture-read-token' });
  return registry;
}
const call = (registry: ToolRegistry, name: string, args: unknown) => registry.call(name, args, 'direct', new AbortController().signal);

describe('ported Magnus owner reads', () => {
  it('sends bounded owner queries and redacts credentials, command text, and output', async () => {
    const { origin, urls } = await fixture(() => [{ id: 'c1', nodeId: 'n1', status: 'COMPLETED', command: 'cat /etc/shadow', args: ['x'], apiToken: 'leak', stdout: 'leak' }]);
    const result = await call(tools('magnus', origin), 'magnus_recent_commands', { node_id: 'n1', hours: 6 });
    expect(urls).toEqual(['GET /api/v1/commands?nodeId=n1&hours=6&pageSize=25']);
    expect(result).toMatchObject({ ok: true, value: { row_count: 1, limit_reached: false, truncated: false,
      data: [{ id: 'c1', command: '[redacted]', args: '[redacted]', apiToken: '[redacted]', stdout: '[redacted]' }] } });
    expect(JSON.stringify(result)).not.toMatch(/etc\/shadow|leak/);
  });

  it('combines two owner reads and derives skill drift without another request shape', async () => {
    const overview = await fixture(url => url.includes('fleet-checks') ? { status: 'ok' } : { nodes: 20 });
    expect(await call(tools('magnus', overview.origin), 'magnus_fleet_overview', {})).toMatchObject({ ok: true,
      value: { data: { stats: { nodes: 20 }, latest_fleet_check: { status: 'ok' } }, sources: [expect.any(String), expect.any(String)] } });
    const drift = await fixture(() => ({ installations: [{ id: 'i1', hostname: 'h', status: 'ok', driftedSkills: ['a'] }, { id: 'i2', driftedSkills: [] }] }));
    expect(await call(tools('magnus', drift.origin), 'magnus_skill_assignment_drift', {})).toMatchObject({ ok: true,
      value: { data: { drifted_installations: 1, installations: [{ installation_id: 'i1', skills: ['a'] }] } } });
  });

  it('filters installations locally and rejects unknown or unsafe arguments', async () => {
    const { origin, urls } = await fixture(() => [{ id: 'a', nodeId: 'n1', hostname: 'Node-1.example.com', status: 'ok' }, { id: 'b', nodeId: 'n2', hostname: 'node-2', status: 'not_installed' }]);
    const registry = tools('magnus', origin);
    expect(await call(registry, 'magnus_hermes_installations', { hostname: 'node-1', installed_only: true })).toMatchObject({ ok: true, value: { row_count: 1, data: [{ id: 'a' }] } });
    expect(urls).toEqual(['GET /api/v1/hermes/installations']);
    for (const bad of [{ node_id: '../x' }, { page_size: 1000 }, { extra: true }])
      expect(await call(registry, 'magnus_list_anomalies', bad)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await call(registry, 'magnus_get_node', { node_id: 'a/b' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
  });

  it('accepts the bare active-alert list only for that route and reports list totals', async () => {
    const bare = await fixture(() => undefined);
    bare.server.removeAllListeners('request');
    bare.server.on('request', (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url?.includes('/alerts/') ? { violations: [{ id: 'a1' }], total: 7 }
        : { success: true, data: [{ id: 'n1' }], meta: { total: 40, page: 1 } }));
    });
    const registry = tools('magnus', bare.origin);
    expect(await call(registry, 'magnus_active_alerts', {})).toMatchObject({ ok: true, value: { row_count: 1, data: [{ id: 'a1' }] } });
    expect(await call(registry, 'magnus_list_nodes', { page_size: 1 })).toMatchObject({ ok: true, value: { row_count: 1, total_available: 40, limit_reached: true } });
    // A bare body from any other route is still refused.
    bare.server.removeAllListeners('request');
    bare.server.on('request', (_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ violations: [], total: 0 })); });
    expect(await call(registry, 'magnus_wazuh_fleet_status', {})).toMatchObject({ ok: false, effect: 'none' });
  });

  it('flags a truncated projection instead of presenting it as complete', () => {
    const projected = boundOwnerData(Array.from({ length: 250 }, (_, index) => ({ index })));
    expect(projected).toMatchObject({ truncated: true });
    expect((projected.data as unknown[]).length).toBe(100);
    expect(boundOwnerData({ ok: 'x'.repeat(2_000) }).truncated).toBe(true);
  });
});

describe('gateway lock recovery', () => {
  it('replaces a lock left by a dead process but refuses a live or malformed owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ardent-lock-'));
    const path = join(dir, 'gateway.lock');
    await writeFile(path, '2147483646', { mode: 0o600 });
    const lock = await acquireGatewayLock(path);
    // The PID is published atomically with the lock; it is never observable empty.
    expect(await readFile(path, 'utf8')).toBe(String(process.pid));
    await expect(acquireGatewayLock(path)).rejects.toThrow('already owned by a gateway');
    await lock.release();
    await expect(readFile(path, 'utf8')).rejects.toThrow();
    await writeFile(path, 'not-a-pid');
    await expect(acquireGatewayLock(path)).rejects.toThrow('already owned by a gateway');
    await writeFile(path, '');
    await expect(acquireGatewayLock(path)).rejects.toThrow('already owned by a gateway');
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('releases only the lock it published', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ardent-lock-'));
    const path = join(dir, 'gateway.lock');
    const lock = await createLockFile(path);
    await rm(path);
    await writeFile(path, '2147483646', { mode: 0o600 });
    await lock.release();
    expect(await readFile(path, 'utf8')).toBe('2147483646');
  });
});
