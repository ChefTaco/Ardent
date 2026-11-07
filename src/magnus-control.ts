import { z } from 'zod';
import { defineTool, type ToolRegistry } from './tools.js';
import { magnusFleetReadinessTool } from './magnus-readiness.js';
import { magnusNodeDependencyImpactTool } from './magnus-node-dependency-impact.js';
import { readOwnedApi } from './owner-read.js';
import { magnusOwnerReadTools } from './magnus-owner-reads.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const node = z.object({ id: z.string(), name: z.string(), hostname: z.string().nullable().optional(), status: z.string() }).passthrough();
const count = z.number().int().nonnegative();
const anomalySummary = z.object({
  totalActive: count,
  byNode: z.array(z.object({ nodeId: id, nodeName: z.string().max(160), count, metrics: z.array(z.string().max(80)).max(16) }).passthrough()).max(100),
  bySeverity: z.object({ info: count, warning: count, critical: count }).passthrough()
}).passthrough();
const commandStatus = z.object({
  id, nodeId: id,
  status: z.enum(['PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED']),
  createdAt: z.string().datetime(), startedAt: z.string().datetime().nullable(), completedAt: z.string().datetime().nullable(),
  result: z.object({ exitCode: z.number().int(), durationMs: count, truncated: z.boolean() }).passthrough().nullable()
}).passthrough();
// The owning agent reports health with its 30-second heartbeat. This matches
// the Control API's default stale-node threshold, but is a tool-local label:
// an operator may configure a different server-side threshold.
const HEALTH_FRESHNESS_LIMIT_MS = 120_000;
const HEALTH_FUTURE_SKEW_MS = 5_000;


/** Optional read-only Magnus Control tools. The base URL and token come from the environment only. */
export function registerMagnusControlTools(registry: ToolRegistry, env: NodeJS.ProcessEnv): void {
  registry.register(magnusFleetReadinessTool(env));
  registry.register(magnusNodeDependencyImpactTool(env));
  for (const tool of magnusOwnerReadTools(env)) registry.register(tool);
  registry.register(defineTool({
    name: 'magnus_fleet_inventory', description: 'Read bounded fleet inventory from the owning Magnus Control API. Observations do not authorize commands or remediation.',
    input: z.object({}).strict(),
    output: z.object({ source: z.string().url(), source_date: z.string().datetime().nullable(), observed_at: z.string().datetime(), nodes: z.array(z.object({ id: z.string(), name: z.string(), hostname: z.string().nullable(), status: z.string() }).strict()).max(100) }).strict(),
    effect: 'read', contexts: ['direct', 'peer'], timeoutMs: 15_000,
    handler: async (_input, signal) => {
      const { value, source, sourceDate } = await readOwnedApi('ARDENT_MAGNUS_API_URL', 'ARDENT_MAGNUS_READ_TOKEN', '/api/v1/nodes', env, signal);
      const nodes = z.array(node).max(100).parse(value);
      return { source, source_date: sourceDate, observed_at: new Date().toISOString(), nodes: nodes.map(item => ({ id: item.id, name: item.name, hostname: item.hostname ?? null, status: item.status })) };
    }
  }));
  registry.register(defineTool({
    name: 'magnus_node_health', description: 'Read the latest retained Magnus health snapshot for one inventory node with an explicit freshness label. A stale snapshot is historical evidence, not current health. This does not authorize a node command.',
    input: z.object({ node_id: id }).strict(),
    output: z.object({ source: z.string().url(), source_date: z.string().datetime().nullable(), observed_at: z.string().datetime(), node_id: id,
      snapshot_at: z.string().datetime().nullable(), snapshot_age_ms: z.number().int().nullable(),
      snapshot_freshness: z.enum(['fresh', 'stale', 'future', 'missing']), freshness_limit_ms: z.literal(HEALTH_FRESHNESS_LIMIT_MS),
      cpu_usage_percent: z.number().nullable(), memory_percent: z.number().nullable() }).strict(),
    effect: 'read', contexts: ['direct', 'peer'], timeoutMs: 15_000,
    handler: async ({ node_id }, signal) => {
      const { value, source, sourceDate } = await readOwnedApi('ARDENT_MAGNUS_API_URL', 'ARDENT_MAGNUS_READ_TOKEN', `/api/v1/nodes/${node_id}/health`, env, signal);
      const data = z.object({ nodeId: z.string().optional(), timestamp: z.string().datetime().optional(), cpuUsagePercent: z.number().nullable().optional(), memoryPercent: z.number().nullable().optional() }).passthrough().parse(value);
      if (data.nodeId && data.nodeId !== node_id) throw Object.assign(new Error('Health snapshot node identity differs from the request'), { code: 'SOURCE_IDENTITY_MISMATCH' });
      const observedAt = Date.now();
      const snapshotAgeMs = data.timestamp ? observedAt - Date.parse(data.timestamp) : null;
      const snapshotFreshness: 'fresh' | 'stale' | 'future' | 'missing' = snapshotAgeMs === null ? 'missing' : snapshotAgeMs < -HEALTH_FUTURE_SKEW_MS ? 'future'
        : snapshotAgeMs > HEALTH_FRESHNESS_LIMIT_MS ? 'stale' : 'fresh';
      return { source, source_date: sourceDate, observed_at: new Date(observedAt).toISOString(), node_id,
        snapshot_at: data.timestamp ?? null, snapshot_age_ms: snapshotAgeMs,
        snapshot_freshness: snapshotFreshness, freshness_limit_ms: HEALTH_FRESHNESS_LIMIT_MS as 120_000,
        cpu_usage_percent: data.cpuUsagePercent ?? null, memory_percent: data.memoryPercent ?? null };
    }
  }));
  registry.register(defineTool({
    name: 'magnus_anomaly_summary', description: 'Read bounded active fleet anomaly counts and affected nodes from Magnus. This is an observation, not remediation authority.',
    input: z.object({}).strict(),
    output: z.object({ source: z.string().url(), source_date: z.string().datetime().nullable(), observed_at: z.string().datetime(),
      total_active: count, by_severity: z.object({ info: count, warning: count, critical: count }).strict(),
      nodes: z.array(z.object({ node_id: id, node_name: z.string().max(160), count, metrics: z.array(z.string().max(80)).max(16) }).strict()).max(100) }).strict(),
    effect: 'read', contexts: ['direct', 'peer'], timeoutMs: 15_000,
    handler: async (_input, signal) => {
      const { value, source, sourceDate } = await readOwnedApi('ARDENT_MAGNUS_API_URL', 'ARDENT_MAGNUS_READ_TOKEN', '/api/v1/anomalies/summary', env, signal);
      const data = anomalySummary.parse(value);
      return { source, source_date: sourceDate, observed_at: new Date().toISOString(), total_active: data.totalActive,
        by_severity: { info: data.bySeverity.info, warning: data.bySeverity.warning, critical: data.bySeverity.critical },
        nodes: data.byNode.map(item => ({ node_id: item.nodeId, node_name: item.nodeName, count: item.count, metrics: item.metrics })) };
    }
  }));
  registry.register(defineTool({
    name: 'magnus_command_status', description: 'Read one Magnus command lifecycle status by exact ID. Command text, arguments, environment, and output are excluded.',
    input: z.object({ command_id: id }).strict(),
    output: z.object({ source: z.string().url(), source_date: z.string().datetime().nullable(), observed_at: z.string().datetime(),
      command_id: id, node_id: id, status: commandStatus.shape.status,
      created_at: z.string().datetime(), started_at: z.string().datetime().nullable(), completed_at: z.string().datetime().nullable(),
      exit_code: z.number().int().nullable(), duration_ms: count.nullable(), result_truncated: z.boolean().nullable() }).strict(),
    effect: 'read', contexts: ['direct', 'peer'], timeoutMs: 15_000,
    handler: async ({ command_id }, signal) => {
      const { value, source, sourceDate } = await readOwnedApi('ARDENT_MAGNUS_API_URL', 'ARDENT_MAGNUS_READ_TOKEN', `/api/v1/commands/${command_id}`, env, signal);
      const data = commandStatus.parse(value);
      if (data.id !== command_id) throw Object.assign(new Error('Command identity differs from the request'), { code: 'SOURCE_IDENTITY_MISMATCH' });
      return { source, source_date: sourceDate, observed_at: new Date().toISOString(), command_id: data.id, node_id: data.nodeId,
        status: data.status, created_at: data.createdAt, started_at: data.startedAt, completed_at: data.completedAt,
        exit_code: data.result?.exitCode ?? null, duration_ms: data.result?.durationMs ?? null, result_truncated: data.result?.truncated ?? null };
    }
  }));
}
