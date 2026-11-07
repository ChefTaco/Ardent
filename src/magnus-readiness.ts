/** Bounded projection of Magnus-owned fleet readiness; no action authority. */
import { z } from 'zod';
import { defineTool } from './tools.js';

const count = z.number().int().nonnegative();
const node = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  name: z.string().min(1).max(160),
  hostname: z.string().max(253).nullable(),
  operationalStatus: z.string().min(1).max(40),
  heartbeatAgeMs: count.nullable(),
  stale: z.boolean(),
  health: z.object({
    timestamp: z.string().datetime(),
    cpuUsagePercent: z.number().finite().nullable(),
    memoryPercent: z.number().finite().nullable(),
    diskWarnings: z.array(z.object({ mountPoint: z.string(), usagePercent: z.number() }).passthrough()).max(100),
  }).passthrough().nullable(),
}).passthrough();
const readiness = z.object({
  generatedAt: z.string().datetime(),
  thresholds: z.object({ staleNodeMs: count }).passthrough(),
  nodes: z.array(node).max(100),
}).passthrough();
const output = z.object({
  source: z.string().url(), source_date: z.string().datetime().nullable(), observed_at: z.string().datetime(),
  generated_at: z.string().datetime(), stale_threshold_ms: count, node_count: count, stale_count: count,
  nodes: z.array(z.object({
    node_id: z.string(), name: z.string(), hostname: z.string().nullable(),
    operational_status: z.string(), heartbeat_age_ms: count.nullable(), stale: z.boolean(),
    health_snapshot_at: z.string().datetime().nullable(), cpu_usage_percent: z.number().nullable(),
    memory_percent: z.number().nullable(), disk_warning_count: count,
  }).strict()).max(100),
}).strict();

function binding(env: NodeJS.ProcessEnv): { url: URL; token: string } {
  const base = env.ARDENT_MAGNUS_API_URL;
  const token = env.ARDENT_MAGNUS_READ_TOKEN;
  if (!base || !token) throw Object.assign(new Error('Magnus read-only service binding is unavailable'), { code: 'SERVICE_BINDING_UNAVAILABLE' });
  let url: URL;
  try { url = new URL(base); } catch { throw Object.assign(new Error('Invalid Magnus service origin'), { code: 'INVALID_SERVICE_BINDING' }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    throw Object.assign(new Error('Magnus bearer token requires an HTTPS origin outside loopback'), { code: 'INVALID_SERVICE_BINDING' });
  url.pathname = '/api/v1/ops/readiness';
  return { url, token };
}

async function read(env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const { url, token } = binding(env);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal, redirect: 'manual' });
  if (!response.ok) throw Object.assign(new Error(`Magnus readiness returned HTTP ${response.status}`), { code: 'SERVICE_READ_FAILED' });
  if (Number(response.headers.get('content-length') ?? 0) > 512_000)
    throw Object.assign(new Error('Magnus readiness response exceeds limit'), { code: 'SERVICE_RESPONSE_TOO_LARGE' });
  if (!response.body) throw Object.assign(new Error('Magnus readiness response has no body'), { code: 'SERVICE_READ_FAILED' });
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
        throw Object.assign(new Error('Magnus readiness response exceeds limit'), { code: 'SERVICE_RESPONSE_TOO_LARGE' });
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  const parsed = z.object({ success: z.literal(true), data: readiness }).passthrough()
    .parse(JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown).data;
  const observed = Date.now();
  const generated = Date.parse(parsed.generatedAt);
  if (!Number.isFinite(generated) || generated < observed - 60_000 || generated > observed + 5_000)
    throw Object.assign(new Error('Magnus readiness observation is stale or future dated'), { code: 'SOURCE_OBSERVATION_STALE' });
  const ids = new Set(parsed.nodes.map(item => item.id));
  if (ids.size !== parsed.nodes.length)
    throw Object.assign(new Error('Magnus readiness contains duplicate node IDs'), { code: 'SOURCE_IDENTITY_MISMATCH' });
  const date = response.headers.get('date');
  // These records represent service audit actors, not heartbeat-producing hosts.
  // Match only the two reserved IDs; real offline nodes remain in the projection.
  const hosts = parsed.nodes.filter(item => !['__control-api__', '__dashboard__'].includes(item.id));
  return output.parse({ source: url.toString(), source_date: date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null,
    observed_at: new Date(observed).toISOString(), generated_at: parsed.generatedAt,
    stale_threshold_ms: parsed.thresholds.staleNodeMs, node_count: hosts.length,
    stale_count: hosts.filter(item => item.stale).length,
    nodes: hosts.map(item => ({ node_id: item.id, name: item.name, hostname: item.hostname,
      operational_status: item.operationalStatus, heartbeat_age_ms: item.heartbeatAgeMs, stale: item.stale,
      health_snapshot_at: item.health?.timestamp ?? null, cpu_usage_percent: item.health?.cpuUsagePercent ?? null,
      memory_percent: item.health?.memoryPercent ?? null, disk_warning_count: item.health?.diskWarnings.length ?? 0 })) });
}

export function magnusFleetReadinessTool(env: NodeJS.ProcessEnv) {
  return defineTool({ name: 'magnus_fleet_readiness',
    description: 'Read the owning Control API fleet readiness, stale heartbeat posture, and bounded health timestamps. No deployment or remediation authority.',
    input: z.object({}).strict(), output, effect: 'read', contexts: ['direct', 'peer'], timeoutMs: 15_000,
    handler: async (_input, signal) => read(env, signal) });
}
