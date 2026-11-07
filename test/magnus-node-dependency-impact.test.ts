import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { ToolRegistry } from '../src/tools.js';
import { magnusNodeDependencyImpactTool } from '../src/magnus-node-dependency-impact.js';

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
  tools.register(magnusNodeDependencyImpactTool({ ARDENT_MAGNUS_API_URL: origin, ARDENT_MAGNUS_READ_TOKEN: token }));
  return tools;
}

const graph = () => ({
  discoveredAt: new Date().toISOString(), status: 'complete',
  nodes: [
    { id: 'magnus', name: 'Magnus', ip: 'must-not-return-ip', services: [{ process: 'must-not-return-process' }],
      collection: { status: 'pass', observedAt: new Date().toISOString(), reason: null } },
    { id: 'hive', name: 'Hive', ip: 'must-not-return-ip',
      collection: { status: 'pass', observedAt: new Date().toISOString(), reason: null } },
    { id: 'node-3', name: 'Node 3', ip: 'must-not-return-ip',
      collection: { status: 'pass', observedAt: new Date().toISOString(), reason: null } },
  ],
  edges: [
    { from: 'magnus', to: 'hive', fromPort: 50000, toPort: 443, service: 'https', connectionCount: 2 },
    { from: 'node-3', to: 'magnus', fromPort: 50001, toPort: 4000, service: 'magnus-api', connectionCount: 1 },
  ],
});

describe('Magnus exact-node dependency impact adapter', () => {
  it('binds an authenticated owner read and returns only observed edges with an exact response digest', async () => {
    const paths: string[] = [];
    const body = JSON.stringify({ success: true, data: graph() });
    const origin = await fixture((request, response) => {
      paths.push(`${request.method} ${request.url}`);
      expect(request.headers.authorization).toBe('Bearer fixture-read-token');
      response.setHeader('Content-Type', 'application/json');
      response.end(body);
    });
    const result = await registry(origin).call('magnus_node_dependency_impact', { node_id: 'magnus' }, 'peer', new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: {
      node_id: 'magnus', graph_status: 'complete', coverage: 'observed',
      owner_response_sha256: createHash('sha256').update(body).digest('hex'),
      depends_on: [{ node_id: 'hive', service: 'https', observed_connection_count: 2 }],
      dependents: [{ node_id: 'node-3', service: 'magnus-api', observed_connection_count: 1 }],
    } });
    expect(paths).toEqual(['GET /api/v1/dependencies']);
    expect(JSON.stringify(result)).not.toContain('must-not-return');
    expect(JSON.stringify(result)).not.toContain('50000');
  });

  it('labels incomplete collection without exposing raw collection error text', async () => {
    const data = graph();
    data.status = 'partial';
    data.nodes[0]!.collection.status = 'unknown';
    data.nodes[0]!.collection.reason = 'private host address and token must-not-return';
    const origin = await fixture((_request, response) => response.end(JSON.stringify({ success: true, data })));
    const result = await registry(origin).call('magnus_node_dependency_impact', { node_id: 'magnus' }, 'direct', new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { coverage: 'partial', node_collection_status: 'unknown',
      node_collection_gap: 'collection_unavailable' } });
    expect(JSON.stringify(result)).not.toContain('must-not-return');
  });

  it('fails closed on stale, ambiguous, malformed, or redirected graph observations', async () => {
    let data = graph();
    let redirect = false;
    const origin = await fixture((_request, response) => {
      if (redirect) { response.writeHead(302, { Location: 'https://example.invalid/' }); response.end(); return; }
      response.end(JSON.stringify({ success: true, data }));
    });
    const call = (node_id = 'magnus') => registry(origin).call('magnus_node_dependency_impact', { node_id }, 'peer', new AbortController().signal);
    data.discoveredAt = new Date(Date.now() - 660_000).toISOString();
    expect(await call()).toMatchObject({ ok: false, code: 'SOURCE_OBSERVATION_STALE', effect: 'none' });
    data = graph(); data.nodes.push(data.nodes[0]!);
    expect(await call()).toMatchObject({ ok: false, code: 'SOURCE_IDENTITY_MISMATCH', effect: 'none' });
    data = graph(); data.edges[0]!.to = 'absent';
    expect(await call()).toMatchObject({ ok: false, code: 'SOURCE_IDENTITY_MISMATCH', effect: 'none' });
    data = graph();
    expect(await call('not-in-graph')).toMatchObject({ ok: false, code: 'SOURCE_NODE_UNAVAILABLE', effect: 'none' });
    redirect = true;
    expect(await call()).toMatchObject({ ok: false, code: 'SERVICE_READ_FAILED', effect: 'none' });
  });

  it('rejects unsafe destinations and an invalid or over-broad node ID', async () => {
    expect(await registry('http://192.0.2.1/').call('magnus_node_dependency_impact', { node_id: 'magnus' }, 'direct', new AbortController().signal))
      .toMatchObject({ ok: false, code: 'INVALID_SERVICE_BINDING' });
    expect(await registry('https://user:pass@owner.example/').call('magnus_node_dependency_impact', { node_id: 'magnus' }, 'direct', new AbortController().signal))
      .toMatchObject({ ok: false, code: 'INVALID_SERVICE_BINDING' });
    expect(await registry('').call('magnus_node_dependency_impact', { node_id: 'magnus' }, 'direct', new AbortController().signal))
      .toMatchObject({ ok: false, code: 'SERVICE_BINDING_UNAVAILABLE' });
    expect(await registry('http://127.0.0.1/').call('magnus_node_dependency_impact', { node_id: '../other' }, 'direct', new AbortController().signal))
      .toMatchObject({ ok: false, code: 'INVALID_ARGUMENT', effect: 'none' });
  });
});
