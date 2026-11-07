import { z } from 'zod';

export const TEAM_VERSION = '1.0';
export const TEAM_TASK_METADATA_KEY = 'hermesTeamTask';
export const TEAM_CLARIFICATION_METADATA_KEY = 'hermesTeamClarification';
/** A configured peer ID (see peers.yaml). */
const role = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const boundedId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const text = (bytes: number) => z.string().trim().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= bytes, `Exceeds ${bytes} bytes`);
const texts = (minimum = 0) => z.array(text(1000)).min(minimum).max(32).refine(value => new Set(value).size === value.length, 'Duplicate entries');
const Action = z.enum(['observe', 'analyze', 'create_artifact', 'create_draft', 'reversible_change', 'deploy', 'external_publish', 'destructive_response']);

/** The mission shape without its cross-field rules (Zod 4 cannot omit fields from a refined object). */
export const TeamMissionShape = z.object({
  id: boundedId,
  revision: z.number().int().min(1).max(2147483647),
  parent_task: boundedId.nullable(),
  constraints: texts(),
  allowed_actions: z.array(Action).min(1).max(8).refine(value => new Set(value).size === value.length, 'Duplicate action'),
  resources: texts(1),
  deadline: z.number().int().min(1).max(253402300799),
  acceptance_criteria: texts(1),
  expected_artifacts: texts()
}).strict();
export const TeamMission = TeamMissionShape;
export type TeamMission = z.infer<typeof TeamMission>;

export const TeamEnvelope = z.object({ version: z.literal(TEAM_VERSION), caller: role, task_id: boundedId, objective: text(16000), mission: TeamMission }).strict();
export type TeamEnvelope = z.infer<typeof TeamEnvelope>;

const Clarification = z.object({ missing_fact: text(1200), choices: z.array(z.object({ id: boundedId, label: text(300) }).strict()).max(8), blocked_task: boundedId, intended_respondent: z.union([role, z.literal('operator')]) }).strict();
const Check = z.object({ criterion: text(1000), status: z.enum(['pass', 'fail', 'unknown']), evidence: z.array(text(1000)).max(16) }).strict();
const Artifact = z.object({ name: text(1000), reference: text(1000), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const TeamResult = z.object({
  version: z.literal(TEAM_VERSION), mission_id: boundedId, mission_revision: z.number().int().min(1), task_id: boundedId,
  outcome: z.enum(['completed', 'partial', 'failed', 'blocked', 'input_required', 'cancelled', 'unknown']),
  summary: text(16000), checks: z.array(Check).max(32), artifacts: z.array(Artifact).max(32), uncertain_effects: texts(),
  clarification: Clarification.optional()
}).strict();
export type TeamResult = z.infer<typeof TeamResult>;

export function validateTeamEnvelope(value: unknown, authenticatedPeer: string, messageId: string, objective: string, nowSeconds = Date.now() / 1000, child = false): TeamEnvelope {
  const envelope = TeamEnvelope.parse(value);
  if (envelope.caller !== authenticatedPeer || envelope.task_id !== messageId || envelope.objective !== objective) throw new Error('Team envelope does not match authenticated message');
  if (child ? envelope.mission.parent_task === null : envelope.mission.parent_task !== null)
    throw new Error('Child mission requires an exact retained root reservation');
  if (envelope.mission.deadline <= nowSeconds) throw new Error('Team mission deadline expired');
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > 48_000) throw new Error('Team envelope exceeds 48 KiB');
  return envelope;
}

export function validateTeamResult(raw: string, envelope: TeamEnvelope, knownReferences?: ReadonlySet<string>): TeamResult {
  if (Buffer.byteLength(raw, 'utf8') > 262_144) throw new Error('Team result exceeds 256 KiB');
  let text = raw.trim().replace(/^\[INPUT_REQUIRED\]\s*/, '');
  if (text.startsWith('```json\n') && text.endsWith('\n```')) text = text.slice(8, -4);
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { throw new Error('A structured JSON team result is required'); }
  const result = TeamResult.parse(value);
  if (result.mission_id !== envelope.mission.id || result.mission_revision !== envelope.mission.revision || result.task_id !== envelope.task_id) throw new Error('Team result mission or task binding differs');
  if (result.clarification && (result.outcome !== 'input_required' || result.clarification.blocked_task !== envelope.task_id)) throw new Error('Invalid team clarification binding');
  const criteria = new Set(envelope.mission.acceptance_criteria);
  const seen = new Set<string>();
  for (const check of result.checks) {
    if (!criteria.has(check.criterion) || seen.has(check.criterion)) throw new Error('Unknown or duplicate team check');
    if (knownReferences && check.evidence.some(reference => !knownReferences.has(reference))) throw new Error('Team check cites an unobserved evidence reference');
    seen.add(check.criterion);
  }
  const names = new Set<string>();
  for (const artifact of result.artifacts) {
    if (names.has(artifact.name)) throw new Error('Duplicate team artifact');
    names.add(artifact.name);
  }
  if (result.outcome === 'completed' &&
    (seen.size !== criteria.size || result.checks.some(check => check.status !== 'pass' || !check.evidence.length) ||
      envelope.mission.expected_artifacts.some(name => !names.has(name)) || result.uncertain_effects.length)) throw new Error('Team completion lacks checks, artifacts, or effect certainty');
  return result;
}
