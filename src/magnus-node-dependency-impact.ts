/** Exact-node projection of the owning Control API's observed dependency graph. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from './tools.js';

const nodeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const count = z.number().int().nonnegative();
const graph = z.object({
  discoveredAt: z.string().datetime(),
  status: z.enum(['complete', 'partial']),
  nodes: z.array(z.object({
    id: nodeId,
    name: z.string().min(1).max(160),
    collection: z.object({
      status: z.enum(['pass', 'unknown']),
      observedAt: z.string().datetime(),
      reason: z.string().nullable(),
    }).passthrough(),
  }).passthrough()).max(100),
  edges: z.array(z.object({
    from: nodeId,
    to: nodeId,
    service: z.string().min(1).max(160),
    connectionCount: count,
  }).passthrough()).max(2_000),
}).passthrough();

const relatedNode = z.object({ node_id: nodeId, name: z.string(), service: z.string(),
  observed_connection_count: count, collection_status: z.enum(['pass', 'unknown']) }).strict();
const output = z.object({
  source: z.string().url(), source_date: z.string().datetime().nullable(), observed_at: z.string().datetime(),
  owner_response_sha256: z.string().regex(/^[a-f0-9]{64}$/), graph_discovered_at: z.string().datetime(),
  graph_status: z.enum(['complete', 'partial']), node_id: nodeId, node_name: z.string(),
  node_collection_status: z.enum(['pass', 'unknown']), node_collection_observed_at: z.string().datetime(),
  node_collection_gap: z.string().nullable(), coverage: z.enum(['observed', 'partial']),
  depends_on: z.array(relatedNode).max(2_000), dependents: z.array(relatedNode).max(2_000),
}).strict();

function ownerUrl(env: NodeJS.ProcessEnv): { url: URL; token: string } {
  const base = env.ARDENT_MAGNUS_API_URL;
  const token = env.ARDENT_MAGNUS_READ_TOKEN;
  if (!base || !token) throw Object.assign(new Error('Magnus read-only service binding is unavailable'), { code: 'SERVICE_BINDING_UNAVAILABLE' });
  let url: URL;
  try { url = new URL(base); } catch { throw Object.assign(new Error('Invalid Magnus service origin'), { code: 'INVALID_SERVICE_BINDING' }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    throw Object.assign(new Error('Magnus bearer token requires an HTTPS origin outside loopback'), { code: 'INVALID_SERVICE_BINDING' });
  url.pathname = '/api/v1/dependencies';
  return { url, token };
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  if (!response.ok) throw Object.assign(new Error(`Magnus dependency graph returned HTTP ${response.status}`), { code: 'SERVICE_READ_FAILED' });
  if (Number(response.headers.get('content-length') ?? 0) > 512_000)
    throw Object.assign(new Error('Magnus dependency graph exceeds limit'), { code: 'SERVICE_RESPONSE_TOO_LARGE' });
  if (!response.body) throw Object.assign(new Error('Magnus dependency graph has no body'), { code: 'SERVICE_READ_FAILED' });
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 512_000) {
        await reader.cancel();
        throw Object.assign(new Error('Magnus dependency graph exceeds limit'), { code: 'SERVICE_RESPONSE_TOO_LARGE' });
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

async function readNodeImpact(env: NodeJS.ProcessEnv, requestedNodeId: string, signal: AbortSignal) {
  const { url, token } = ownerUrl(env);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal, redirect: 'manual' });
  const raw = await readBoundedResponse(response);
  const data = z.object({ success: z.literal(true), data: graph }).passthrough()
    .parse(JSON.parse(raw.toString('utf8')) as unknown).data;
  const now = Date.now();
  const discovered = Date.parse(data.discoveredAt);
  if (discovered < now - 630_000 || discovered > now + 5_000)
    throw Object.assign(new Error('Magnus dependency observation is stale or future dated'), { code: 'SOURCE_OBSERVATION_STALE' });
  const nodes = new Map(data.nodes.map(item => [item.id, item]));
  if (nodes.size !== data.nodes.length)
    throw Object.assign(new Error('Magnus dependency graph contains duplicate node IDs'), { code: 'SOURCE_IDENTITY_MISMATCH' });
  const requested = nodes.get(requestedNodeId);
  if (!requested) throw Object.assign(new Error('Requested node is absent from the observed dependency graph'), { code: 'SOURCE_NODE_UNAVAILABLE' });
  if (data.edges.some(item => !nodes.has(item.from) || !nodes.has(item.to)))
    throw Object.assign(new Error('Magnus dependency graph contains an unknown node reference'), { code: 'SOURCE_IDENTITY_MISMATCH' });
  const project = (relatedId: string, service: string, connections: number) => {
    const related = nodes.get(relatedId)!;
    return { node_id: related.id, name: related.name, service,
      observed_connection_count: connections, collection_status: related.collection.status };
  };
  const sort = (a: z.infer<typeof relatedNode>, b: z.infer<typeof relatedNode>) =>
    a.node_id.localeCompare(b.node_id) || a.service.localeCompare(b.service);
  const dependsOn = data.edges.filter(item => item.from === requestedNodeId)
    .map(item => project(item.to, item.service, item.connectionCount)).sort(sort);
  const dependents = data.edges.filter(item => item.to === requestedNodeId)
    .map(item => project(item.from, item.service, item.connectionCount)).sort(sort);
  const sourceDate = response.headers.get('date');
  return output.parse({ source: url.toString(),
    source_date: sourceDate && Number.isFinite(Date.parse(sourceDate)) ? new Date(sourceDate).toISOString() : null,
    observed_at: new Date(now).toISOString(), owner_response_sha256: createHash('sha256').update(raw).digest('hex'),
    graph_discovered_at: data.discoveredAt, graph_status: data.status, node_id: requested.id, node_name: requested.name,
    node_collection_status: requested.collection.status, node_collection_observed_at: requested.collection.observedAt,
    node_collection_gap: requested.collection.status === 'unknown' ? 'collection_unavailable' : null,
    coverage: data.status === 'complete' && requested.collection.status === 'pass' ? 'observed' : 'partial',
    depends_on: dependsOn, dependents });
}

export function magnusNodeDependencyImpactTool(env: NodeJS.ProcessEnv) {
  return defineTool({ name: 'magnus_node_dependency_impact',
    description: 'Read observed direct dependency edges for one exact Magnus node. Missing or partial collection is explicit; this is not a service inventory, causal proof, or remediation authority.',
    input: z.object({ node_id: nodeId }).strict(), output, effect: 'read', contexts: ['direct', 'peer'], timeoutMs: 15_000,
    handler: async ({ node_id }, signal) => readNodeImpact(env, node_id, signal) });
}
