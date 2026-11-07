import { createHash, randomUUID } from 'node:crypto';
import { Role, TaskState, type Artifact, type Message, type Part, type Task, type TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server';
import { z } from 'zod';
import type { ArdentRuntime, RunResult } from './runtime.js';
import { TEAM_TASK_METADATA_KEY, TEAM_CLARIFICATION_METADATA_KEY, TeamEnvelope as TeamEnvelopeSchema, TeamResult as TeamResultSchema, validateTeamEnvelope, validateTeamResult, type TeamEnvelope, type TeamResult } from './team-contract.js';
import { TeamControlService } from './team-control.js';
import { TeamChildService, type TeamChildReference } from './team-child.js';
import { TeamArtifacts } from './team-artifacts.js';
import { CodexHarnessBackend } from './codex.js';
import { LlamaCppBackend } from './llamacpp.js';
import { ToolRegistry } from './tools.js';

const maxPartBytes = 2 * 1024 * 1024;

/** An extracted article is an owner read when its connector result binds the
 * exact request URL, source URL, retrieval time, and content digest. It remains
 * unverified reporting, but its URL can support a read-only team check. */
export function observedOwnerSourceReference(name: string, value: Record<string, unknown>): string | null {
  if (name === 'news_article') {
    const article = z.object({ ok: z.literal(true), url: z.string().url(), source_url: z.string().url(),
      source_id: z.string().regex(/^[a-f0-9]{16}$/), retrieved_at: z.string().datetime({ offset: true }),
      content_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough().safeParse(value);
    if (!article.success || new URL(article.data.url).protocol !== 'https:' ||
      new URL(article.data.source_url).protocol !== 'https:' ||
      article.data.source_url !== article.data.url ||
      article.data.source_id !== createHash('sha256').update(article.data.url).digest('hex').slice(0, 16)) return null;
    return `source:${article.data.source_url}`;
  }
  const source = z.string().url().safeParse(value.source);
  return source.success ? `source:${source.data}` : null;
}

import { MAGNUS_OWNER_READ_TOOLS } from './magnus-owner-reads.js';

/** Read-only tools whose results carry an exact owner source URL usable as team evidence. */
const ownerReadTools = new Set(['magnus_fleet_inventory', 'magnus_fleet_readiness', 'magnus_node_health', 'magnus_node_dependency_impact', 'magnus_anomaly_summary', 'magnus_command_status',
  ...MAGNUS_OWNER_READ_TOOLS, 'news_article']);

export function observedOwnerToolResult(detail: unknown): { name: string; value: Record<string, unknown>; reference: string | null } | null {
  const observed = z.object({ name: z.string(), result: z.object({ ok: z.literal(true),
    value: z.record(z.string(), z.unknown()) }).passthrough() }).safeParse(detail);
  if (!observed.success || !ownerReadTools.has(observed.data.name)) return null;
  const reference = observedOwnerSourceReference(observed.data.name, observed.data.result.value);
  return { name: observed.data.name, value: observed.data.result.value, reference };
}

function textPart(value: string): Part {
  return { content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' };
}

function messageText(message: Message): string {
  const pieces: string[] = [];
  for (const part of message.parts) {
    const content = part.content;
    if (!content) throw new Error('A2A part is missing content');
    if (content.$case === 'text') pieces.push(content.value);
    else if (content.$case === 'data') pieces.push(`Structured data: ${JSON.stringify(content.value)}`);
    else if (content.$case === 'raw') {
      if (content.value.byteLength > maxPartBytes) throw new Error('A2A raw part exceeds 2 MiB');
      if (!['text/plain', 'text/markdown', 'application/json'].includes(part.mediaType)) throw new Error(`Unsupported A2A raw media type: ${part.mediaType}`);
      pieces.push(`Attached ${part.mediaType} ${part.filename || 'file'}:\n${content.value.toString('utf8')}`);
    } else if (content.$case === 'url') {
      const url = new URL(content.value);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('A2A file URL must be credential-free HTTPS');
      pieces.push(`Attached URL (${part.mediaType}): ${url.href}`);
    }
  }
  const prompt = pieces.join('\n\n').trim();
  if (!prompt || prompt.length > 16000) throw new Error('A2A message text must be 1 to 16000 characters');
  return prompt;
}

function status(taskId: string, contextId: string, state: TaskState, message?: string): TaskStatusUpdateEvent {
  return { taskId, contextId, status: { state, timestamp: new Date().toISOString(), message: message ? { role: Role.ROLE_AGENT, messageId: randomUUID(), parts: [textPart(message)], taskId, contextId, extensions: [], metadata: {}, referenceTaskIds: [] } : undefined }, metadata: undefined };
}

export class ArdentA2AExecutor implements AgentExecutor {
  readonly #operations = new Map<string, string>();
  readonly #cancelled = new Set<string>();
  readonly #control: TeamControlService;
  readonly #children: TeamChildService;
  readonly #artifacts: TeamArtifacts;
  constructor(readonly runtime: ArdentRuntime, readonly env: NodeJS.ProcessEnv = process.env) {
    runtime.store.db.exec('CREATE TABLE IF NOT EXISTS a2a_operation_map (a2a_task_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, tenant TEXT NOT NULL, caller TEXT NOT NULL)');
    runtime.store.db.exec('CREATE TABLE IF NOT EXISTS a2a_team_missions (a2a_task_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, caller TEXT NOT NULL, envelope_json TEXT NOT NULL)');
    this.#control = new TeamControlService(runtime);
    this.#children = new TeamChildService(runtime, env);
    this.#artifacts = new TeamArtifacts(runtime, runtime.config, env);
    // Unacknowledged settlements stay retained for a later flush; never crash startup.
    void this.#children.flush().catch(() => {});
  }
  async execute(request: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const caller = request.context.user;
    if (!caller?.isAuthenticated || !caller.userName) throw new Error('Authenticated A2A caller required');
    const taskId = request.taskId;
    const contextId = request.contextId;
    const snapshot: Task = request.task ?? { id: taskId, contextId, status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined }, artifacts: [], history: [request.userMessage], metadata: request.userMessage.metadata };
    bus.publish(AgentEvent.task(snapshot));
    const metadata = request.userMessage.metadata ?? {};
    if ('hermesTeamControl' in metadata) {
      try {
        if (Object.keys(metadata).length !== 1 || request.userMessage.parts.length !== 1 ||
          request.userMessage.parts[0]?.content?.$case !== 'text' ||
          request.userMessage.parts[0].content.value !== 'HERMES_COORDINATION_CONTROL') throw new Error('Control message mixes task input or metadata');
        const receipt = this.#control.handle(metadata.hermesTeamControl, request.context.tenant ?? '', caller.userName);
        bus.publish(AgentEvent.artifactUpdate({ taskId, contextId, artifact: {
          artifactId: randomUUID(), name: 'Team control receipt', description: 'Authenticated deterministic control response',
          parts: [textPart(JSON.stringify(receipt))], metadata: undefined, extensions: []
        }, append: false, lastChunk: true, metadata: undefined }));
        bus.publish(AgentEvent.statusUpdate(status(taskId, contextId, TaskState.TASK_STATE_COMPLETED)));
      } catch (error: unknown) {
        bus.publish(AgentEvent.statusUpdate(status(taskId, contextId, TaskState.TASK_STATE_REJECTED, error instanceof Error ? error.message : 'Invalid team control')));
      }
      return;
    }
    if ((TEAM_CLARIFICATION_METADATA_KEY in metadata && (metadata[TEAM_CLARIFICATION_METADATA_KEY] !== '1.0' || !(TEAM_TASK_METADATA_KEY in metadata))) ||
      ('hermesTeamChild' in metadata && !(TEAM_TASK_METADATA_KEY in metadata))) {
      bus.publish(AgentEvent.statusUpdate(status(taskId, contextId, TaskState.TASK_STATE_REJECTED, 'Unsupported team control or extension version')));
      return;
    }
    let prompt: string;
    try { prompt = messageText(request.userMessage); }
    catch (error: unknown) {
      bus.publish(AgentEvent.statusUpdate(status(taskId, contextId, TaskState.TASK_STATE_FAILED, error instanceof Error ? error.message : 'Unsupported A2A input')));
      return;
    }
    const rawEnvelope: unknown = metadata[TEAM_TASK_METADATA_KEY];
    let envelope: TeamEnvelope | undefined;
    let childReference: TeamChildReference | undefined;
    try {
      const tenant = request.context.tenant ?? '';
      const existing: unknown = this.runtime.store.db.prepare('SELECT tenant,caller,envelope_json FROM a2a_team_missions WHERE a2a_task_id=?').get(taskId);
      const stored = existing ? z.object({ tenant: z.string(), caller: z.string(), envelope_json: z.string() }).parse(existing) : undefined;
      if (stored && (stored.tenant !== tenant || stored.caller !== caller.userName)) throw new Error('Team mission owner mismatch');
      if (stored) {
        const admission: unknown = this.runtime.store.db.prepare('SELECT admission FROM a2a_team_admission WHERE a2a_task_id=?').get(taskId);
        if (admission && z.object({ admission: z.string() }).parse(admission).admission === 'cancel_requested') throw new Error('Cancelled team task cannot continue');
      }
      if (rawEnvelope !== undefined) {
        envelope = validateTeamEnvelope(rawEnvelope, caller.userName, request.userMessage.messageId, prompt, Date.now() / 1000, 'hermesTeamChild' in metadata);
        if ('hermesTeamChild' in metadata) childReference = await this.#children.claim(metadata.hermesTeamChild, envelope, taskId, contextId,
          caller.userName, JSON.stringify(request.userMessage));
        if (stored && stored.envelope_json !== JSON.stringify(envelope)) throw new Error('Team mission changed during continuation');
        if (!stored) this.runtime.store.db.prepare('INSERT INTO a2a_team_missions(a2a_task_id,tenant,caller,envelope_json) VALUES (?,?,?,?)').run(taskId, tenant, caller.userName, JSON.stringify(envelope));
      } else if (stored) {
        if (request.task?.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED) throw new Error('Team continuation requires an input-required task');
        const parsed: unknown = JSON.parse(stored.envelope_json);
        envelope = TeamEnvelopeSchema.parse(parsed);
      }
    }
    catch { bus.publish(AgentEvent.statusUpdate(status(taskId, contextId, TaskState.TASK_STATE_FAILED, 'Invalid authenticated team envelope'))); return; }
    if (this.#cancelled.has(taskId)) {
      bus.publish(AgentEvent.statusUpdate(status(taskId, contextId, TaskState.TASK_STATE_CANCELED)));
      this.#cancelled.delete(taskId);
      return;
    }
    bus.publish(AgentEvent.statusUpdate(status(taskId, contextId, TaskState.TASK_STATE_WORKING)));
    const owner = `a2a:${request.context.tenant ?? ''}:${caller.userName}`;
    const session = this.runtime.store.session(owner, 'peer', contextId);
    const deadline = childReference ? this.#children.deadline(childReference) : envelope?.mission.deadline;
    const existedBefore = Boolean(request.userMessage.messageId && this.runtime.store.db.prepare(
      "SELECT 1 FROM tasks WHERE caller=? AND context='peer' AND idempotency_key=?").get(owner, request.userMessage.messageId));
    const operation = this.runtime.accept(prompt, owner, 'peer', request.userMessage.messageId, session.id, deadline ? deadline * 1000 : undefined);
    if (envelope && operation.state === 'queued') this.runtime.store.append(operation.id, 'team_envelope', envelope);
    try {
    this.runtime.store.db.transaction(() => {
    this.runtime.store.db.prepare(`INSERT INTO a2a_operation_map(a2a_task_id,operation_id,tenant,caller) VALUES (?,?,?,?)
      ON CONFLICT(a2a_task_id) DO UPDATE SET operation_id=excluded.operation_id WHERE tenant=excluded.tenant AND caller=excluded.caller`)
      .run(taskId, operation.id, request.context.tenant ?? '', caller.userName);
    if (envelope) {
      this.runtime.store.db.prepare('INSERT OR IGNORE INTO a2a_operation_links(a2a_task_id,operation_id) VALUES (?,?)').run(taskId, operation.id);
      this.runtime.store.db.prepare(`INSERT INTO a2a_team_admission(a2a_task_id,operation_id,version,admission,updated_ms) VALUES (?,?,0,'open',?)
        ON CONFLICT(a2a_task_id) DO UPDATE SET operation_id=excluded.operation_id`).run(taskId, operation.id, Date.now());
    }
    })();
    } catch (error: unknown) {
      // The operation accepted by this call has not been run: a queued task
      // cannot have started an effect. Settle it instead of leaving it queued.
      // A pre-existing operation for the same message keeps its own owner path.
      try {
        if (!existedBefore && this.runtime.store.get(operation.id)?.state === 'queued')
          this.runtime.store.setState(operation.id, 'failed', null,
            `A2A transport binding failed before dispatch; no effect was started: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`);
      } catch { /* Preserve the original binding error. */ }
      throw error;
    }
    if (childReference) this.#children.attach(childReference, operation.id);
    this.#operations.set(taskId, operation.id);
    if (this.#cancelled.has(taskId)) {
      this.runtime.cancel(operation.id);
      bus.publish(AgentEvent.statusUpdate(status(taskId, contextId, TaskState.TASK_STATE_CANCELED)));
      this.#operations.delete(taskId);
      this.#cancelled.delete(taskId);
      return;
    }
    try {
      const result = await this.runtime.run(operation.id, this.env);
      if (this.#cancelled.has(taskId)) {
        bus.publish(AgentEvent.statusUpdate(status(taskId, contextId, TaskState.TASK_STATE_FAILED, 'Cancellation was requested after execution; inspect operation state before retrying')));
        return;
      }
      const teamResult = envelope ? await this.#teamResult(envelope, result, operation.id) : undefined;
      if (this.#cancelled.has(taskId)) {
        bus.publish(AgentEvent.statusUpdate(status(taskId, contextId, TaskState.TASK_STATE_FAILED, 'Cancellation was requested during result validation')));
        return;
      }
      const answerText = teamResult ? JSON.stringify(teamResult) : result.answer;
      if (childReference && teamResult) {
        try { await this.#children.settle(childReference, teamResult.outcome, answerText); }
        catch (error: unknown) { this.runtime.store.append(operation.id, 'team_child_settlement_pending', { reason: error instanceof Error ? error.message : 'Root settlement unavailable' }); }
      }
      const answer: Artifact = { artifactId: randomUUID(), name: envelope ? 'Team result' : 'Research answer', description: envelope ? 'Validated team result contract' : 'Ardent answer', parts: [textPart(answerText)], metadata: undefined, extensions: [] };
      bus.publish(AgentEvent.artifactUpdate({ taskId, contextId, artifact: answer, append: false, lastChunk: true, metadata: undefined }));
      if (result.brief) {
        const packet: Artifact = { artifactId: randomUUID(), name: 'Evidence packet', description: 'Structured source and claim references', parts: [{ content: { $case: 'data', value: result.brief }, metadata: undefined, filename: 'research-brief.json', mediaType: 'application/json' }], metadata: undefined, extensions: [] };
        bus.publish(AgentEvent.artifactUpdate({ taskId, contextId, artifact: packet, append: false, lastChunk: true, metadata: undefined }));
      }
      if (envelope) for (const exported of await this.#artifacts.registerResearch(taskId)) {
        const transfer: Artifact = { artifactId: randomUUID(), name: 'Team artifact export',
          description: 'Task-bound peer export; fetch and recipient delivery require separate receipts',
          parts: [textPart(JSON.stringify(exported))], metadata: undefined, extensions: [] };
        bus.publish(AgentEvent.artifactUpdate({ taskId, contextId, artifact: transfer, append: false,
          lastChunk: true, metadata: undefined }));
      }
      bus.publish(AgentEvent.statusUpdate(status(taskId, contextId, teamResult?.outcome === 'input_required' ? TaskState.TASK_STATE_INPUT_REQUIRED : TaskState.TASK_STATE_COMPLETED)));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Ardent execution failed';
      const cancelled = this.#cancelled.has(taskId);
      const operationId = this.#operations.get(taskId);
      const operationState = operationId ? this.runtime.store.get(operationId)?.state : undefined;
      if (childReference && operationId) {
        try { await this.#children.settle(childReference, cancelled && operationState === 'unknown' ? 'unknown' : 'failed', message); }
        catch (settlementError: unknown) { this.runtime.store.append(operationId, 'team_child_settlement_pending', { reason: settlementError instanceof Error ? settlementError.message : 'Root settlement unavailable' }); }
      }
      bus.publish(AgentEvent.statusUpdate(status(taskId, contextId, cancelled && operationState === 'cancelled' ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED, cancelled && operationState === 'unknown' ? `Cancellation outcome is unknown: ${message}` : message)));
    } finally {
      this.#operations.delete(taskId);
      this.#cancelled.delete(taskId);
    }
  }
  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    this.#cancelled.add(taskId);
    const task: unknown = this.runtime.store.db.prepare('SELECT context_id FROM a2a_tasks WHERE id=?').get(taskId);
    const contextId = task && typeof task === 'object' && 'context_id' in task && typeof task.context_id === 'string' ? task.context_id : '';
    const operation = this.#operations.get(taskId);
    if (!operation) {
      bus.publish(AgentEvent.statusUpdate(status(taskId, contextId, TaskState.TASK_STATE_CANCELED)));
      return;
    }
    this.runtime.cancel(operation);
    // The reference SDK requires the task to have actually reached CANCELED
    // when cancelTask returns. Wait for the owned operation to settle first.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.runtime.run(operation, this.env).then(() => {}, () => {}),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })
      ]);
    } finally { if (timer) clearTimeout(timer); }
    if (this.runtime.store.get(operation)?.state === 'cancelled') {
      bus.publish(AgentEvent.statusUpdate(status(taskId, contextId, TaskState.TASK_STATE_CANCELED)));
    }
  }
  async #teamResult(envelope: TeamEnvelope, result: RunResult, operationId: string): Promise<TeamResult> {
    const events = this.runtime.store.events(operationId, 0, 500);
    const canCreateArtifact = envelope.mission.allowed_actions.includes('create_artifact');
    const artifacts = events.filter(event => canCreateArtifact && event.kind === 'research_artifacts').flatMap(event => {
      const detail = z.object({ report: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }), markdown: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }) }).safeParse(event.detail);
      if (!detail.success) return [];
      return [
        { name: 'research-brief.json', reference: `ardent-artifact:${detail.data.report.id}`, sha256: detail.data.report.id },
        { name: 'research-brief.md', reference: `ardent-artifact:${detail.data.markdown.id}`, sha256: detail.data.markdown.id }
      ];
    });
    const knownReferences = new Set(artifacts.map(item => item.reference));
    for (const event of events.filter(item => item.kind === 'evidence_register')) {
      const register = z.object({ source_ids: z.array(z.string()), artifact_ids: z.array(z.string()) }).safeParse(event.detail);
      if (!register.success) continue;
      for (const sourceId of register.data.source_ids) knownReferences.add(`source:${sourceId}`);
      if (canCreateArtifact) for (const artifactId of register.data.artifact_ids) knownReferences.add(`ardent-artifact:${artifactId}`);
    }
    // Typed owner reads return an exact source URL, but are not news research and
    // therefore do not create a research brief or evidence_register event.
    const observedOwnerSources = new Set<string>();
    for (const event of events.filter(item => item.kind === 'tool_result')) {
      const observed = observedOwnerToolResult(event.detail);
      if (!observed) continue;
      const { reference } = observed;
      if (reference) {
        knownReferences.add(reference);
        observedOwnerSources.add(reference);
      }
    }
    let submitted: unknown = result.brief?.team_result;
    if (!result.brief?.team_result) {
      try {
        const parsed = z.object({ team_result: z.unknown().optional() }).passthrough().safeParse(JSON.parse(result.answer) as unknown);
        if (parsed.success) submitted = parsed.data.team_result;
      } catch { /* A non-JSON answer cannot assert mission completion. */ }
    }
    if (submitted !== undefined) {
      try {
        return this.#validateSubmittedTeamResult(submitted, artifacts, envelope, knownReferences);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : 'Invalid team result';
        this.runtime.store.append(operationId, 'team_result_rejected', { reason: reason.slice(0, 1000) });
        if (envelope.mission.allowed_actions.every(action => action === 'observe' || action === 'analyze')) {
          const repaired = await this.#repairTeamResult(submitted, reason, envelope, result, operationId,
            artifacts, knownReferences, observedOwnerSources);
          if (repaired) return repaired;
        }
      }
    }
    const candidate: TeamResult = {
      version: '1.0', mission_id: envelope.mission.id, mission_revision: envelope.mission.revision, task_id: envelope.task_id,
      outcome: 'partial', summary: result.answer.slice(0, 4000) || 'Research completed without a validated team conclusion',
      checks: envelope.mission.acceptance_criteria.map(criterion => ({ criterion, status: 'unknown', evidence: [] })),
      artifacts, uncertain_effects: []
    };
    return validateTeamResult(JSON.stringify(candidate), envelope);
  }

  #validateSubmittedTeamResult(submitted: unknown, artifacts: TeamResult['artifacts'], envelope: TeamEnvelope,
    knownReferences: ReadonlySet<string>): TeamResult {
    const parsed = TeamResultSchema.parse(submitted);
    if (!envelope.mission.allowed_actions.includes('create_artifact') && parsed.artifacts.length)
      throw new Error('Team result declares an artifact without create_artifact authority');
    for (const item of parsed.artifacts) if (!knownReferences.has(item.reference) || item.reference !== `ardent-artifact:${item.sha256}`)
      throw new Error('Team result declares an unobserved artifact');
    return validateTeamResult(JSON.stringify({ ...parsed,
      artifacts: [...artifacts, ...parsed.artifacts.filter(item => !artifacts.some(real => real.name === item.name))] }), envelope, knownReferences);
  }

  async #repairTeamResult(submitted: unknown, reason: string, envelope: TeamEnvelope, result: RunResult,
    operationId: string, artifacts: TeamResult['artifacts'], knownReferences: ReadonlySet<string>,
    observedOwnerSources: ReadonlySet<string>): Promise<TeamResult | null> {
    const shape = z.object({ version: z.unknown().optional(), mission_id: z.string(), mission_revision: z.number(), task_id: z.string(),
      outcome: z.string(), summary: z.string(), checks: z.array(z.object({ criterion: z.string(), status: z.string(),
        evidence: z.union([z.array(z.string()), z.string()]) }).strict()), artifacts: z.array(z.unknown()), uncertain_effects: z.array(z.string()) }).strict();
    const original = shape.safeParse(submitted);
    const references = [...knownReferences].sort();
    const soleOwnerSource = observedOwnerSources.size === 1 ? [...observedOwnerSources][0] : undefined;
    if (!original.success || original.data.version !== '1.0' || original.data.mission_id !== envelope.mission.id || original.data.mission_revision !== envelope.mission.revision
      || original.data.task_id !== envelope.task_id || !['completed', 'complete', 'partial', 'input_required'].includes(original.data.outcome)
      || references.length > 64 || references.some(reference => reference.length > 512)
      || Buffer.byteLength(JSON.stringify(submitted)) > 16_000 || result.task.deadline_ms - Date.now() < 5_000
      || this.runtime.store.admissionFence()) return null;
    const admission: unknown = this.runtime.store.db.prepare('SELECT admission FROM a2a_team_admission WHERE operation_id=? LIMIT 1').get(operationId);
    if (!z.object({ admission: z.literal('open') }).safeParse(admission).success) return null;
    const singleReadCheck = original.data.checks.length === 1 && envelope.mission.acceptance_criteria.length === 1
      && envelope.mission.expected_artifacts.length === 0 && original.data.artifacts.length === 0
      && original.data.checks[0]?.criterion === envelope.mission.acceptance_criteria[0]
      && ['pass', 'passed'].includes(original.data.checks[0]?.status ?? '');
    const originalEvidence = original.data.checks[0]?.evidence;
    const executionCitation = singleReadCheck && Array.isArray(originalEvidence) && originalEvidence.length === 1
      && /^source:exec-[A-Za-z0-9._:-]{1,128}$/.test(originalEvidence[0] ?? '') ? originalEvidence[0] : undefined;
    const citationCorrection = executionCitation && soleOwnerSource ? { from: executionCitation, to: soleOwnerSource } : undefined;
    const evidenceArrayCorrection = singleReadCheck && typeof originalEvidence === 'string' && knownReferences.has(originalEvidence)
      ? { from: originalEvidence, to: [originalEvidence] } : undefined;
    // These are format-only aliases for one observed, read-only owner check.
    // The normal validator still requires an exact mission binding, a known
    // source reference, all checks, and zero uncertain effects for completion.
    if (singleReadCheck && (original.data.outcome === 'complete' || original.data.checks[0]?.status === 'passed'
      || citationCorrection || evidenceArrayCorrection)) {
      const check = original.data.checks[0]!;
      const normalized = { ...original.data, outcome: original.data.outcome === 'complete' ? 'completed' : original.data.outcome,
        checks: [{ ...check, status: check.status === 'passed' ? 'pass' : check.status,
          evidence: citationCorrection ? [citationCorrection.to] : evidenceArrayCorrection?.to ?? check.evidence }] };
      try {
        const validated = this.#validateSubmittedTeamResult(normalized, artifacts, envelope, knownReferences);
        this.runtime.store.append(operationId, 'team_result_repair_accepted', { outcome: validated.outcome, tool_calls: 0,
          method: 'observed_read_format' });
        return validated;
      } catch { /* The bounded model formatter still must pass the same strict validator. */ }
    }
    const instruction = `Correct only the JSON format of this authenticated read-only team_result. Do not call tools, fetch data, change facts, or add evidence. Return one JSON object containing only team_result. Exact schema: {team_result:{version:"1.0",mission_id:string,mission_revision:integer,task_id:string,outcome:"completed"|"partial"|"failed"|"blocked"|"input_required"|"cancelled"|"unknown",summary:string,checks:[{criterion:string,status:"pass"|"fail"|"unknown",evidence:string[]}],artifacts:[{name:string,reference:string,sha256:string}],uncertain_effects:string[]}}. Exact envelope IDs: mission_id=${JSON.stringify(envelope.mission.id)}, mission_revision=${envelope.mission.revision}, task_id=${JSON.stringify(envelope.task_id)}. Allowed observed references: ${JSON.stringify(references)}. Validation error: ${reason.slice(0, 500)}. Preserve summary, each criterion/status, artifacts, and uncertain_effects exactly. Preserve evidence exactly except this sole allowed citation correction for the one criterion: ${JSON.stringify(citationCorrection ?? null)} and this sole allowed string-to-array correction for the one criterion: ${JSON.stringify(evidenceArrayCorrection ?? null)}. You may normalize outcome "complete" to "completed"; do not upgrade any other outcome. Original team_result: ${JSON.stringify(submitted)}`;
    this.runtime.store.append(operationId, 'team_result_repair_attempt', { reason: reason.slice(0, 500), observed_references: references.length });
    try {
      const signal = AbortSignal.timeout(Math.min(30_000, result.task.deadline_ms - Date.now()));
      let answer: string;
      let toolCalls = 0;
      if (result.task.backend === 'codex') {
        const formatter = new CodexHarnessBackend(this.runtime.config.providers.codex, this.runtime.profileDir, this.env);
        const corrected = await formatter.run(instruction, 'Return JSON only. No tools, shell, browser, network reads, or external effects.',
          new ToolRegistry(), 'peer', signal, 0);
        answer = corrected.answer; toolCalls = corrected.toolCalls;
      } else {
        const formatter = new LlamaCppBackend(this.runtime.config.providers.llamacpp, this.env);
        const corrected = await formatter.complete([{ role: 'system', content: 'Return JSON only. No tools or external effects.' },
          { role: 'user', content: instruction }], [], signal, false);
        answer = corrected.content; toolCalls = corrected.toolCalls.length;
      }
      if (toolCalls || Buffer.byteLength(answer) > 16_000) throw new Error('Formatting turn exceeded its tool or response boundary');
      const candidate = z.object({ team_result: TeamResultSchema }).strict().parse(JSON.parse(answer) as unknown).team_result;
      // An execution-id placeholder may become the sole observed owner-read
      // source; that exact source string may also be wrapped in one array.
      const prior = original.data;
      const allowedChecks = citationCorrection ? [{ ...prior.checks[0], evidence: [citationCorrection.to] }]
        : evidenceArrayCorrection ? [{ ...prior.checks[0], evidence: evidenceArrayCorrection.to }] : prior.checks;
      if (candidate.mission_id !== prior.mission_id || candidate.mission_revision !== prior.mission_revision
        || candidate.task_id !== prior.task_id || candidate.summary !== prior.summary
        || !(JSON.stringify(candidate.checks) === JSON.stringify(prior.checks)
          || (citationCorrection || evidenceArrayCorrection) && JSON.stringify(candidate.checks) === JSON.stringify(allowedChecks))
        || JSON.stringify(candidate.artifacts) !== JSON.stringify(prior.artifacts)
        || JSON.stringify(candidate.uncertain_effects) !== JSON.stringify(prior.uncertain_effects)
        || !(candidate.outcome === prior.outcome || prior.outcome === 'complete' && candidate.outcome === 'completed'))
        throw new Error('Formatting turn changed mission facts, checks, evidence, or outcome');
      if (this.runtime.store.admissionFence()) throw new Error('Profile admission closed during formatting correction');
      const validated = this.#validateSubmittedTeamResult(candidate, artifacts, envelope, knownReferences);
      this.runtime.store.append(operationId, 'team_result_repair_accepted', { outcome: validated.outcome, tool_calls: 0 });
      return validated;
    } catch (error: unknown) {
      this.runtime.store.append(operationId, 'team_result_repair_rejected', { reason: error instanceof Error ? error.message.slice(0, 500) : 'Formatting correction unavailable' });
      return null;
    }
  }
}
