import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ToolRegistry } from '../src/tools.js';
import { magnusFleetReadinessTool } from '../src/magnus-readiness.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

async function fixture(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return `http://127.0.0.1:${address.port}/`;
}

function registry(origin: string, token = 'fixture-read-token') {
  const tools = new ToolRegistry();
  tools.register(magnusFleetReadinessTool({ ARDENT_MAGNUS_API_URL: origin, ARDENT_MAGNUS_READ_TOKEN: token }));
  return tools;
}

describe('Magnus owner readiness adapter', () => {
  it('uses an authenticated owner read and projects stale posture without credentials or raw metadata', async () => {
    const paths: string[] = [];
    const origin = await fixture((request, response) => {
      paths.push(`${request.method} ${request.url}`);
      expect(request.headers.authorization).toBe('Bearer fixture-read-token');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, data: {
        generatedAt: new Date().toISOString(), thresholds: { staleNodeMs: 120000 },
        expectedFingerprints: { apiSecret: 'must-not-return' },
        nodes: [
          { id: 'node-1', name: 'Magnus', hostname: 'magnus.example', operationalStatus: 'ONLINE',
            heartbeatAgeMs: 5000, stale: false, secretFingerprint: { expectedNodeManagerSecret: 'must-not-return' },
            health: { timestamp: new Date().toISOString(), cpuUsagePercent: 12.5, memoryPercent: 32,
              diskWarnings: [{ mountPoint: '/secret/path', usagePercent: 90 }] } },
          { id: 'node-2', name: 'Node 2', hostname: 'node-2.example.com', operationalStatus: 'STALE',
            heartbeatAgeMs: null, stale: true, health: null },
          { id: '__control-api__', name: 'Control API', hostname: null, operationalStatus: 'STALE',
            heartbeatAgeMs: null, stale: true, health: null },
          { id: '__dashboard__', name: 'Dashboard', hostname: null, operationalStatus: 'STALE',
            heartbeatAgeMs: null, stale: true, health: null },
        ] } }));
    });
    const result = await registry(origin).call('magnus_fleet_readiness', {}, 'direct', new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { node_count: 2, stale_count: 1, stale_threshold_ms: 120000,
      nodes: [{ node_id: 'node-1', health_snapshot_at: expect.any(String), disk_warning_count: 1 },
        { node_id: 'node-2', stale: true, heartbeat_age_ms: null }] } });
    expect(JSON.stringify(result)).not.toContain('must-not-return');
    expect(JSON.stringify(result)).not.toContain('/secret/path');
    expect(JSON.stringify(result)).not.toContain('__control-api__');
    expect(JSON.stringify(result)).not.toContain('__dashboard__');
    expect(paths).toEqual(['GET /api/v1/ops/readiness']);
  });

  it('fails closed on stale, duplicate, oversized, redirected, or malformed owner observations', async () => {
    let body: unknown = { success: true, data: { generatedAt: new Date(Date.now() - 120000).toISOString(),
      thresholds: { staleNodeMs: 120000 }, nodes: [] } };
    let redirect = false;
    const origin = await fixture((_request, response) => {
      if (redirect) { response.writeHead(302, { Location: 'https://example.invalid/' }); response.end(); return; }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body));
    });
    const tools = registry(origin);
    const call = () => tools.call('magnus_fleet_readiness', {}, 'peer', new AbortController().signal);
    expect(await call()).toMatchObject({ ok: false, code: 'SOURCE_OBSERVATION_STALE', effect: 'none' });
    const node = { id: 'duplicate', name: 'Node', hostname: null, operationalStatus: 'ONLINE', heartbeatAgeMs: 0, stale: false, health: null };
    body = { success: true, data: { generatedAt: new Date().toISOString(), thresholds: { staleNodeMs: 120000 }, nodes: [node, node] } };
    expect(await call()).toMatchObject({ ok: false, code: 'SOURCE_IDENTITY_MISMATCH' });
    body = { success: true, data: { generatedAt: new Date().toISOString(), thresholds: { staleNodeMs: 120000 },
      nodes: Array.from({ length: 101 }, (_, i) => ({ ...node, id: `node-${i}` })) } };
    expect(await call()).toMatchObject({ ok: false });
    body = { success: true, data: { generatedAt: new Date().toISOString(), thresholds: { staleNodeMs: 120000 }, nodes: [{ ...node, stale: 'false' }] } };
    expect(await call()).toMatchObject({ ok: false });
    redirect = true;
    expect(await call()).toMatchObject({ ok: false, code: 'SERVICE_READ_FAILED' });
  });

  it('rejects unsafe bearer destinations and missing bindings before any fetch', async () => {
    expect(await registry('http://192.0.2.1/').call('magnus_fleet_readiness', {}, 'direct', new AbortController().signal))
      .toMatchObject({ ok: false, code: 'INVALID_SERVICE_BINDING' });
    expect(await registry('https://user:pass@owner.example/').call('magnus_fleet_readiness', {}, 'direct', new AbortController().signal))
      .toMatchObject({ ok: false, code: 'INVALID_SERVICE_BINDING' });
    expect(await registry('').call('magnus_fleet_readiness', {}, 'direct', new AbortController().signal))
      .toMatchObject({ ok: false, code: 'SERVICE_BINDING_UNAVAILABLE' });
  });
});
