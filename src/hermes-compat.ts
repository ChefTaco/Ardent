import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArdentConfig } from './config.js';
import { z } from 'zod';
import { pluginContext } from './plugins.js';
import type { ArdentRuntime } from './runtime.js';

/**
 * Optional Hermes Agent team-card compatibility (`a2a.hermes_compat: true`).
 * The card describes this profile's registered peer-callable tools so a Hermes
 * team router can discover it. It reports configuration only; it never grants
 * authority and never claims backend readiness.
 */
const unknown = () => ({ status: 'unknown', reason: 'no-live-backend-verification', checkedAt: null, expiresAt: null });
const unavailable = (reason: string) => ({ status: 'unavailable', reason, checkedAt: null, expiresAt: null });

async function digestRuntimeSource(): Promise<string> {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const entries = (await readdir(import.meta.dirname)).filter(name => name.endsWith(ext)).sort();
  const hash = createHash('sha256');
  for (const name of entries) hash.update(name).update('\0').update(await readFile(join(import.meta.dirname, name))).update('\0');
  return hash.digest('hex');
}

async function digestModules(names: string[]): Promise<string> {
  const hash = createHash('sha256');
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  for (const name of names) hash.update(name).update('\0').update(await readFile(join(import.meta.dirname, `${name}${ext}`))).update('\0');
  return hash.digest('hex');
}

function toolset(name: string): string {
  const prefix = /^([a-z][a-z0-9]*)_/.exec(name)?.[1];
  return prefix ?? 'tools';
}

export type HermesTeamCard = { description: string; metadata: { hermesTeam: object };
  skills: Array<{ id: string; name: string; description: string; tags: string[] }> };

function isRuntime(value: Pick<ArdentRuntime, 'tools'>): value is ArdentRuntime { return 'store' in value && 'profileDir' in value && 'plugins' in value; }

export async function hermesTeamCard(runtime: Pick<ArdentRuntime, 'tools'> & Partial<Pick<ArdentRuntime, 'plugins' | 'config' | 'profileDir'>>, config: ArdentConfig, env: NodeJS.ProcessEnv = process.env): Promise<HermesTeamCard> {
  const now = Math.floor(Date.now() / 1000);
  const description = config.a2a.skill?.description ?? `${config.name}: bounded tasks with this profile's registered tools`;
  const grouped = new Map<string, string[]>();
  for (const tool of runtime.tools.list('peer')) grouped.set(toolset(tool.name), [...(grouped.get(toolset(tool.name)) ?? []), tool.name]);
  const toolsets = [
    { id: 'hermes-team', configured: true, registration: 'missing', registeredTools: [], taskConditionalTools: [],
      authorization: 'accepted-task-policy', actionClasses: ['observe', 'analyze', 'create_artifact'], sideEffectClasses: ['scoped-task-artifacts'],
      deliverables: ['validated specialist result', 'task evidence', 'scoped artifact'], deliverableStatus: 'domain-contract-not-a-readiness-claim',
      backend: unavailable('no-peer-callable-generic-tool') },
    ...[...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([id, tools]) => ({ id, configured: true, registration: 'registered',
      registeredTools: tools, taskConditionalTools: tools, authorization: 'accepted-task-policy', actionClasses: ['observe', 'analyze'],
      sideEffectClasses: ['read-only-observation'], deliverables: [`${id} observation`],
      deliverableStatus: 'domain-contract-not-a-readiness-claim', backend: unknown() }))
  ];
  const skills = toolsets.filter(entry => entry.taskConditionalTools.length).map(entry => ({ id: `toolset.${entry.id}`, name: entry.id,
    description: `Task-conditional tools; backend readiness must be checked: ${entry.taskConditionalTools.join(', ')}`,
    tags: [entry.id, 'task-conditional'] }));
  const sourceDigest = await digestRuntimeSource();
  const taskPolicyDigest = await digestModules(['a2a', 'a2a-client', 'a2a-idempotency', 'a2a-peers', 'runtime', 'team-contract', 'tools']);
  const card: HermesTeamCard = { description, skills, metadata: { hermesTeam: {
    schemaVersion: '1.0', missionContractVersions: ['1.0'], coordinationProtocolVersions: [],
    lifecycleProtocolVersions: ['1.0'], missionControlScopes: [], taskExecutionBoundaryVersion: '1.0',
    genericSurfacePolicyVersion: '1.0', sourceDigest, role: config.profile,
    capabilityEvidence: 'ardent-registered-read-only-tools', backendVerification: 'not-reported',
    actionAuthorization: 'not-granted-by-card',
    roleContractDigest: createHash('sha256').update(JSON.stringify([config.profile, description, toolsets.map(entry => entry.registeredTools)])).digest('hex'),
    taskPolicyDigest, runtimeKind: 'ardent', discovery: { schemaVersion: '1.0', observedAt: now, expiresAt: now + 300,
      registryStatus: 'observed', configurationStatus: 'observed', toolsets }
  } } };
  const configured = runtime.plugins?.filter(plugin => plugin.teamCard) ?? [];
  if (configured.length > 1) throw new Error('Multiple plugins own the team card');
  const plugin = configured[0];
  if (!plugin?.teamCard) return card;
  // A real runtime supplies this context; tools-only callers retain the default card.
  if (!isRuntime(runtime)) throw new Error('A plugin team card requires the selected runtime');
  const custom = await plugin.teamCard(pluginContext(runtime, env), card);
  if (Buffer.byteLength(JSON.stringify(custom)) > 64_000) throw new Error('Plugin team card exceeds 64 KiB');
  return z.object({ description: z.string().min(1).max(1000), metadata: z.object({ hermesTeam: z.record(z.string(), z.json()) }).strict(),
    skills: z.array(z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(100), description: z.string().min(1).max(1000), tags: z.array(z.string().max(100)).max(32) }).strict()).max(64) }).strict().parse(custom);
}
