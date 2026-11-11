import { z } from 'zod';
import type { ArdentRuntime } from './runtime.js';
import type { Task } from './store.js';
import type { TeamEnvelope } from './team-contract.js';
import { pluginContext } from './plugins.js';

const Reference = z.string().min(8).max(1000).regex(/^source:\S+$/);
const Evidence = z.object({
  references: z.array(Reference).max(100),
  artifacts: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), mime: z.string().min(1).max(128), source: z.string().max(1000).optional() }).strict()).max(32),
  citationAliases: z.record(Reference, Reference).optional()
}).strict();

/** Core verifies artifact bytes and grants; a configured plugin validates its own receipt schema. */
export async function collectPluginTeamEvidence(runtime: ArdentRuntime, task: Task, envelope: TeamEnvelope, env: NodeJS.ProcessEnv) {
  const references = new Set<string>(), aliases = new Map<string, string>(), ambiguous = new Set<string>();
  const artifacts: Array<{ name: string; sha256: string; reference: string; mime: string; producer: string; source: string }> = [];
  const events = runtime.store.events(task.id, 0, 500);
  for (const plugin of runtime.plugins) {
    const raw = plugin.teamEvidence?.(pluginContext(runtime, env), task, envelope, events);
    if (raw === undefined) continue;
    const evidence = Evidence.parse(raw);
    for (const reference of evidence.references) references.add(reference);
    if (evidence.artifacts.length && !envelope.mission.allowed_actions.includes('create_artifact') &&
        !envelope.mission.allowed_actions.some(action => action.startsWith(`extension:${plugin.name}:`)))
      throw new Error('Plugin artifact lacks an exact mission grant');
    for (const artifact of evidence.artifacts) {
      await runtime.artifacts.get(artifact.sha256);
      const prior = artifacts.find(item => item.name === artifact.name);
      if (prior && prior.sha256 !== artifact.sha256) throw new Error('Conflicting plugin artifact name');
      if (!prior) artifacts.push({ ...artifact, reference: `ardent-artifact:${artifact.sha256}`, producer: `ardent-plugin:${plugin.name}`, source: artifact.source ?? '' });
    }
    for (const [from, to] of Object.entries(evidence.citationAliases ?? {})) {
      if (!evidence.references.includes(to)) throw new Error('Citation alias has no observed target');
      if (aliases.has(from) && aliases.get(from) !== to) ambiguous.add(from);
      else aliases.set(from, to);
    }
  }
  for (const alias of ambiguous) aliases.delete(alias);
  return { references, artifacts, aliases };
}
