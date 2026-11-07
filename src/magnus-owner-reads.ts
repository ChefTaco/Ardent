/** Read-only Magnus Control API observations ported from the retired Hermes `magnus` plugin. No command, log-query, or remediation authority. */
import { z } from 'zod';
import { defineTool, type Tool } from './tools.js';
import { ownerReadOutput, ownerReadResult, readOwnedApi, withQuery, type OwnerReadOutput } from './owner-read.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const bounded = (min: number, max: number) => z.number().int().min(min).max(max);
const text = z.string().min(1).max(200);
const API = '/api/v1';

interface Spec {
  name: string; description: string;
  input: z.ZodObject<z.ZodRawShape>;
  /** Node-scoped tools also accept an exact `magnus:node:<id>` mission resource. */
  node?: boolean;
  paths(input: Record<string, unknown>): string[];
  /** The owner route returns its list without the `success` envelope. */
  bare?: boolean;
  combine?(values: unknown[], input: Record<string, unknown>): unknown;
  rowLimit?(input: Record<string, unknown>): number | undefined;
}

const str = (input: Record<string, unknown>, key: string): string | undefined => typeof input[key] === 'string' ? input[key] : undefined;
const num = (input: Record<string, unknown>, key: string): number | undefined => typeof input[key] === 'number' ? input[key] : undefined;

const fleet = (name: string, description: string, path: string): Spec =>
  ({ name, description, input: z.object({}).strict(), paths: () => [`${API}/${path}`] });

const specs: Spec[] = [
  { name: 'magnus_fleet_overview', description: 'Read Magnus fleet statistics and the latest fleet check run.', input: z.object({}).strict(),
    paths: () => [`${API}/stats/overview`, `${API}/fleet-checks/latest`],
    combine: values => ({ stats: values[0], latest_fleet_check: values[1] }) },
  fleet('magnus_codex_fleet_status', 'Read cached per-installation Codex versions, available updates, and ChatGPT OAuth state.', 'ops/codex-fleet-status'),
  { name: 'magnus_list_nodes', description: 'List Magnus inventory nodes with optional status, text query, or tag filters.',
    input: z.object({ status: text.optional(), query: text.optional(), tag: text.optional(), page_size: bounded(1, 100).optional() }).strict(),
    paths: input => [withQuery(`${API}/nodes`, { status: str(input, 'status'), query: str(input, 'query'), tag: str(input, 'tag'), pageSize: num(input, 'page_size') ?? 50 })],
    rowLimit: input => num(input, 'page_size') ?? 50 },
  { name: 'magnus_get_node', description: 'Read one Magnus inventory node record.', node: true, input: z.object({ node_id: id }).strict(),
    paths: input => [`${API}/nodes/${str(input, 'node_id')}`] },
  { name: 'magnus_hermes_installations', description: 'List retained Hermes/Ardent installation observations, optionally filtered by status, node, or hostname substring.',
    input: z.object({ status: text.optional(), node_id: id.optional(), hostname: text.optional(), installed_only: z.boolean().optional(), page_size: bounded(1, 100).optional() }).strict(),
    paths: () => [`${API}/hermes/installations`],
    combine: (values, input) => {
      const rows = z.array(z.record(z.string(), z.unknown())).parse(values[0]);
      const host = str(input, 'hostname')?.toLowerCase();
      return rows.filter(row => (!str(input, 'status') || row['status'] === str(input, 'status')) &&
        (!str(input, 'node_id') || row['nodeId'] === str(input, 'node_id')) &&
        (!host || String(row['hostname'] ?? '').toLowerCase().includes(host)) &&
        (input['installed_only'] !== true || row['status'] !== 'not_installed')).slice(0, num(input, 'page_size') ?? 50);
    },
    rowLimit: input => num(input, 'page_size') ?? 50 },
  { name: 'magnus_hermes_installation', description: 'Read one retained Hermes/Ardent installation observation by exact installation ID.', input: z.object({ installation_id: id }).strict(),
    paths: input => [`${API}/hermes/installations/${str(input, 'installation_id')}`] },
  { name: 'magnus_list_anomalies', description: 'List fleet anomalies, optionally by resolved state, severity, or node.',
    input: z.object({ resolved: z.boolean().optional(), severity: z.enum(['info', 'warning', 'critical']).optional(), node_id: id.optional(), page_size: bounded(1, 100).optional() }).strict(),
    paths: input => [withQuery(`${API}/anomalies`, { resolved: typeof input['resolved'] === 'boolean' ? input['resolved'] : undefined, severity: str(input, 'severity'), nodeId: str(input, 'node_id'), pageSize: num(input, 'page_size') ?? 25 })],
    rowLimit: input => num(input, 'page_size') ?? 25 },
  { name: 'magnus_fleet_check_runs', description: 'List recent Magnus fleet check runs.', input: z.object({ kind: text.optional(), limit: bounded(1, 100).optional() }).strict(),
    paths: input => [withQuery(`${API}/fleet-checks/runs`, { kind: str(input, 'kind'), limit: num(input, 'limit') ?? 10 })], rowLimit: input => num(input, 'limit') ?? 10 },
  { name: 'magnus_cron_jobs', description: 'List managed cron job observations, optionally for one node.', input: z.object({ node_id: id.optional() }).strict(),
    paths: input => [withQuery(`${API}/cron`, { nodeId: str(input, 'node_id') })] },
  fleet('magnus_dependency_health', 'Read the fleet dependency-health summary.', 'ops/dependency-health'),
  fleet('magnus_wazuh_fleet_status', 'Read the fleet Wazuh agent status summary.', 'nodes/wazuh/summary'),
  fleet('magnus_system_update_status', 'Read the fleet operating-system update status summary.', 'nodes/system-updates/summary'),
  { name: 'magnus_health_history', description: 'Read bounded health snapshot history for one node.', node: true,
    input: z.object({ node_id: id, limit: bounded(1, 500).optional() }).strict(),
    paths: input => [withQuery(`${API}/nodes/${str(input, 'node_id')}/health/history`, { limit: num(input, 'limit') ?? 100 })], rowLimit: input => num(input, 'limit') ?? 100 },
  { name: 'magnus_active_alerts', description: 'List active alert-rule violations, optionally for one node.', input: z.object({ node_id: id.optional(), page_size: bounded(1, 100).optional() }).strict(),
    bare: true, paths: input => [withQuery(`${API}/alerts/violations`, { nodeId: str(input, 'node_id'), status: 'active', pageSize: num(input, 'page_size') ?? 50 })],
    combine: values => z.object({ violations: z.array(z.unknown()), total: z.number().int().nonnegative() }).passthrough().parse(values[0]).violations,
    rowLimit: input => num(input, 'page_size') ?? 50 },
  { name: 'magnus_recent_commands', description: 'List recent Magnus command lifecycle records. Command text, arguments, and output are redacted.',
    input: z.object({ node_id: id.optional(), status: z.enum(['PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED']).optional(), hours: bounded(1, 720).optional(), page_size: bounded(1, 100).optional() }).strict(),
    paths: input => [withQuery(`${API}/commands`, { nodeId: str(input, 'node_id'), status: str(input, 'status'), hours: num(input, 'hours') ?? 24, pageSize: num(input, 'page_size') ?? 25 })],
    rowLimit: input => num(input, 'page_size') ?? 25 },
  { name: 'magnus_audit_events', description: 'List Magnus audit events, optionally by date, action, or actor.',
    input: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), action: text.optional(), actor_id: text.optional(), page_size: bounded(1, 100).optional() }).strict(),
    paths: input => [withQuery(`${API}/audit`, { date: str(input, 'date'), action: str(input, 'action'), actorId: str(input, 'actor_id'), pageSize: num(input, 'page_size') ?? 25 })],
    rowLimit: input => num(input, 'page_size') ?? 25 },
  { name: 'magnus_fleet_timeline', description: 'Read the merged recent fleet event timeline.', input: z.object({ limit: bounded(1, 200).optional() }).strict(),
    paths: input => [withQuery(`${API}/ops/timeline`, { limit: num(input, 'limit') ?? 80 })] },
  { name: 'magnus_incident_summary', description: 'Read an incident summary for a bounded window, optionally for one node.', input: z.object({ node_id: id.optional(), hours: bounded(1, 168).optional() }).strict(),
    paths: input => [withQuery(`${API}/ops/incident-summary`, { nodeId: str(input, 'node_id'), hours: num(input, 'hours') ?? 24 })] },
  fleet('magnus_hermes_effective_state', 'Read effective Hermes/Ardent configuration state per installation.', 'ops/hermes-effective-state'),
  fleet('magnus_package_security_posture', 'Read the fleet package security posture.', 'ops/package-security-posture'),
  { name: 'magnus_correlate_anomalies', description: 'Group anomalies that occurred within a time window.', input: z.object({ window_minutes: bounded(1, 120).optional(), include_resolved: z.boolean().optional() }).strict(),
    paths: input => [withQuery(`${API}/anomalies/correlations`, { windowMinutes: num(input, 'window_minutes') ?? 5, includeResolved: input['include_resolved'] === true })] },
  { name: 'magnus_anomaly_timeline', description: 'Read the anomaly timeline for a bounded window, optionally for one node.', input: z.object({ node_id: id.optional(), hours: bounded(1, 720).optional() }).strict(),
    paths: input => [withQuery(`${API}/anomalies/timeline`, { nodeId: str(input, 'node_id'), hours: num(input, 'hours') ?? 24 })] },
  fleet('magnus_fleet_predictions', 'Read fleet capacity and failure predictions.', 'predictions'),
  { name: 'magnus_node_predictions', description: 'Read capacity and failure predictions for one node.', node: true, input: z.object({ node_id: id }).strict(),
    paths: input => [`${API}/predictions/${str(input, 'node_id')}`] },
  fleet('magnus_skill_catalog', 'Read the Magnus skill catalogue.', 'skills'),
  { name: 'magnus_skill_assignment_drift', description: 'List installations whose assigned skills drift from the catalogue.', input: z.object({}).strict(),
    paths: () => [`${API}/ops/hermes-effective-state`],
    combine: values => {
      const state = z.object({ installations: z.array(z.record(z.string(), z.unknown())).default([]) }).passthrough().parse(values[0]);
      const drifted = state.installations.filter(item => Array.isArray(item['driftedSkills']) && item['driftedSkills'].length > 0)
        .map(item => ({ installation_id: item['id'], hostname: item['hostname'], status: item['status'], skills: item['driftedSkills'] }));
      return { drifted_installations: drifted.length, installations: drifted };
    } }
];

export const MAGNUS_OWNER_READ_TOOLS: ReadonlySet<string> = new Set(specs.map(spec => spec.name));
export const MAGNUS_NODE_OWNER_READ_TOOLS: ReadonlySet<string> = new Set(specs.filter(spec => spec.node).map(spec => spec.name));

export function magnusOwnerReadTools(env: NodeJS.ProcessEnv): Tool[] {
  return specs.map(spec => defineTool({
    name: spec.name, description: `${spec.description} Owner observation only; it authorizes no command, deployment, or remediation.`,
    input: spec.input, output: ownerReadOutput, effect: 'read', contexts: ['direct', 'peer'], timeoutMs: 20_000,
    handler: async (input, signal): Promise<OwnerReadOutput> => {
      const request = input as Record<string, unknown>;
      const reads = await Promise.all(spec.paths(request).map(path => readOwnedApi('ARDENT_MAGNUS_API_URL', 'ARDENT_MAGNUS_READ_TOKEN', path, env, signal, {}, undefined, spec.bare === true)));
      const data = spec.combine ? spec.combine(reads.map(read => read.value), request) : reads[0]?.value;
      return ownerReadResult(reads, data, spec.rowLimit?.(request));
    }
  }));
}
