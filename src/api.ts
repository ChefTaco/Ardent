import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { readBearerToken } from '@hivemagnus/hive-common/secrets';
import { liveness, readiness, type HealthCheck } from '@hivemagnus/hive-common/health';
import { requestContext } from '@hivemagnus/hive-common/hono';
import { z } from 'zod';
import { ARDENT_VERSION } from './version.js';
import { ardentLogger, type Logger } from './log.js';
import { ConfigSchema, type LoadedConfig } from './config.js';
import { isConfigNotice, runtimeProblems, saveConfig, loadConfig, resolveReference, parseConfig } from './config.js';
import type { ArdentRuntime } from './runtime.js';
import { listSkills, setSkillEnabled } from './skills.js';
import { HiveMemClient } from './memory.js';
import { llamaEndpoint, LlamaCppBackend } from './llamacpp.js';
import { assertCodexProtocol, CodexAppServer } from './codex.js';
import { toJsonSchema } from './json-schema.js';
import { readIdentity, writeIdentity, identityHistory, restoreIdentity } from './identity.js';
import { inboundTokenEnv, listPeers, outboundTokenEnv, parsePeersConfig, readPeersConfig, savePeersConfig, type PeerAuthenticator } from './a2a-peers.js';
import { OPENMETRICS_CONTENT_TYPE, renderMetrics } from './metrics.js';
import { ArdentA2AClient } from './a2a-client.js';
import { TelegramAdapter } from './telegram.js';
import { MattermostAdapter } from './mattermost.js';
import { CatchupStatusSchema } from './channel-catchup.js';
import { EventSchema, SessionMessageSchema, SessionSchema, TaskContext, TaskSchema, TaskState } from './store.js';
import type { JobEngine } from './job-engine.js';
import { mountPluginHttp } from './plugin-http.js';
import { pluginContext } from './plugins.js';
import type { LiveTextUpdate } from './live-text.js';
import { MissionSubmit } from './missions.js';
import { ArtifactRecordSchema, ArtifactRecordV2Schema, ArtifactRenditionSchema } from './artifact-manifests.js';
import { ArtifactImportRequestSchema, ArtifactImportSchema, ArtifactTransfers } from './artifact-transfer.js';
import { Readable } from 'node:stream';
import { formatReprDigest, parseByteRange } from '@hivemagnus/hive-common/artifact';
import { PreviewSubmit } from './preview.js';
import { developmentPage, DevelopmentKind, DevelopmentNoteInput, DevelopmentRecordSchema, recordSkillChange } from './development.js';
import { readProfileEnv } from './profile-env.js';
import { ExecutionContextSchema, ExecutionInput, type ExecutionAcceptance } from './execution.js';
import { TaskLineageSchema, taskLineage } from './lineage.js';
import { readExecutionHeader } from '@hivemagnus/hive-common/execution';
import { RecoveryDecisionInput, RecoveryViewSchema, recoveryView, type RecoveryView } from './recovery.js';
import { dependency, dependencyUnavailable, ErrorCode, invalidRequest, isHiveError, legacyPluginError, SessionMismatchError, TaskTerminalError } from './errors.js';

const Submit = z.object({ prompt: z.string().trim().min(1).max(16000), session_id: z.string().guid().optional(), idempotency_key: z.string().min(1).max(128).optional(),
  execution: ExecutionInput.optional() }).strict();
/** A task as the management API reports it: the stored row plus its execution context and recovery, when it has them. */
const TaskView = TaskSchema.extend({ execution: ExecutionContextSchema.optional(), recovery: RecoveryViewSchema.optional() });
const RecoveryCounts = z.object({ ready: z.number().int(), reconciling: z.number().int(), awaiting_decision: z.number().int(), unsupported: z.number().int() })
  .describe('Tasks in each open execution recovery status');
/** Request bodies as documented: `execution` is an execution context v1, accepted leniently. */
const documented = <T extends z.ZodObject>(schema: T) => schema.extend({ execution: ExecutionContextSchema.optional() });
/** Contexts a management caller may open a session in. A session serves tasks of its own context only. */
const SessionContext = z.enum(['direct', 'mission', 'preview']);
const Admission = z.object({ task_id: z.string().guid(), state: TaskState, admission: z.enum(['open', 'paused']) });
const DevelopmentPost = DevelopmentNoteInput.extend({ author: z.enum(['operator', 'agent']).optional() }).strict();
const DevelopmentPage = z.object({ records: z.array(DevelopmentRecordSchema), next: z.string().nullable() });
const SessionOpen = z.object({ key: z.string().trim().min(1).max(256), reset: z.boolean().optional(), context: SessionContext.optional() }).strict();
const Accepted = z.object({ task_id: z.string().guid(), state: TaskState });
const ConfigEdit = z.object({ text: z.string().min(1).max(200000), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const SkillEdit = z.object({ enabled: z.boolean(), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const IdentityEdit = z.object({ text: z.string().min(1).max(128 * 1024), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const IdentityRestore = z.object({ history_name: z.string().min(1).max(128), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/** How long a Codex account status stays fresh for readiness and GET /providers. */
const CODEX_PROBE_CACHE_MS = 30_000;
const PageLimit = z.coerce.number().int().min(1).max(100);
/** A HiveMem agent credential is a JWT: three base64url segments. */
const HiveMemCredential = z.string().max(16384).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const HealthCheckReport = z.object({ status: z.enum(['up', 'down']), critical: z.boolean(), latencyMs: z.number(), error: z.string().optional(), details: z.record(z.string(), z.unknown()).optional() });
const LiveBody = z.object({ status: z.literal('live'), service: z.string(), version: z.string(), time: z.string() });
const ReadyBody = z.object({ status: z.enum(['ready', 'not_ready']), service: z.string(), version: z.string(), time: z.string(),
  checks: z.record(z.string(), HealthCheckReport).describe('configuration, and codex or llamacpp when probed'), problems: z.array(z.string()) });
/** How long a replaced inbound credential stays valid after a rotation, unless the request says otherwise. */
const DEFAULT_CREDENTIAL_OVERLAP_SECONDS = 300;
const CredentialRotation = z.object({ overlap_seconds: z.number().int().min(0).max(3600).optional() }).strict();
const ManagementToken = z.string().min(16).max(4096).regex(/^\S+$/);
const ManagementCredentialRotated = z.object({ reloaded: z.literal(true), token_env: z.string(), changed: z.boolean(),
  previous_valid_until: z.string().datetime().nullable().describe('Until when the replaced token is still accepted, or null') });
const PeerCredentialsRotated = z.object({ reloaded: z.literal(true), peers: z.number().int().describe('Enabled peers'), changed: z.array(z.string()).describe('Peers whose inbound token changed'),
  service_environment: z.array(z.string()).describe('Token variables the service environment sets; they are not read from the file'),
  previous_valid_until: z.string().datetime().nullable().describe('Until when the replaced inbound tokens are still accepted, or null') });
const CredentialReload = z.object({ reloaded: z.literal(true), token_env: z.string(), changed: z.boolean() });
const EventCursor = z.coerce.number().int().min(0);
/** A task stream ends after this long; clients reconnect from their cursor. */
const STREAM_ROTATION_MS = 60_000;
/** An idle task stream sends a `: keepalive` comment this often. */
const STREAM_KEEPALIVE_MS = 15_000;
/** How often an idle stream looks for journal events written by another process. */
const STREAM_FALLBACK_POLL_MS = 1_000;
/** Task states after which a stream sends task.done. */
const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set(['completed', 'partial', 'failed', 'cancelled', 'unknown']);
/** A time bound: epoch milliseconds or an ISO 8601 date-time. */
const TimeBound = z.union([z.string().regex(/^\d{1,15}$/).transform(Number), z.string().datetime({ offset: true }).transform(value => Date.parse(value))]);
const TaskListQuery = z.object({ limit: PageLimit.optional(), after: z.string().min(1).max(400).optional(),
  state: z.string().max(200).transform(value => value.split(',')).pipe(z.array(TaskState).min(1)).optional(),
  context: TaskContext.optional(), caller: z.string().min(1).max(128).optional(), since: TimeBound.optional(), until: TimeBound.optional() }).strict();
function authEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Request bodies of the core management routes, as for plugin routes. */
export const MANAGEMENT_BODY_LIMIT_BYTES = 1_048_576;
const issues = (error: z.ZodError) => error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
/** Like parseJson, but the message starts with "Invalid request:". Both answer 400. */
function parseInput<T extends z.ZodTypeAny>(body: unknown, schema: T): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw invalidRequest(`Invalid request: ${issues(result.error)}`);
  return result.data;
}
function parseJson<T extends z.ZodTypeAny>(body: unknown, schema: T): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw invalidRequest(issues(result.error));
  return result.data;
}
/** The JSON request body; a body that is not JSON is an invalid request (400). */
async function readBody(c: Context): Promise<unknown> {
  try { return await c.req.json() as unknown; }
  catch { throw invalidRequest('Invalid request: the body must be JSON'); }
}
const jsonSchema = (schema: z.ZodType) => toJsonSchema(schema, 'openapi-3.0');
const jsonResponse = (description: string, schema: z.ZodTypeAny) => ({ description, content: { 'application/json': { schema: jsonSchema(schema) } } });
const a2aServer = [{ url: 'http://localhost:9901', description: 'Example A2A listener. Use the HTTP+JSON interface URL advertised by the Agent Card.' }];
const a2aVersion = { in: 'header', name: 'A2A-Version', required: true, schema: { type: 'string', enum: ['1.0'] }, description: 'Negotiated A2A protocol version' };
const a2aTaskId = { in: 'path', name: 'taskId', required: true, schema: { type: 'string' } };
const a2aConfigId = { in: 'path', name: 'configId', required: true, schema: { type: 'string' } };
const a2aBody = { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true }, example: { message: { messageId: 'request-1', role: 'user', parts: [{ kind: 'text', text: 'Research the current update' }] } } } } };
const a2aResult = { '200': { description: 'A2A v1 task or message; see the pinned A2A protocol contract', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, '400': { description: 'Invalid A2A request' }, '401': { description: 'Peer authentication failed' }, '404': { description: 'Task or configuration absent' } };
const taskExample = { id: '11111111-1111-4111-8111-111111111111', caller: 'management', context: 'direct', session_id: null, prompt: 'Research the current update', content_hash: '0'.repeat(64), idempotency_key: 'research-1', backend: 'llamacpp', state: 'queued', result: null, error: null, deadline_ms: 1790438400000, created_ms: 1790431200000, updated_ms: 1790431200000 };
const artifactDigest = { in: 'path', name: 'sha256', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } };
const artifactBytes = (description: string) => ({ description, headers: Object.fromEntries(['Accept-Ranges', 'ETag', 'Repr-Digest', 'X-Content-SHA256', 'Content-Disposition', 'Content-Range']
  .map(name => [name, { schema: { type: 'string' } }])), content: { '*/*': { schema: { type: 'string', format: 'binary' } } } });
const eventExample = { sequence: 1, task_id: taskExample.id, kind: 'task_accepted', detail: { backend: 'llamacpp' }, created_ms: 1790431200000 };
const sseExample = `event: task.event\nid: 1\ndata: ${JSON.stringify(eventExample)}\n\nevent: task.text\ndata: ${JSON.stringify({ step: 0, text: 'The bridge' })}\n\nevent: task.delta\ndata: ${JSON.stringify({ step: 0, text: ' holds.' })}\n\n`;

/** Send a file stream with backpressure; a HEAD request closes it unread. */
function streamed(c: Context, stream: Readable, status: 200 | 206, headers: Record<string, string>): Response {
  if (c.req.method === 'HEAD') { stream.destroy(); return new Response(null, { status, headers }); }
  const chunks = stream[Symbol.asyncIterator]();
  // Pull-based: the next file chunk is read only when the client has taken the last one.
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(z.instanceof(Uint8Array).parse(next.value));
    },
    cancel() { stream.destroy(); }
  });
  return new Response(body, { status, headers });
}

export function ardentOpenApi(): object {
  return {
    openapi: '3.1.0', info: { title: 'Magnus Ardent API', version: ARDENT_VERSION },
    servers: [{ url: '/' }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: {
      Task: jsonSchema(TaskView), TaskEvent: jsonSchema(EventSchema),
      Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } } } }
    } },
    paths: {
      '/health/live': { get: { operationId: 'getLiveness', responses: { '200': jsonResponse('Process is running (HiveCommon liveness body)', LiveBody) } } },
      '/health/ready': { get: { operationId: 'getReadiness', description: 'HiveCommon readiness body plus problems. The configuration check runs first; the selected backend (codex or llamacpp) is probed only when the configuration is complete. A 503 answers status not_ready, as HiveCommon readiness does.', responses: { '200': jsonResponse('Configured runtime ready', ReadyBody), '503': jsonResponse('Runtime dependency unavailable', ReadyBody) } } },
      '/a2a/rest/extendedAgentCard': { get: { operationId: 'a2aGetExtendedAgentCard', description: 'Authenticated A2A v1 extended Agent Card on the separate A2A listener.', servers: a2aServer, security: [{ bearerAuth: [] }], parameters: [a2aVersion], responses: a2aResult } },
      '/a2a/rest/message:send': { post: { operationId: 'a2aSendMessage', description: 'Canonical A2A v1 HTTP+JSON send operation on the separate A2A listener.', servers: a2aServer, security: [{ bearerAuth: [] }], parameters: [a2aVersion], requestBody: a2aBody, responses: a2aResult } },
      '/a2a/rest/message:stream': { post: { operationId: 'a2aStreamMessage', description: 'Canonical A2A v1 HTTP+JSON streaming send.', servers: a2aServer, security: [{ bearerAuth: [] }], parameters: [a2aVersion], requestBody: a2aBody, responses: { ...a2aResult, '200': { description: 'A2A task/status/artifact SSE events', content: { 'text/event-stream': { schema: { type: 'string' } } } } } } },
      '/a2a/rest/tasks': { get: { operationId: 'a2aListTasks', servers: a2aServer, security: [{ bearerAuth: [] }], parameters: [a2aVersion, { in: 'query', name: 'pageSize', schema: { type: 'integer', minimum: 1, maximum: 100 } }, { in: 'query', name: 'pageToken', schema: { type: 'string' } }], responses: a2aResult } },
      '/a2a/rest/tasks/{taskId}': { get: { operationId: 'a2aGetTask', servers: a2aServer, security: [{ bearerAuth: [] }], parameters: [a2aVersion, a2aTaskId, { in: 'query', name: 'historyLength', schema: { type: 'integer', minimum: 0 } }], responses: a2aResult } },
      '/a2a/rest/tasks/{taskId}:cancel': { post: { operationId: 'a2aCancelTask', servers: a2aServer, security: [{ bearerAuth: [] }], parameters: [a2aVersion, a2aTaskId], responses: a2aResult } },
      '/a2a/rest/tasks/{taskId}:subscribe': { get: { operationId: 'a2aSubscribeTask', servers: a2aServer, security: [{ bearerAuth: [] }], parameters: [a2aVersion, a2aTaskId], responses: { ...a2aResult, '200': { description: 'A2A task/status/artifact SSE events', content: { 'text/event-stream': { schema: { type: 'string' } } } } } }, post: { operationId: 'a2aResumeTaskStream', servers: a2aServer, security: [{ bearerAuth: [] }], parameters: [a2aVersion, a2aTaskId], responses: { ...a2aResult, '200': { description: 'A2A task/status/artifact SSE events', content: { 'text/event-stream': { schema: { type: 'string' } } } } } } },
      '/a2a/rest/tasks/{taskId}/pushNotificationConfigs': { post: { operationId: 'a2aSetPushConfig', servers: a2aServer, security: [{ bearerAuth: [] }], parameters: [a2aVersion, a2aTaskId], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, responses: { '201': { description: 'Created push configuration', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, '400': { description: 'Invalid configuration' }, '401': { description: 'Peer authentication failed' }, '404': { description: 'Task absent' } } }, get: { operationId: 'a2aListPushConfigs', servers: a2aServer, security: [{ bearerAuth: [] }], parameters: [a2aVersion, a2aTaskId], responses: a2aResult } },
      '/a2a/rest/tasks/{taskId}/pushNotificationConfigs/{configId}': { get: { operationId: 'a2aGetPushConfig', servers: a2aServer, security: [{ bearerAuth: [] }], parameters: [a2aVersion, a2aTaskId, a2aConfigId], responses: a2aResult }, delete: { operationId: 'a2aDeletePushConfig', servers: a2aServer, security: [{ bearerAuth: [] }], parameters: [a2aVersion, a2aTaskId, a2aConfigId], responses: { '204': { description: 'Push configuration deleted' }, '401': { description: 'Peer authentication failed' }, '404': { description: 'Configuration absent' } } } },
      '/api/v1/tasks': {
        post: { operationId: 'submitTask', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(documented(Submit)), example: { prompt: 'Research today\'s topic', idempotency_key: 'topic-2026-09-26' } } } }, responses: { '202': { ...jsonResponse('Accepted durable task', z.object({ task_id: z.string().guid(), state: TaskState })), content: { 'application/json': { schema: jsonSchema(z.object({ task_id: z.string().guid(), state: TaskState })), example: { task_id: taskExample.id, state: 'queued' } } } }, '400': { description: 'Invalid request' }, '401': { description: 'Unauthorized' }, '409': { description: 'Conflicting idempotency key' } } },
        get: { operationId: 'listTasks', description: 'Tasks newest first (by created_ms, then id), one page at a time. Pass next as after for the following page; filters combine with AND.', security: [{ bearerAuth: [] }], parameters: [
          { in: 'query', name: 'limit', description: 'Maximum number of tasks in the page', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { in: 'query', name: 'after', description: 'Cursor from a previous page (next)', schema: { type: 'string', maxLength: 400 } },
          { in: 'query', name: 'state', description: 'Comma-separated task states', schema: { type: 'string', example: 'queued,running' } },
          { in: 'query', name: 'context', schema: { type: 'string', enum: TaskContext.options } },
          { in: 'query', name: 'caller', description: 'Exact caller, for example management or a peer ID', schema: { type: 'string', maxLength: 128 } },
          { in: 'query', name: 'since', description: 'Tasks created at or after this time: epoch milliseconds or ISO 8601', schema: { type: 'string' } },
          { in: 'query', name: 'until', description: 'Tasks created before this time: epoch milliseconds or ISO 8601', schema: { type: 'string' } }],
          responses: { '200': { description: 'One page of tasks; next is null on the last page', content: { 'application/json': { schema: { type: 'object', required: ['tasks', 'next'], properties: { tasks: { type: 'array', items: { $ref: '#/components/schemas/Task' } }, next: { type: ['string', 'null'] } } }, example: { tasks: [taskExample], next: null } } } }, '400': { description: 'Invalid filter or cursor' } } }
      },
      '/api/v1/missions': { post: { operationId: 'submitMission', description: 'Accept a team mission as a durable task in context mission. Tools come from mission.resources with the peer mission rule; mission tools (team_handoff, team_ask_user, team_propose_decision, artifact_write, development_note, document_render) need a tool:<name> resource. Memory reads use private scope plus one project:<id> grant. The task result is a TeamResult JSON document. The task streams on /api/v1/tasks/{id}/stream like any task.', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(documented(MissionSubmit)) } } }, responses: { '202': jsonResponse('Accepted durable mission task', Accepted), '400': { description: 'Invalid mission, context items over 64 KiB, or deadline passed' }, '401': { description: 'Unauthorized' }, '404': { description: 'Session absent' }, '409': { description: 'Conflicting idempotency key' } } } },
      '/api/v1/preview/tasks': { post: { operationId: 'submitPreviewTask', description: 'Run a prompt with unsaved soul, identity, skill selection or model overrides in context preview. A preview has read-only direct tools and no mission tools, never writes memory, development records, identity or configuration, and its artifacts expire after 24 hours. It streams on /api/v1/tasks/{id}/stream like any task.', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(documented(PreviewSubmit)) } } }, responses: { '202': jsonResponse('Accepted preview task', Accepted), '400': { description: 'Invalid request' }, '401': { description: 'Unauthorized' }, '409': { description: 'Conflicting idempotency key' } } } },
      '/api/v1/development': { get: { operationId: 'listDevelopment', description: 'The agent\'s development history in creation order: its development notes, operator notes, skill changes, identity edits and method reflections.', security: [{ bearerAuth: [] }], parameters: [{ in: 'query', name: 'after', description: 'Cursor from a previous page (next)', schema: { type: 'string' } }, { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }, { in: 'query', name: 'kind', schema: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' } }], responses: { '200': jsonResponse('One page of development records; next is null on the last page', DevelopmentPage), '400': { description: 'Invalid cursor or kind' } } },
        post: { operationId: 'addDevelopmentNote', description: 'Record an operator note (default) or an agent note relayed by a coordinator.', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(DevelopmentPost) } } }, responses: { '201': jsonResponse('Stored development record', DevelopmentRecordSchema), '400': { description: 'Invalid note' } } } },
      '/api/v1/sessions': { get: { operationId: 'listSessions', security: [{ bearerAuth: [] }], parameters: [{ in: 'query', name: 'context', description: 'Session context (default direct)', schema: { type: 'string', enum: ['direct', 'mission', 'preview'] } }], responses: { '200': jsonResponse('Caller sessions', z.object({ sessions: z.array(SessionSchema) })) } }, post: { operationId: 'openSession', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(SessionOpen) } } }, responses: { '200': jsonResponse('Existing or new session', SessionSchema) } } },
      '/api/v1/sessions/{id}/messages': { get: { operationId: 'getSessionMessages', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': jsonResponse('Recent caller session messages', z.object({ messages: z.array(SessionMessageSchema) })), '404': { description: 'Session absent' } } } },
      '/api/v1/tasks/{id}': { get: { operationId: 'getTask', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Task status', content: { 'application/json': { schema: { $ref: '#/components/schemas/Task' }, example: taskExample } } }, '404': { description: 'Task absent' } } } },
      '/api/v1/tasks/{id}/recovery': {
        get: { operationId: 'getTaskRecovery', description: 'Execution recovery of a task interrupted by a crash or restart: its status, actionable reason, checkpoint with pending tool calls, and the operator actions valid now. A resumed task stays running under the same id; a held task is unknown.', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': jsonResponse('Task recovery', RecoveryViewSchema), '404': { description: 'Task absent, or never interrupted' } } },
        post: { operationId: 'decideTaskRecovery', description: 'Resolve a task held awaiting_decision. mark_applied (optional result, at most 64 KiB, checked against the tool output schema), mark_not_applied and retry_with_new_deadline (the pending call is dispatched again under its idempotency key; deadline_seconds at most execution.recovery_max_new_deadline_seconds) continue the work as a linked continuation task; abandon only records the decision. A held task stays unknown. Idempotent per task, attempt and action.', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(RecoveryDecisionInput) } } }, responses: { '200': jsonResponse('Recovery after the decision; continuation_task_id names the continuation task', RecoveryViewSchema), '400': { description: 'Invalid decision' }, '404': { description: 'Task absent' }, '409': { description: 'No decision, or not this one, is valid now' } } }
      },
      '/api/v1/tasks/{id}/lineage': { get: { operationId: 'getTaskLineage', description: 'What this profile knows about the task\'s causal tree: its execution context and parent, local child and continuation tasks, model attempts with their request ids, tool calls and artifacts. Rebuilt from SQLite, so it survives a restart. Attribution only.', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': jsonResponse('Task lineage', TaskLineageSchema), '404': { description: 'Task absent' } } } },
      '/api/v1/tasks/{id}/events': { get: { operationId: 'getTaskEvents', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }, { in: 'query', name: 'after', description: 'Return events with sequence greater than this cursor', schema: { type: 'integer', minimum: 0, default: 0 } }], responses: { '200': { description: 'Journal events after the supplied sequence cursor', content: { 'application/json': { schema: { type: 'object', required: ['events'], properties: { events: { type: 'array', items: { $ref: '#/components/schemas/TaskEvent' } } } }, example: { events: [eventExample] } } } } } } },
      '/api/v1/tasks/{id}/stream': { get: { operationId: 'streamTaskEvents', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }, { in: 'query', name: 'after', schema: { type: 'integer', minimum: 0 } }, { in: 'header', name: 'Last-Event-ID', description: 'Resume after a journal sequence', schema: { type: 'integer', minimum: 0 } }], responses: { '200': { description: 'SSE task.event carries TaskEvent JSON with the journal sequence as its id; task.done carries Task JSON. An idle stream sends a `: keepalive` comment every 15 seconds. While the task runs, task.text carries the visible reply text of the current model step ({step, text}, sent on connect and when a step starts) and task.delta appends to it. Live text has no event id, is not journaled and is not replayed; the completed task result is authoritative.', content: { 'text/event-stream': { schema: { type: 'string' }, example: sseExample } } }, '404': { description: 'Task absent' } } } },
      '/api/v1/tasks/{id}/cancel': { post: { operationId: 'cancelTask', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Cancellation requested' } } } },
      '/api/v1/tasks/{id}/pause': { post: { operationId: 'pauseTask', description: 'Pause a queued or running task. A queued task does not start; a running task waits at its next step boundary (before a model call, a tool call or settling) and journals paused. Its deadline keeps running. Idempotent.', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': jsonResponse('Task admission', Admission), '404': { description: 'Task absent' }, '409': { description: 'Task already finished' } } } },
      '/api/v1/tasks/{id}/resume': { post: { operationId: 'resumeTask', description: 'Resume a paused task. Idempotent; resuming a task that is not paused changes nothing.', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': jsonResponse('Task admission', Admission), '404': { description: 'Task absent' } } } },
      '/api/v1/tasks/{id}/artifacts': { get: { operationId: 'listTaskArtifacts', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': jsonResponse('Current manifests of artifacts the task registered, oldest first', z.object({ artifacts: z.array(ArtifactRecordSchema) })), '404': { description: 'Task absent' } } } },
      '/api/v1/artifacts/{sha256}/manifest': { get: { operationId: 'getArtifactManifest', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'sha256', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } }], responses: { '200': jsonResponse('Newest current manifest registered for the digest', ArtifactRecordSchema), '404': { description: 'No current manifest' } } } },
      '/api/v1/artifacts/{id}': { get: { operationId: 'getArtifact', description: 'Artifact bytes as application/octet-stream, streamed and verified against the digest as they are sent (a mismatch ends the response before its last chunk). Use /content for the media type, ranges and digest headers.', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Artifact bytes' }, '404': { description: 'Artifact absent' } } } },
      '/api/v1/artifacts/{sha256}/content': { get: { operationId: 'getArtifactContent', description: 'Artifact transfer v2 content. Without Range (or with an If-Range that is not the ETag) the whole artifact is returned with 200 and verified as it streams; a single Range returns 206 with Content-Range, an unsatisfiable one 416. Every response carries Accept-Ranges: bytes, ETag "<sha256>", Repr-Digest (RFC 9530 sha-256), X-Content-SHA256, the manifest media type and Content-Disposition: attachment with the manifest name. A rendition has its own digest and is fetched the same way.', security: [{ bearerAuth: [] }], parameters: [artifactDigest, { in: 'header', name: 'Range', required: false, schema: { type: 'string', example: 'bytes=0-1048575' } }, { in: 'header', name: 'If-Range', required: false, schema: { type: 'string' } }], responses: { '200': artifactBytes('Whole artifact'), '206': artifactBytes('One byte range'), '404': { description: 'Artifact absent' }, '416': { description: 'Range not satisfiable; Content-Range: bytes */<size>' } } } },
      '/api/v1/artifacts/{sha256}/renditions': { get: { operationId: 'listArtifactRenditions', description: 'Every current form of an artifact, the original first (role original, purpose download). Given an original or any of its renditions, the list is the same. Select with HiveCommon selectRendition; download always means the original.', security: [{ bearerAuth: [] }], parameters: [artifactDigest], responses: { '200': jsonResponse('Original and renditions', z.object({ renditions: z.array(ArtifactRenditionSchema) })), '404': { description: 'No current manifest' } } } },
      '/api/v1/artifacts/{sha256}/manifest/v2': { get: { operationId: 'getArtifactManifestV2', description: 'Newest current manifest for the digest as manifest 1.1 (a strict superset of 1.0 with optional rendition and provenance.execution).', security: [{ bearerAuth: [] }], parameters: [artifactDigest], responses: { '200': jsonResponse('Manifest 1.1 record', ArtifactRecordV2Schema), '404': { description: 'No current manifest' } } } },
      '/api/v1/artifacts/imports': {
        post: { operationId: 'importArtifact', description: 'Pull one artifact a configured A2A peer exported from one of its completed tasks, with transfer v2 (Range resume, SHA-256 verification) or, for an older peer, the v1 path up to 2 MiB. Idempotent per peer, task and artifact: a repeat returns the same import, and a failed import is queued again from its retained bytes. The import runs in the background and resumes after a restart.', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(ArtifactImportRequestSchema) } } }, responses: { '202': jsonResponse('Accepted import', z.object({ import_id: z.string() })), '400': { description: 'Invalid request' }, '404': { description: 'Local task absent' } } },
        get: { operationId: 'listArtifactImports', security: [{ bearerAuth: [] }], parameters: [{ in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }], responses: { '200': jsonResponse('Recent imports, newest first', z.object({ imports: z.array(ArtifactImportSchema) })) } }
      },
      '/api/v1/artifacts/imports/{id}': { get: { operationId: 'getArtifactImport', description: 'Import progress. error.code is TRANSFER_REQUIRES_V2 (peer lacks urn:hive:artifact-transfer:2 and the artifact is over 2 MiB), DIGEST_MISMATCH (bytes discarded; reissue to retry), TRANSFER_TOO_LARGE, TRANSFER_SOURCE_GONE, TRANSFER_INTERRUPTED (retries exhausted; reissue resumes) or another stable code.', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{32}$' } }], responses: { '200': jsonResponse('Import state', ArtifactImportSchema), '404': { description: 'Import absent' } } } },
      '/api/v1/status': { get: { operationId: 'getOperationalStatus', security: [{ bearerAuth: [] }], responses: { '200': jsonResponse('Active profile summary; capabilities.artifact_transfer is the highest artifact transfer version served', z.object({ version: z.string(), profile: z.string(), backend: z.enum(['llamacpp', 'codex']), tasks: z.number().int().describe('Number of tasks in the journal'),
        task_states: z.record(z.string(), z.number().int()).optional().describe('Number of tasks in each state'), channels: z.object({ mattermost: z.object({ catchup: z.array(CatchupStatusSchema).describe('Latest missed-post catch-up walk per Mattermost channel') }) }), capabilities: z.object({ artifact_transfer: z.literal(2) }), recovery: RecoveryCounts.optional(),
        jobs: z.object({ last_tick_error: z.object({ message: z.string(), at: z.string().datetime() }).nullable().describe('Last scheduler tick failure the gateway recorded, or null') }).optional() })) } } },
      '/api/v1/jobs/definitions/status': { get: { operationId: 'getJobDefinitionsStatus', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Active profile job definition revision, digest, and redacted window status' }, '503': { description: 'Job engine unavailable' } } } },
      '/api/v1/profile': { get: { operationId: 'getProfile', security: [{ bearerAuth: [] }], responses: { '200': jsonResponse('Profile identity and path', z.object({ profile: z.string(), name: z.string(), product: z.string(), timezone: z.string(), path: z.string() })) } } },
      '/api/v1/config': { get: { operationId: 'getConfig', security: [{ bearerAuth: [] }], responses: { '200': jsonResponse('Raw YAML and revision; secrets remain references', z.object({ revision: z.string(), text: z.string() })) } }, put: { operationId: 'saveConfig', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(ConfigEdit) } } }, responses: { '200': jsonResponse('Saved; activation required', z.object({ revision: z.string(), activation_required: z.boolean() })), '409': { description: 'Revision conflict' } } } },
      '/api/v1/config/validate': { post: { operationId: 'validateConfig', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: toJsonSchema(z.object({ text: z.string().min(1).max(200000) }).strict(), 'openapi-3.0') } } }, responses: { '200': { description: 'Validation result' }, '400': { description: 'Invalid YAML or configuration' } } } },
      '/api/v1/config/schema': { get: { operationId: 'getConfigSchema', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Generated JSON Schema for versioned YAML configuration' } } } },
      '/api/v1/identity/{kind}': { get: { operationId: 'getIdentity', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'kind', required: true, schema: { type: 'string', enum: ['soul', 'identity'] } }], responses: { '200': { description: 'Identity text and revision' } } }, put: { operationId: 'saveIdentity', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'kind', required: true, schema: { type: 'string', enum: ['soul', 'identity'] } }], requestBody: { required: true, content: { 'application/json': { schema: toJsonSchema(IdentityEdit, 'openapi-3.0') } } }, responses: { '200': { description: 'Saved identity revision' }, '409': { description: 'Revision conflict' } } } },
      '/api/v1/identity/{kind}/history': { get: { operationId: 'getIdentityHistory', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'kind', required: true, schema: { type: 'string', enum: ['soul', 'identity'] } }], responses: { '200': { description: 'Previous versions' } } } },
      '/api/v1/identity/{kind}/restore': { post: { operationId: 'restoreIdentity', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'kind', required: true, schema: { type: 'string', enum: ['soul', 'identity'] } }], requestBody: { required: true, content: { 'application/json': { schema: toJsonSchema(IdentityRestore, 'openapi-3.0') } } }, responses: { '200': { description: 'Restored identity revision' }, '409': { description: 'Revision conflict' } } } },
      '/api/v1/providers': { get: { operationId: 'getProviders', description: 'Configured providers. codex.auth_mode is the Codex account status (or the probe error) for a Codex profile, and not_selected for a llama.cpp profile unless probe=codex is given. The Codex probe is shared with readiness and cached for 30 seconds.', security: [{ bearerAuth: [] }], parameters: [{ in: 'query', name: 'probe', required: false, description: 'codex: probe the Codex account although llama.cpp is selected', schema: { type: 'string', enum: ['codex'] } }], responses: { '200': { description: 'Configured providers and Codex account mode' } } } },
      '/api/v1/providers/test': { post: { operationId: 'testProvider', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Selected provider probe' }, '503': { description: 'Provider unavailable' } } } },
      '/api/v1/channels': { get: { operationId: 'getChannels', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Channel configuration and credential presence' } } } },
      '/api/v1/channels/{name}/test': { post: { operationId: 'testChannel', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'name', required: true, schema: { type: 'string', enum: ['telegram', 'mattermost'] } }], responses: { '200': { description: 'Read-only channel connection probe' }, '503': { description: 'Channel unavailable' } } } },
      '/api/v1/peers': { get: { operationId: 'getPeers', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Configured peer inventory' } } } },
      '/api/v1/peers/config': { get: { operationId: 'getPeersConfig', security: [{ bearerAuth: [] }], responses: { '200': jsonResponse('Peer YAML and revision', z.object({ text: z.string(), revision: z.string() })) } },
        put: { operationId: 'savePeersConfig', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(ConfigEdit) } } }, responses: { '200': jsonResponse('Saved peer configuration; restart required', z.object({ revision: z.string(), activation_required: z.boolean() })), '409': { description: 'Revision conflict' } } } },
      '/api/v1/peers/validate': { post: { operationId: 'validatePeersConfig', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(z.object({ text: z.string().min(1).max(200000) }).strict()) } } }, responses: { '200': jsonResponse('Validated peer count', z.object({ valid: z.boolean(), peers: z.number().int() })), '400': { description: 'Invalid peer configuration' } } } },
      '/api/v1/peers/{id}/test': { post: { operationId: 'testPeer', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Peer card discovery result' }, '503': { description: 'Peer unavailable' } } } },
      '/api/v1/skills': { get: { operationId: 'listSkills', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Profile skill index' } } } },
      '/api/v1/skills/{name}': { put: { operationId: 'setSkillEnabled', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'name', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: toJsonSchema(SkillEdit, 'openapi-3.0') } } }, responses: { '200': { description: 'Saved skill selection revision' }, '409': { description: 'Revision conflict' } } } },
      '/api/v1/memory/search': { post: { operationId: 'searchMemory', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } } }, responses: { '200': { description: 'Permitted memories' }, '503': { description: 'HiveMem unavailable' } } } },
      '/api/v1/memory/status': { get: { operationId: 'getMemoryStatus', security: [{ bearerAuth: [] }], responses: { '200': jsonResponse('HiveMem readiness and capability summary', z.object({ status: z.enum(['ready', 'degraded']), agent_id: z.string(), workspace_id: z.string(), retrieval: z.string().nullable(), storage: z.string().nullable(), reason: z.string().nullable() })) } } },
      '/api/v1/metrics': { get: { operationId: 'getMetrics', description: 'Profile metrics in the OpenMetrics text format: tasks by state, open recovery statuses, job windows, channel and A2A push deliveries by state, A2A rate-limit refusals since the process started (ardent_a2a_rate_limited_total by scope ip, peer or tasks) and Mattermost catch-up boundary and walk ages and gaps per channel. Gauges are read from the journal when scraped.', security: [{ bearerAuth: [] }], responses: { '200': { description: 'OpenMetrics text, ending with # EOF', content: { 'application/openmetrics-text': { schema: { type: 'string' } } } }, '401': { description: 'Unauthorized' } } } },
      '/api/v1/credentials/management/reload': { post: { operationId: 'reloadManagementCredential', description: 'Re-read the management token named by api.token_env from the profile environment file the gateway started from and require it for every later request, without a restart. A token the service environment set cannot be rotated this way (409). The replaced token is still accepted for overlap_seconds (default 300, at most 3600; 0 ends it now), so a caller can switch over. Authenticate this request with the token in use. The token is never returned.', security: [{ bearerAuth: [] }], requestBody: { required: false, content: { 'application/json': { schema: jsonSchema(CredentialRotation) } } }, responses: { '200': jsonResponse('Credential reloaded; changed is false when the file holds the token already in use', ManagementCredentialRotated), '400': { description: 'Invalid request' }, '401': { description: 'Unauthorized' }, '409': { description: 'The service environment sets the token' }, '422': { description: 'Token missing, too short or malformed, or the environment file is unreadable; the token in use stays' } } } },
      '/api/v1/credentials/peers/reload': { post: { operationId: 'reloadPeerCredentials', description: 'Re-read the inbound and outbound tokens of every configured A2A peer from the profile environment file and use them without a restart (the peer list itself still needs a restart). A replaced inbound token is still accepted for overlap_seconds (default 300, at most 3600). The new set is validated as at startup; when it is not valid nothing changes. Tokens are never returned.', security: [{ bearerAuth: [] }], requestBody: { required: false, content: { 'application/json': { schema: jsonSchema(CredentialRotation) } } }, responses: { '200': jsonResponse('Peer credentials reloaded', PeerCredentialsRotated), '400': { description: 'Invalid request' }, '401': { description: 'Unauthorized' }, '409': { description: 'The A2A surface is not running' }, '422': { description: 'A peer credential is missing, too short, reused or not directional, or the environment file is unreadable; the credentials in use stay' } } } },
      '/api/v1/memory/credential/reload': { post: { operationId: 'reloadMemoryCredential', description: 'Re-read the HiveMem agent credential named by memory.token_env from the profile environment file the gateway started from, and use it for every later HiveMem request without a restart. No other variable changes; requests in flight finish with the previous credential. The credential is never returned.', security: [{ bearerAuth: [] }], requestBody: { required: false, content: { 'application/json': { schema: jsonSchema(z.object({}).strict()) } } }, responses: { '200': jsonResponse('Credential reloaded; changed is false when the file holds the credential already in use', CredentialReload), '400': { description: 'Invalid request' }, '401': { description: 'Unauthorized' }, '409': { description: 'Memory provider is not hivemem' }, '422': { description: 'Credential missing, empty or malformed, or the environment file is unreadable; the previous credential stays in use' } } } }
    }
  };
}

/**
 * `env` is the gateway's one shared environment: the runtime, tools, channels
 * and plugins receive the same object. `envFile` is the explicit protected
 * environment file the gateway started from, if any (default `<profile>/.env`).
 */
export function createArdentApi(runtime: ArdentRuntime, loaded: LoadedConfig, env: NodeJS.ProcessEnv = process.env,
  jobEngine?: JobEngine, options: { envFile?: string; artifactTransfers?: ArtifactTransfers; logger?: Logger;
    /** The running A2A surface's peer authentication, for POST /api/v1/credentials/peers/reload. */
    peerAuthenticator?: () => PeerAuthenticator | undefined;
    /**
     * Variables the service environment set when the gateway started. They win over the profile
     * environment file, so a credential reload never replaces them from the file.
     */
    serviceEnv?: ReadonlySet<string> } = {}): Hono {
  const app = new Hono();
  const logger = options.logger ?? ardentLogger();
  const transfers = options.artifactTransfers ?? new ArtifactTransfers(runtime, env);
  let current = loaded;
  // A saved configuration requires activation; it must not rotate the live
  // management credential before the gateway restarts with it.
  const apiTokenEnv = loaded.config.api.token_env;
  // Readiness and GET /providers spawn a Codex App Server. Cache one account
  // status briefly and share an in-flight probe between them.
  let codexAccount: { at: number; auth: string | null; error: string | null } | undefined;
  let codexProbe: Promise<{ auth: string | null; error: string | null }> | undefined;
  const probeCodex = async (): Promise<{ auth: string | null; error: string | null }> => {
    try {
      await assertCodexProtocol(runtime.config.providers.codex.command, env);
      const server = new CodexAppServer(runtime.config.providers.codex.command, runtime.profileDir, env);
      try {
        await server.initialize();
        return { auth: await server.accountStatus(), error: null };
      } finally { server.close(); }
    } catch (error: unknown) { return { auth: null, error: error instanceof Error ? error.message : 'Codex App Server unavailable' }; }
  };
  const codexAccountStatus = async (): Promise<{ auth: string | null; error: string | null }> => {
    if (codexAccount && Date.now() - codexAccount.at < CODEX_PROBE_CACHE_MS) return codexAccount;
    codexProbe ??= probeCodex().then(result => { codexAccount = { at: Date.now(), ...result }; return result; })
      .finally(() => { codexProbe = undefined; });
    return codexProbe;
  };
  const codexReadinessProblem = async (): Promise<string | null> => {
    const { auth, error } = await codexAccountStatus();
    if (error !== null) return error;
    return auth === runtime.config.providers.codex.auth_mode ? null : auth === 'login-required' ? 'Codex login required' : 'Codex account uses the wrong auth mode';
  };
  // Errors map to a status by their type: a HiveError (src/errors.ts) keeps its
  // status and code, a Zod validation error is a 400, and anything else is an
  // internal error whose message the caller never sees.
  app.onError((error, c) => {
    const typed = isHiveError(error) ? error : error instanceof z.ZodError ? invalidRequest(issues(error)) : undefined;
    if (!typed || typed.status >= 500 && typed.status !== 503) {
      // The caller sees only a generic message; record what failed so the operator can find it.
      logger.error('Unhandled management API error', { method: c.req.method, path: c.req.path, err: error });
      return c.json({ error: { code: ErrorCode.internal, message: 'Internal request error' } }, 500);
    }
    // A finished task's refusal kept its historical code on the wire.
    const code = typed instanceof TaskTerminalError ? ErrorCode.conflict : typed.code;
    return new Response(JSON.stringify({ error: { code, message: typed.message.slice(0, 500) } }), { status: typed.status, headers: { ...typed.headers, 'Content-Type': 'application/json' } });
  });
  // Every request runs in a HiveCommon request context: x-request-id is accepted or generated and
  // echoed, traceparent is continued, and the API's log lines carry requestId and traceId.
  app.use('*', requestContext());
  const health = { service: 'ardent', version: ARDENT_VERSION } as const;
  app.get('/health/live', c => c.json(liveness(health).body));
  app.get('/health/ready', async c => {
    // Advisory notices (such as a deprecated key) never make a profile unready.
    const problems = runtimeProblems(runtime.config, env).filter(problem => !isConfigNotice(problem));
    const checks: HealthCheck[] = [{ name: 'configuration', check: () => problems.length === 0 }];
    // A backend is probed only once its configuration is complete.
    if (!problems.length && runtime.config.execution.backend === 'codex') checks.push({ name: 'codex', timeoutMs: 30_000, check: async () => {
      const problem = await codexReadinessProblem();
      if (problem) problems.push(problem);
      return !problem;
    } });
    const base = runtime.config.execution.backend === 'llamacpp' ? resolveReference(runtime.config.providers.llamacpp.base_url, env) : undefined;
    if (!problems.length && base) checks.push({ name: 'llamacpp', timeoutMs: 3000, check: async signal => {
      try {
        const token = env[runtime.config.providers.llamacpp.api_key_env];
        const response = await fetch(llamaEndpoint(base, 'models'), { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]), redirect: 'manual' });
        if (!response.ok) problems.push(`llama.cpp model discovery HTTP ${response.status}`);
        return response.ok;
      } catch { problems.push('llama.cpp model endpoint is unavailable'); return false; }
    } });
    const result = await readiness({ ...health, checks });
    for (const [name, report] of Object.entries(result.body.checks))
      if (report.status === 'down' && report.error === 'timeout' && name !== 'configuration') problems.push(`${name} readiness check timed out`);
    // The HiveCommon readiness body, plus `problems`; a 503 answers `not_ready`, the HiveCommon word for a service that cannot serve.
    return c.json({ ...result.body, status: problems.length ? 'not_ready' : 'ready', problems }, problems.length ? 503 : 200);
  });
  app.get('/openapi.json', c => c.json(ardentOpenApi()));
  // After POST /api/v1/credentials/management/reload the replaced token stays valid until its overlap ends.
  let previousApiToken: { value: string; until: number } | undefined;
  app.use('/api/v1/*', async (c, next) => {
    const expected = env[apiTokenEnv];
    // Only `Authorization: Bearer <token>` (scheme case-insensitive) authenticates; a bare token does not.
    const supplied = readBearerToken(c.req.header('Authorization')) ?? '';
    const previous = previousApiToken && Date.now() < previousApiToken.until ? previousApiToken.value : undefined;
    if (!((expected && authEqual(supplied, expected)) || (previous && supplied && authEqual(supplied, previous))))
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } }, 401);
    return next();
  });
  // Plugin routes have their own limit of the same size (src/plugin-http.ts).
  app.use('/api/v1/*', bodyLimit({ maxSize: MANAGEMENT_BODY_LIMIT_BYTES,
    onError: c => c.json({ error: { code: ErrorCode.tooLarge, message: `Request body exceeds ${MANAGEMENT_BODY_LIMIT_BYTES} bytes` } }, 413) }));
  app.get('/api/v1/status', c => { const tasks = runtime.store.taskCounts(); return c.json({ version: ARDENT_VERSION, profile: runtime.config.profile, backend: runtime.config.execution.backend,
    tasks: tasks.total, task_states: tasks.by_state,
    channels: { mattermost: { catchup: runtime.store.catchup.status('mattermost') } }, jobs: { last_tick_error: runtime.store.jobTickError() },
    capabilities: { artifact_transfer: 2 }, recovery: runtime.store.executionState.counts() }); });
  app.get('/api/v1/jobs/definitions/status', async c => {
    if (!jobEngine) throw dependencyUnavailable('Job engine is unavailable');
    const status = await jobEngine.status();
    return c.json({ profile: runtime.config.profile, revision: status.active_revision,
      sha256: status.active_sha256, ...status, last_tick_error: runtime.store.jobTickError() });
  });
  app.get('/api/v1/profile', c => c.json({ profile: runtime.config.profile, name: runtime.config.name, product: runtime.config.product, timezone: runtime.config.timezone, path: runtime.profileDir }));
  app.get('/api/v1/config', c => c.json({ revision: current.revision, text: current.text }));
  app.get('/api/v1/config/schema', c => c.json(toJsonSchema(ConfigSchema)));
  app.post('/api/v1/config/validate', async c => {
    const input = parseJson(await readBody(c), z.object({ text: z.string().min(1).max(200000) }).strict());
    const config = parseConfig(input.text);
    return c.json({ valid: true, profile: config.profile, runtime_problems: runtimeProblems(config, env) });
  });
  app.put('/api/v1/config', async c => {
    const edit = parseJson(await readBody(c), ConfigEdit);
    const revision = await saveConfig(runtime.profileDir, edit.text, edit.revision);
    current = await loadConfig(runtime.profileDir);
    return c.json({ revision, activation_required: true });
  });
  app.get('/api/v1/skills', async c => c.json({ skills: await listSkills(runtime.profileDir, runtime.config) }));
  app.get('/api/v1/identity/:kind', async c => {
    const kind = z.enum(['soul', 'identity']).parse(c.req.param('kind'));
    return c.json(await readIdentity(runtime.profileDir, runtime.config, kind));
  });
  app.put('/api/v1/identity/:kind', async c => {
    const kind = z.enum(['soul', 'identity']).parse(c.req.param('kind'));
    const edit = parseJson(await readBody(c), IdentityEdit);
    return c.json(await writeIdentity(runtime.profileDir, runtime.config, kind, edit.text, edit.revision));
  });
  app.get('/api/v1/identity/:kind/history', async c => {
    const kind = z.enum(['soul', 'identity']).parse(c.req.param('kind'));
    return c.json({ history: await identityHistory(runtime.profileDir, kind) });
  });
  app.post('/api/v1/identity/:kind/restore', async c => {
    const kind = z.enum(['soul', 'identity']).parse(c.req.param('kind'));
    const input = parseJson(await readBody(c), IdentityRestore);
    return c.json(await restoreIdentity(runtime.profileDir, runtime.config, kind, input.history_name, input.revision));
  });
  app.get('/api/v1/providers', async c => {
    // A llama.cpp profile does not start Codex; ?probe=codex asks for its account status anyway (cached like readiness).
    let codex = 'not_selected';
    if (runtime.config.execution.backend === 'codex' || c.req.query('probe') === 'codex') {
      const { auth, error } = await codexAccountStatus();
      codex = error ?? auth ?? 'unavailable';
    }
    return c.json({ selected: runtime.config.execution.backend, llamacpp: { base_url: runtime.config.providers.llamacpp.base_url, model: runtime.config.providers.llamacpp.model }, codex: { model: runtime.config.providers.codex.model, auth_mode: codex } });
  });
  app.post('/api/v1/providers/test', async c => dependency(async () => {
    if (runtime.config.execution.backend === 'codex') {
      await assertCodexProtocol(runtime.config.providers.codex.command, env);
      const server = new CodexAppServer(runtime.config.providers.codex.command, runtime.profileDir, env);
      try {
        await server.initialize();
        const auth = await server.accountStatus();
        // Match readiness: the account must use the configured auth mode (ChatGPT sign-in or API key).
        if (auth !== runtime.config.providers.codex.auth_mode) throw dependencyUnavailable(auth === 'login-required' ? 'Codex login required' : 'Codex account uses the wrong auth mode');
        return c.json({ backend: 'codex', auth_mode: auth });
      }
      finally { server.close(); }
    }
    const result = await new LlamaCppBackend(runtime.config.providers.llamacpp, env).complete([{ role: 'user', content: 'Reply with READY.' }], [], AbortSignal.timeout(20000), false);
    return c.json({ backend: 'llamacpp', answer: result.content, usage: result.usage ?? null });
  }, 'Provider unavailable'));
  app.get('/api/v1/channels', c => c.json({ telegram: { enabled: runtime.config.channels.telegram.enabled, token_configured: Boolean(env[runtime.config.channels.telegram.token_env]), allowed_user_count: runtime.config.channels.telegram.allowed_user_ids.length, allowed_chat_count: runtime.config.channels.telegram.allowed_chat_ids.length }, mattermost: { enabled: runtime.config.channels.mattermost.enabled, token_configured: Boolean(env[runtime.config.channels.mattermost.token_env]), allowed_user_count: runtime.config.channels.mattermost.allowed_user_ids.length, allowed_channel_count: runtime.config.channels.mattermost.allowed_channel_ids.length } }));
  app.post('/api/v1/channels/:name/test', async c => {
    const name = z.enum(['telegram', 'mattermost']).parse(c.req.param('name'));
    return dependency(async () => {
      if (name === 'telegram') {
        const result = await new TelegramAdapter(runtime, runtime.config.channels.telegram, env).initialize(AbortSignal.timeout(10000));
        return c.json({ name, status: 'reachable', bot: result, receive_mode: 'polling', polling_started: false });
      }
      const result = await new MattermostAdapter(runtime, runtime.config.channels.mattermost, env).initialize();
      return c.json({ name, status: 'reachable', bot: result, socket_started: false });
    }, 'Channel unavailable');
  });
  app.get('/api/v1/peers', async c => c.json({ peers: (await listPeers(runtime.profileDir, runtime.config)).map(peer => ({ ...peer,
    inbound_credential_configured: Boolean(env[inboundTokenEnv(peer)]), outbound_credential_configured: Boolean(env[outboundTokenEnv(peer)]),
    credential_configured: Boolean(env[inboundTokenEnv(peer)] && env[outboundTokenEnv(peer)]) })) }));
  app.get('/api/v1/peers/config', async c => c.json(await readPeersConfig(runtime.profileDir, runtime.config)));
  app.post('/api/v1/peers/validate', async c => {
    const input = parseJson(await readBody(c), z.object({ text: z.string().min(1).max(200000) }).strict());
    return c.json({ valid: true, peers: parsePeersConfig(input.text).length });
  });
  app.put('/api/v1/peers/config', async c => {
    const input = parseJson(await readBody(c), ConfigEdit);
    return c.json({ revision: await savePeersConfig(runtime.profileDir, runtime.config, input.text, input.revision), activation_required: true });
  });
  app.post('/api/v1/peers/:id/test', async c => {
    const { card } = await dependency(() => new ArdentA2AClient(runtime.profileDir, runtime.config, env).open(c.req.param('id')), 'Peer unavailable');
    return c.json({ peer: c.req.param('id'), status: 'reachable', card });
  });
  app.put('/api/v1/skills/:name', async c => {
    const edit = parseJson(await readBody(c), SkillEdit);
    const revision = await setSkillEnabled(runtime.profileDir, c.req.param('name'), edit.enabled, edit.revision);
    current = await loadConfig(runtime.profileDir);
    recordSkillChange(runtime.development, c.req.param('name'), edit.enabled, edit.revision, revision);
    return c.json({ revision, activation_required: true });
  });
  app.post('/api/v1/memory/search', async c => {
    const input = parseJson(await readBody(c), z.object({ query: z.string().trim().min(1).max(1000) }).strict());
    if (runtime.config.memory.provider !== 'hivemem') throw dependencyUnavailable('Memory provider is unconfigured');
    return c.json({ results: await dependency(() => new HiveMemClient(runtime.config.memory, env).search(input.query, 'private'), 'HiveMem unavailable') });
  });
  app.get('/api/v1/memory/status', async c => {
    const memory = runtime.config.memory;
    if (memory.provider !== 'hivemem') return c.json({ status: 'degraded', agent_id: '', workspace_id: '', retrieval: null, storage: null,
      reason: 'Memory provider is not configured (memory.provider: none)' });
    try {
      const client = new HiveMemClient(runtime.config.memory, env);
      const capabilities = await client.capabilities();
      return c.json({ status: 'ready', agent_id: client.agentId, workspace_id: client.workspaceId,
        retrieval: typeof capabilities.retrieval === 'string' ? capabilities.retrieval : null,
        storage: typeof capabilities.storage === 'string' ? capabilities.storage : null, reason: null });
    } catch (error: unknown) {
      return c.json({ status: 'degraded', agent_id: memory.agent_id,
        workspace_id: memory.workspace_id, retrieval: null, storage: null,
        reason: error instanceof Error ? error.message.slice(0, 200) : 'HiveMem unavailable' });
    }
  });
  // The fleet manager rotates the HiveMem agent credential in the profile
  // environment file. A reload replaces only that key in the shared gateway
  // environment, so every HiveMem client created afterwards uses it.
  let credentialReloads: Promise<unknown> = Promise.resolve();
  const reloadCredential = async (name: string): Promise<{ changed: boolean } | { problem: string }> => {
    let value: string | undefined;
    try { value = (await readProfileEnv(runtime.profileDir, options.envFile))[name]; }
    catch { return { problem: 'Profile environment file is unreadable or not an owned private file' }; }
    if (!value) return { problem: `${name} is missing or empty in the profile environment file` };
    if (!HiveMemCredential.safeParse(value).success) return { problem: `${name} is not a well-formed agent credential` };
    const changed = env[name] !== value;
    env[name] = value;
    return { changed };
  };
  app.post('/api/v1/memory/credential/reload', async c => {
    const text = await c.req.text();
    if (text.trim()) {
      let body: unknown;
      try { body = JSON.parse(text) as unknown; } catch { throw invalidRequest('Invalid request: body must be empty or an empty JSON object'); }
      parseInput(body, z.object({}).strict());
    }
    const memory = runtime.config.memory;
    if (memory.provider !== 'hivemem') return c.json({ error: { code: 'CONFLICT', message: 'Memory provider is not hivemem' } }, 409);
    // Serialize reloads so the last request to start decides the credential.
    const outcome = credentialReloads.then(() => reloadCredential(memory.token_env));
    credentialReloads = outcome.catch(() => {});
    const result = await outcome;
    if ('problem' in result) return c.json({ error: { code: 'INVALID_CREDENTIAL', message: result.problem } }, 422);
    return c.json({ reloaded: true, token_env: memory.token_env, changed: result.changed });
  });
  app.get('/api/v1/metrics', c => c.body(renderMetrics({ version: ARDENT_VERSION, profile: runtime.config.profile, backend: runtime.config.execution.backend,
    store: runtime.store, counters: runtime.counters, startedMs: runtime.startedMs }), 200, { 'Content-Type': OPENMETRICS_CONTENT_TYPE, 'Cache-Control': 'no-store' }));
  // Management and peer credential rotation without a restart: re-read the profile environment
  // file, switch to the new values, and keep accepting the replaced inbound ones for an overlap.
  let rotations: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => { const run = rotations.then(work); rotations = run.catch(() => {}); return run; };
  const overlapOf = async (c: Context): Promise<number> => {
    const text = await c.req.text();
    if (!text.trim()) return DEFAULT_CREDENTIAL_OVERLAP_SECONDS;
    let body: unknown;
    try { body = JSON.parse(text) as unknown; } catch { throw invalidRequest('Invalid request: body must be empty or a JSON object'); }
    return parseInput(body, CredentialRotation).overlap_seconds ?? DEFAULT_CREDENTIAL_OVERLAP_SECONDS;
  };
  const profileEnv = async (): Promise<Record<string, string> | undefined> => {
    try { return await readProfileEnv(runtime.profileDir, options.envFile); } catch { return undefined; }
  };
  const unreadable = (c: Context) => c.json({ error: { code: 'INVALID_CREDENTIAL', message: 'Profile environment file is unreadable or not an owned private file' } }, 422);
  app.post('/api/v1/credentials/management/reload', async c => {
    const overlap = await overlapOf(c);
    return serialized(async () => {
      // The service environment wins over the file at startup; rotating from the file would end its token after the overlap.
      if (options.serviceEnv?.has(apiTokenEnv))
        return c.json({ error: { code: 'CONFLICT', message: `${apiTokenEnv} is set by the service environment; rotate it there and restart the gateway` } }, 409);
      const file = await profileEnv();
      if (!file) return unreadable(c);
      const value = file[apiTokenEnv];
      if (!value || !ManagementToken.safeParse(value).success)
        return c.json({ error: { code: 'INVALID_CREDENTIAL', message: `${apiTokenEnv} is missing, shorter than 16 characters or not a single token in the profile environment file` } }, 422);
      const prior = env[apiTokenEnv];
      const changed = prior !== value;
      if (changed) {
        previousApiToken = prior && overlap > 0 ? { value: prior, until: Date.now() + overlap * 1000 } : undefined;
        env[apiTokenEnv] = value;
        logger.info('Management credential rotated', { token_env: apiTokenEnv, overlap_seconds: overlap });
      }
      return c.json({ reloaded: true, token_env: apiTokenEnv, changed,
        previous_valid_until: changed && previousApiToken ? new Date(previousApiToken.until).toISOString() : null });
    });
  });
  app.post('/api/v1/credentials/peers/reload', async c => {
    const overlap = await overlapOf(c);
    const authenticator = options.peerAuthenticator?.();
    if (!authenticator) return c.json({ error: { code: 'CONFLICT', message: 'The A2A surface is not running' } }, 409);
    return serialized(async () => {
      const file = await profileEnv();
      if (!file) return unreadable(c);
      const names = new Set(authenticator.peers.flatMap(peer => [inboundTokenEnv(peer), outboundTokenEnv(peer)]).filter(Boolean));
      const candidate: NodeJS.ProcessEnv = { ...env };
      // A token the service environment set stays: it won over the file at startup too.
      const fixed = [...names].filter(name => options.serviceEnv?.has(name)).sort();
      for (const name of names) if (file[name] !== undefined && !options.serviceEnv?.has(name)) candidate[name] = file[name];
      let changed: string[];
      try { ({ changed } = authenticator.reload(candidate, overlap * 1000)); }
      catch (error: unknown) {
        // Nothing changed: the previous credentials stay in use.
        return c.json({ error: { code: 'INVALID_CREDENTIAL', message: error instanceof Error ? error.message.slice(0, 300) : 'Peer credentials are invalid' } }, 422);
      }
      // Outbound tokens are read from the shared environment on every call.
      for (const name of names) if (candidate[name] !== undefined) env[name] = candidate[name];
      if (changed.length) logger.info('Peer credentials rotated', { peers: changed, overlap_seconds: overlap });
      return c.json({ reloaded: true, peers: authenticator.peers.filter(peer => peer.enabled).length, changed, service_environment: fixed,
        previous_valid_until: changed.length && overlap > 0 ? new Date(Date.now() + overlap * 1000).toISOString() : null });
    });
  });
  app.get('/api/v1/sessions', c => c.json({ sessions: runtime.store.listSessions('management', SessionContext.parse(c.req.query('context') ?? 'direct')) }));
  app.post('/api/v1/sessions', async c => {
    const input = parseJson(await readBody(c), SessionOpen);
    const context = input.context ?? 'direct';
    return c.json(input.reset ? runtime.store.resetSession('management', context, input.key) : runtime.store.session('management', context, input.key));
  });
  app.get('/api/v1/sessions/:id/messages', c => c.json({ messages: runtime.store.sessionMessages(c.req.param('id'), 'management') }));
  /** The caller's execution context: the body field, else the `x-hive-execution` header. Never rejected. */
  const acceptance = (c: { req: { header(name: string): string | undefined } }, body: unknown): ExecutionAcceptance => ({
    context: body ?? readExecutionHeader(name => c.req.header(name)), source: 'caller',
    requestId: c.req.header('x-request-id'), traceparent: c.req.header('traceparent') });
  const view = (task: z.infer<typeof TaskSchema>, execution = runtime.store.executionFor(task.id), recovery: RecoveryView | undefined = recoveryView(runtime.store, task)) =>
    ({ ...task, ...(execution ? { execution } : {}), ...(recovery ? { recovery } : {}) });
  app.post('/api/v1/tasks', async c => {
    const input = parseJson(await readBody(c), Submit);
    const task = runtime.accept(input.prompt, 'management', 'direct', input.idempotency_key, input.session_id, undefined, undefined, acceptance(c, input.execution));
    if (task.state === 'queued') void runtime.run(task.id, env).catch(() => { /* Task failure is recorded in SQLite. */ });
    return c.json({ task_id: task.id, state: task.state }, 202);
  });
  app.post('/api/v1/missions', async c => {
    const input = parseInput(await readBody(c), MissionSubmit);
    let task;
    try { task = runtime.acceptMission(input, 'management', acceptance(c, input.execution)); }
    catch (error: unknown) {
      if (error instanceof SessionMismatchError) throw new SessionMismatchError('Invalid session: open it with context mission');
      throw error;
    }
    if (task.state === 'queued') void runtime.run(task.id, env).catch(() => { /* Task failure is recorded in SQLite. */ });
    return c.json({ task_id: task.id, state: task.state }, 202);
  });
  app.get('/api/v1/tasks', c => {
    const query = parseInput(Object.fromEntries(['limit', 'after', 'state', 'context', 'caller', 'since', 'until']
      .flatMap(name => { const value = c.req.query(name); return value === undefined ? [] : [[name, value]]; })), TaskListQuery);
    const { tasks, next } = runtime.store.page({ limit: query.limit ?? 50, ...(query.after !== undefined ? { after: query.after } : {}),
      ...(query.state ? { states: query.state } : {}), ...(query.context ? { context: query.context } : {}), ...(query.caller !== undefined ? { caller: query.caller } : {}),
      ...(query.since !== undefined ? { since: query.since } : {}), ...(query.until !== undefined ? { until: query.until } : {}) });
    const executions = runtime.store.executions.many(tasks.map(task => task.id));
    const recoveries = runtime.store.executionState.recoveries(tasks.map(task => task.id));
    return c.json({ tasks: tasks.map(task => view(task, executions.get(task.id)?.context, recoveryView(runtime.store, task, recoveries.get(task.id)))), next });
  });
  app.get('/api/v1/tasks/:id', c => {
    const task = runtime.store.get(c.req.param('id'));
    if (!task) return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
    return c.json(view(task));
  });
  app.get('/api/v1/tasks/:id/recovery', c => {
    const task = runtime.store.get(c.req.param('id'));
    if (!task) return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
    const recovery = recoveryView(runtime.store, task);
    if (!recovery) return c.json({ error: { code: 'NOT_FOUND', message: 'Task was never interrupted; it has no recovery' } }, 404);
    return c.json(recovery);
  });
  app.post('/api/v1/tasks/:id/recovery', async c => {
    const id = c.req.param('id');
    if (!runtime.store.get(id)) return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
    const input = parseInput(await readBody(c), RecoveryDecisionInput);
    // A RecoveryConflictError answers 409 CONFLICT.
    const decided = await runtime.decideRecovery(id, input, env, 'management');
    if (decided.continuation?.state === 'queued') void runtime.run(decided.continuation.id, env).catch(() => { /* Task failure is recorded in SQLite. */ });
    return c.json(decided.recovery);
  });
  app.get('/api/v1/tasks/:id/lineage', c => {
    const lineage = taskLineage(runtime.store, runtime.instanceRef, c.req.param('id'));
    if (!lineage) return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
    return c.json(lineage);
  });
  app.get('/api/v1/tasks/:id/events', c => {
    const id = c.req.param('id');
    if (!runtime.store.get(id)) return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
    return c.json({ events: runtime.store.events(id, EventCursor.parse(c.req.query('after') ?? 0)) });
  });
  app.get('/api/v1/tasks/:id/stream', c => {
    const id = c.req.param('id');
    if (!runtime.store.get(id)) return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
    let after = EventCursor.parse(c.req.query('after') ?? c.req.header('Last-Event-ID') ?? 0);
    return streamSSE(c, async stream => {
      // Live reply text is not journaled, so its events carry no id and a reconnect
      // starts from a task.text snapshot of the current step instead of a replay.
      const live: LiveTextUpdate[] = [];
      // The stream wakes when this gateway appends to the task's journal or has
      // live text; a slow poll still finds events another process wrote.
      let dirty = false;
      let wake: (() => void) | undefined;
      const notify = () => { dirty = true; wake?.(); };
      const unsubscribe = runtime.liveText.subscribe(id, update => { live.push(update); notify(); });
      const unsubscribeJournal = runtime.store.onAppend(id, notify);
      const unsubscribeSettled = runtime.onTaskSettled(settled => { if (settled === id) notify(); });
      stream.onAbort(notify);
      const snapshot = runtime.liveText.snapshot(id);
      if (snapshot) live.push({ kind: 'text', ...snapshot });
      let lastWrite = Date.now();
      const write = async (message: Parameters<typeof stream.writeSSE>[0]) => { await stream.writeSSE(message); lastWrite = Date.now(); };
      try {
        const until = Date.now() + STREAM_ROTATION_MS;
        while (!stream.aborted && Date.now() < until) {
          dirty = false;
          for (const update of live.splice(0)) {
            if (update.kind !== 'end') await write({ event: update.kind === 'text' ? 'task.text' : 'task.delta', data: JSON.stringify({ step: update.step, text: update.text }) });
          }
          // Read the task, and whether this gateway is still running it, before its events:
          // the final state is journaled with its event, so a task seen finished here has
          // all its events up to then on this page or a later one. Reading the state after
          // the writes could see a task that finished meanwhile and end the stream before
          // its last events. A finished task can also journal events until its run settles
          // (a direct research task records its method reflection and memory write after
          // it completes), so task.done waits for that too.
          const task = runtime.store.get(id);
          const finished = !task || (TERMINAL_TASK_STATES.has(task.state) && !runtime.isExecuting(id));
          const events = runtime.store.events(id, after, 100);
          for (const event of events) {
            await write({ event: 'task.event', id: String(event.sequence), data: JSON.stringify(event) });
            after = event.sequence;
          }
          if (finished && events.length < 100) {
            await write({ event: 'task.done', data: JSON.stringify(task ?? { id, state: 'missing' }) });
            break;
          }
          // A comment keeps idle proxies from closing the stream; clients ignore it.
          if (Date.now() - lastWrite >= STREAM_KEEPALIVE_MS) { await stream.write(': keepalive\n\n'); lastWrite = Date.now(); }
          if (events.length < 100 && !live.length && !dirty) {
            await new Promise<void>(resolve => {
              const timer = setTimeout(resolve, Math.min(STREAM_FALLBACK_POLL_MS, Math.max(0, until - Date.now()), Math.max(0, lastWrite + STREAM_KEEPALIVE_MS - Date.now())));
              wake = () => { clearTimeout(timer); resolve(); };
            });
            wake = undefined;
          }
        }
      } finally { unsubscribe(); unsubscribeJournal(); unsubscribeSettled(); }
    });
  });
  app.post('/api/v1/tasks/:id/cancel', c => c.json(runtime.cancel(c.req.param('id'))));
  for (const action of ['pause', 'resume'] as const) app.post(`/api/v1/tasks/:id/${action}`, c => {
    const id = c.req.param('id');
    if (!runtime.store.get(id)) return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
    // A finished task throws TaskTerminalError: 409 CONFLICT.
    const { task, admission } = action === 'pause' ? runtime.pause(id) : runtime.resume(id);
    return c.json({ task_id: task.id, state: task.state, admission });
  });
  app.post('/api/v1/preview/tasks', async c => {
    const input = parseInput(await readBody(c), PreviewSubmit);
    let task;
    try { task = runtime.acceptPreview(input, 'management', acceptance(c, input.execution)); }
    catch (error: unknown) {
      if (error instanceof SessionMismatchError) throw new SessionMismatchError('Invalid session: open it with context preview');
      throw error;
    }
    if (task.state === 'queued') void runtime.run(task.id, env).catch(() => { /* Task failure is recorded in SQLite. */ });
    return c.json({ task_id: task.id, state: task.state }, 202);
  });
  app.get('/api/v1/development', async c => {
    const limit = c.req.query('limit');
    const kind = c.req.query('kind');
    const query = parseInput({ after: c.req.query('after'), limit: limit === undefined ? undefined : Number(limit), kind },
      z.object({ after: z.string().max(400).optional(), limit: z.number().int().min(1).max(200).optional(), kind: DevelopmentKind.optional() }));
    return c.json(await developmentPage({ records: runtime.development, profileDir: runtime.profileDir, config: runtime.config }, query));
  });
  app.post('/api/v1/development', async c => {
    const { author, ...note } = parseInput(await readBody(c), DevelopmentPost);
    return c.json(runtime.development.add({ ...note, author: author ?? 'operator', epistemic: author === 'agent' ? 'agent_reported' : 'operator_reported' }), 201);
  });
  app.get('/api/v1/tasks/:id/artifacts', c => {
    const id = c.req.param('id');
    if (!runtime.store.get(id)) return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
    return c.json({ artifacts: runtime.artifactManifests.forTask(id) });
  });
  app.get('/api/v1/artifacts/:sha256/manifest', c => {
    const record = runtime.artifactManifests.manifest(c.req.param('sha256'));
    if (!record) return c.json({ error: { code: 'NOT_FOUND', message: 'Artifact manifest not found' } }, 404);
    return c.json(record);
  });
  // Imports register before /artifacts/:id so their static segment is not read as a digest.
  app.post('/api/v1/artifacts/imports', async c => {
    const record = transfers.start(parseInput(await readBody(c), ArtifactImportRequestSchema), 'management');
    return c.json({ import_id: record.import_id }, 202);
  });
  app.get('/api/v1/artifacts/imports', c => c.json({ imports: transfers.list(PageLimit.parse(c.req.query('limit') ?? 50)) }));
  app.get('/api/v1/artifacts/imports/:id', c => {
    const record = transfers.get(c.req.param('id'));
    return record ? c.json(record) : c.json({ error: { code: 'NOT_FOUND', message: 'Artifact import not found' } }, 404);
  });
  const artifactAbsent = (c: Context) => c.json({ error: { code: 'NOT_FOUND', message: 'Artifact not found' } }, 404);
  app.get('/api/v1/artifacts/:sha256/manifest/v2', c => {
    const record = runtime.artifactManifests.manifestV2(c.req.param('sha256'));
    return record ? c.json(record) : c.json({ error: { code: 'NOT_FOUND', message: 'Artifact manifest not found' } }, 404);
  });
  app.get('/api/v1/artifacts/:sha256/renditions', async c => {
    const renditions = await runtime.artifactManifests.renditions(c.req.param('sha256'));
    return renditions ? c.json({ renditions }) : c.json({ error: { code: 'NOT_FOUND', message: 'Artifact manifest not found' } }, 404);
  });
  app.get('/api/v1/artifacts/:sha256/content', async c => {
    const sha = c.req.param('sha256');
    if (!/^[a-f0-9]{64}$/.test(sha)) return artifactAbsent(c);
    const stat = await runtime.artifacts.stat(sha).catch(() => undefined);
    if (!stat) return artifactAbsent(c);
    const manifest = runtime.artifactManifests.manifestV2(sha)?.manifest;
    const etag = `"${sha}"`;
    const ifRange = c.req.header('If-Range');
    const range = parseByteRange(ifRange === undefined || ifRange === etag ? c.req.header('Range') : undefined, stat.size);
    const headers: Record<string, string> = { 'Accept-Ranges': 'bytes', ETag: etag, 'Repr-Digest': formatReprDigest(sha), 'X-Content-SHA256': sha,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' };
    if (range === null) return c.json({ error: { code: 'RANGE_NOT_SATISFIABLE', message: 'Requested range is not satisfiable' } }, 416,
      { ...headers, 'Content-Range': `bytes */${stat.size}` });
    const read = await runtime.artifacts.openRead(sha, range ?? {}, { verify: !range }).catch(() => undefined);
    if (!read) return artifactAbsent(c);
    Object.assign(headers, { 'Content-Type': manifest?.mime ?? 'application/octet-stream', 'Content-Length': String(read.end - read.start + 1),
      'Content-Disposition': `attachment; filename="${manifest?.name ?? sha}"`, ...(range ? { 'Content-Range': `bytes ${read.start}-${read.end}/${stat.size}` } : {}) });
    return streamed(c, read.stream, range ? 206 : 200, headers);
  });
  app.get('/api/v1/artifacts/:id', async c => {
    const read = await runtime.artifacts.openRead(c.req.param('id'), {}, { verify: true }).catch(() => undefined);
    if (!read) return artifactAbsent(c);
    return streamed(c, read.stream, 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(read.size), 'X-Content-Type-Options': 'nosniff' });
  });
  // Plugin routes mount after the bearer-token middleware above.
  const ctx = pluginContext(runtime, env);
  for (const plugin of runtime.plugins) {
    if (!plugin.routes) continue;
    const sub = new Hono();
    // A plugin error without a type answers as it did before typed errors.
    sub.onError(error => { throw legacyPluginError(error); });
    plugin.routes(sub, ctx);
    app.route(`/api/v1/plugins/${plugin.name}`, sub);
  }
  mountPluginHttp(app, runtime, env, jobEngine);
  return app;
}
