import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ARDENT_VERSION } from './version.js';
import { ConfigSchema, type LoadedConfig } from './config.js';
import { runtimeProblems, saveConfig, loadConfig, resolveReference, parseConfig } from './config.js';
import type { ArdentRuntime } from './runtime.js';
import { listSkills, setSkillEnabled } from './skills.js';
import { HiveMemClient } from './memory.js';
import { llamaEndpoint, LlamaCppBackend } from './llamacpp.js';
import { assertCodexProtocol, CodexAppServer } from './codex.js';
import { toJsonSchema } from './json-schema.js';
import { readIdentity, writeIdentity, identityHistory, restoreIdentity } from './identity.js';
import { inboundTokenEnv, listPeers, outboundTokenEnv, parsePeersConfig, readPeersConfig, savePeersConfig } from './a2a-peers.js';
import { ArdentA2AClient } from './a2a-client.js';
import { TelegramAdapter } from './telegram.js';
import { MattermostAdapter } from './mattermost.js';
import { EventSchema, SessionMessageSchema, SessionSchema, TaskSchema, TaskState } from './store.js';
import type { JobEngine } from './job-engine.js';
import { mountPluginHttp } from './plugin-http.js';
import { pluginContext } from './plugins.js';
import type { LiveTextUpdate } from './live-text.js';
import { MissionSubmit } from './missions.js';
import { ArtifactRecordSchema } from './artifact-manifests.js';
import { PreviewSubmit } from './preview.js';
import { developmentPage, DevelopmentKind, DevelopmentNoteInput, DevelopmentRecordSchema, recordSkillChange } from './development.js';
import { readProfileEnv } from './profile-env.js';

const Submit = z.object({ prompt: z.string().trim().min(1).max(16000), session_id: z.string().guid().optional(), idempotency_key: z.string().min(1).max(128).optional() }).strict();
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
const PageLimit = z.coerce.number().int().min(1).max(100);
/** A HiveMem agent credential is a JWT: three base64url segments. */
const HiveMemCredential = z.string().max(16384).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const CredentialReload = z.object({ reloaded: z.literal(true), token_env: z.string(), changed: z.boolean() });
const EventCursor = z.coerce.number().int().min(0);
function authEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Like parseJson, but a validation failure always reads as an invalid request (HTTP 400). */
function parseInput<T extends z.ZodTypeAny>(body: unknown, schema: T): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new Error(`Invalid request: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return result.data;
}
function parseJson<T extends z.ZodTypeAny>(body: unknown, schema: T): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new Error(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  return result.data;
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
const eventExample = { sequence: 1, task_id: taskExample.id, kind: 'task_accepted', detail: { backend: 'llamacpp' }, created_ms: 1790431200000 };
const sseExample = `event: task.event\nid: 1\ndata: ${JSON.stringify(eventExample)}\n\nevent: task.text\ndata: ${JSON.stringify({ step: 0, text: 'The bridge' })}\n\nevent: task.delta\ndata: ${JSON.stringify({ step: 0, text: ' holds.' })}\n\n`;

export function ardentOpenApi(): object {
  return {
    openapi: '3.1.0', info: { title: 'Magnus Ardent API', version: ARDENT_VERSION },
    servers: [{ url: '/' }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: {
      Task: jsonSchema(TaskSchema), TaskEvent: jsonSchema(EventSchema),
      Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } } } }
    } },
    paths: {
      '/health/live': { get: { operationId: 'getLiveness', responses: { '200': { description: 'Process is running' } } } },
      '/health/ready': { get: { operationId: 'getReadiness', responses: { '200': { description: 'Configured runtime ready' }, '503': { description: 'Runtime dependency unavailable' } } } },
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
        post: { operationId: 'submitTask', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(Submit), example: { prompt: 'Research today\'s topic', idempotency_key: 'topic-2026-09-26' } } } }, responses: { '202': { ...jsonResponse('Accepted durable task', z.object({ task_id: z.string().guid(), state: TaskState })), content: { 'application/json': { schema: jsonSchema(z.object({ task_id: z.string().guid(), state: TaskState })), example: { task_id: taskExample.id, state: 'queued' } } } }, '400': { description: 'Invalid request' }, '401': { description: 'Unauthorized' }, '409': { description: 'Conflicting idempotency key' } } },
        get: { operationId: 'listTasks', security: [{ bearerAuth: [] }], parameters: [{ in: 'query', name: 'limit', description: 'Maximum number of recent tasks', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }], responses: { '200': { description: 'Recent tasks', content: { 'application/json': { schema: { type: 'object', required: ['tasks'], properties: { tasks: { type: 'array', items: { $ref: '#/components/schemas/Task' } } } }, example: { tasks: [taskExample] } } } } } }
      },
      '/api/v1/missions': { post: { operationId: 'submitMission', description: 'Accept a team mission as a durable task in context mission. Tools come from mission.resources with the peer mission rule; mission tools (team_handoff, team_ask_user, team_propose_decision, artifact_write, development_note, document_render) need a tool:<name> resource. Memory reads use private scope plus one project:<id> grant. The task result is a TeamResult JSON document. The task streams on /api/v1/tasks/{id}/stream like any task.', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(MissionSubmit) } } }, responses: { '202': jsonResponse('Accepted durable mission task', Accepted), '400': { description: 'Invalid mission, context items over 64 KiB, or deadline passed' }, '401': { description: 'Unauthorized' }, '404': { description: 'Session absent' }, '409': { description: 'Conflicting idempotency key' } } } },
      '/api/v1/preview/tasks': { post: { operationId: 'submitPreviewTask', description: 'Run a prompt with unsaved soul, identity, skill selection or model overrides in context preview. A preview has read-only direct tools and no mission tools, never writes memory, development records, identity or configuration, and its artifacts expire after 24 hours. It streams on /api/v1/tasks/{id}/stream like any task.', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(PreviewSubmit) } } }, responses: { '202': jsonResponse('Accepted preview task', Accepted), '400': { description: 'Invalid request' }, '401': { description: 'Unauthorized' }, '409': { description: 'Conflicting idempotency key' } } } },
      '/api/v1/development': { get: { operationId: 'listDevelopment', description: 'The agent\'s development history in creation order: its development notes, operator notes, skill changes, identity edits and method reflections.', security: [{ bearerAuth: [] }], parameters: [{ in: 'query', name: 'after', description: 'Cursor from a previous page (next)', schema: { type: 'string' } }, { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }, { in: 'query', name: 'kind', schema: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' } }], responses: { '200': jsonResponse('One page of development records; next is null on the last page', DevelopmentPage), '400': { description: 'Invalid cursor or kind' } } },
        post: { operationId: 'addDevelopmentNote', description: 'Record an operator note (default) or an agent note relayed by a coordinator.', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(DevelopmentPost) } } }, responses: { '201': jsonResponse('Stored development record', DevelopmentRecordSchema), '400': { description: 'Invalid note' } } } },
      '/api/v1/sessions': { get: { operationId: 'listSessions', security: [{ bearerAuth: [] }], parameters: [{ in: 'query', name: 'context', description: 'Session context (default direct)', schema: { type: 'string', enum: ['direct', 'mission', 'preview'] } }], responses: { '200': jsonResponse('Caller sessions', z.object({ sessions: z.array(SessionSchema) })) } }, post: { operationId: 'openSession', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(SessionOpen) } } }, responses: { '200': jsonResponse('Existing or new session', SessionSchema) } } },
      '/api/v1/sessions/{id}/messages': { get: { operationId: 'getSessionMessages', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': jsonResponse('Recent caller session messages', z.object({ messages: z.array(SessionMessageSchema) })), '404': { description: 'Session absent' } } } },
      '/api/v1/tasks/{id}': { get: { operationId: 'getTask', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Task status', content: { 'application/json': { schema: { $ref: '#/components/schemas/Task' }, example: taskExample } } }, '404': { description: 'Task absent' } } } },
      '/api/v1/tasks/{id}/events': { get: { operationId: 'getTaskEvents', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }, { in: 'query', name: 'after', description: 'Return events with sequence greater than this cursor', schema: { type: 'integer', minimum: 0, default: 0 } }], responses: { '200': { description: 'Journal events after the supplied sequence cursor', content: { 'application/json': { schema: { type: 'object', required: ['events'], properties: { events: { type: 'array', items: { $ref: '#/components/schemas/TaskEvent' } } } }, example: { events: [eventExample] } } } } } } },
      '/api/v1/tasks/{id}/stream': { get: { operationId: 'streamTaskEvents', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }, { in: 'query', name: 'after', schema: { type: 'integer', minimum: 0 } }, { in: 'header', name: 'Last-Event-ID', description: 'Resume after a journal sequence', schema: { type: 'integer', minimum: 0 } }], responses: { '200': { description: 'SSE task.event carries TaskEvent JSON with the journal sequence as its id; task.done carries Task JSON. While the task runs, task.text carries the visible reply text of the current model step ({step, text}, sent on connect and when a step starts) and task.delta appends to it. Live text has no event id, is not journaled and is not replayed; the completed task result is authoritative.', content: { 'text/event-stream': { schema: { type: 'string' }, example: sseExample } } }, '404': { description: 'Task absent' } } } },
      '/api/v1/tasks/{id}/cancel': { post: { operationId: 'cancelTask', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Cancellation requested' } } } },
      '/api/v1/tasks/{id}/pause': { post: { operationId: 'pauseTask', description: 'Pause a queued or running task. A queued task does not start; a running task waits at its next step boundary (before a model call, a tool call or settling) and journals paused. Its deadline keeps running. Idempotent.', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': jsonResponse('Task admission', Admission), '404': { description: 'Task absent' }, '409': { description: 'Task already finished' } } } },
      '/api/v1/tasks/{id}/resume': { post: { operationId: 'resumeTask', description: 'Resume a paused task. Idempotent; resuming a task that is not paused changes nothing.', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': jsonResponse('Task admission', Admission), '404': { description: 'Task absent' } } } },
      '/api/v1/tasks/{id}/artifacts': { get: { operationId: 'listTaskArtifacts', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': jsonResponse('Current manifests of artifacts the task registered, oldest first', z.object({ artifacts: z.array(ArtifactRecordSchema) })), '404': { description: 'Task absent' } } } },
      '/api/v1/artifacts/{sha256}/manifest': { get: { operationId: 'getArtifactManifest', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'sha256', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } }], responses: { '200': jsonResponse('Newest current manifest registered for the digest', ArtifactRecordSchema), '404': { description: 'No current manifest' } } } },
      '/api/v1/artifacts/{id}': { get: { operationId: 'getArtifact', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Artifact bytes' }, '404': { description: 'Artifact absent' } } } },
      '/api/v1/status': { get: { operationId: 'getOperationalStatus', security: [{ bearerAuth: [] }], responses: { '200': jsonResponse('Active profile summary', z.object({ version: z.string(), profile: z.string(), backend: z.enum(['llamacpp', 'codex']), tasks: z.number().int() })) } } },
      '/api/v1/jobs/definitions/status': { get: { operationId: 'getJobDefinitionsStatus', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Active profile job definition revision, digest, and redacted window status' }, '503': { description: 'Job engine unavailable' } } } },
      '/api/v1/profile': { get: { operationId: 'getProfile', security: [{ bearerAuth: [] }], responses: { '200': jsonResponse('Profile identity and path', z.object({ profile: z.string(), name: z.string(), product: z.string(), timezone: z.string(), path: z.string() })) } } },
      '/api/v1/config': { get: { operationId: 'getConfig', security: [{ bearerAuth: [] }], responses: { '200': jsonResponse('Raw YAML and revision; secrets remain references', z.object({ revision: z.string(), text: z.string() })) } }, put: { operationId: 'saveConfig', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(ConfigEdit) } } }, responses: { '200': jsonResponse('Saved; activation required', z.object({ revision: z.string(), activation_required: z.boolean() })), '409': { description: 'Revision conflict' } } } },
      '/api/v1/config/validate': { post: { operationId: 'validateConfig', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: toJsonSchema(z.object({ text: z.string().min(1).max(200000) }).strict(), 'openapi-3.0') } } }, responses: { '200': { description: 'Validation result' }, '400': { description: 'Invalid YAML or configuration' } } } },
      '/api/v1/config/schema': { get: { operationId: 'getConfigSchema', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Generated JSON Schema for versioned YAML configuration' } } } },
      '/api/v1/identity/{kind}': { get: { operationId: 'getIdentity', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'kind', required: true, schema: { type: 'string', enum: ['soul', 'identity'] } }], responses: { '200': { description: 'Identity text and revision' } } }, put: { operationId: 'saveIdentity', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'kind', required: true, schema: { type: 'string', enum: ['soul', 'identity'] } }], requestBody: { required: true, content: { 'application/json': { schema: toJsonSchema(IdentityEdit, 'openapi-3.0') } } }, responses: { '200': { description: 'Saved identity revision' }, '409': { description: 'Revision conflict' } } } },
      '/api/v1/identity/{kind}/history': { get: { operationId: 'getIdentityHistory', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'kind', required: true, schema: { type: 'string', enum: ['soul', 'identity'] } }], responses: { '200': { description: 'Previous versions' } } } },
      '/api/v1/identity/{kind}/restore': { post: { operationId: 'restoreIdentity', security: [{ bearerAuth: [] }], parameters: [{ in: 'path', name: 'kind', required: true, schema: { type: 'string', enum: ['soul', 'identity'] } }], requestBody: { required: true, content: { 'application/json': { schema: toJsonSchema(IdentityRestore, 'openapi-3.0') } } }, responses: { '200': { description: 'Restored identity revision' }, '409': { description: 'Revision conflict' } } } },
      '/api/v1/providers': { get: { operationId: 'getProviders', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Configured providers and Codex account mode' } } } },
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
  jobEngine?: JobEngine, options: { envFile?: string } = {}): Hono {
  const app = new Hono();
  let current = loaded;
  // A saved configuration requires activation; it must not rotate the live
  // management credential before the gateway restarts with it.
  const apiTokenEnv = loaded.config.api.token_env;
  // Readiness spawns Codex. Cache one result briefly and share an in-flight probe.
  let codexReadiness: { at: number; problem: string | null } | undefined;
  let codexProbe: Promise<string | null> | undefined;
  const probeCodex = async (): Promise<string | null> => {
    try {
      await assertCodexProtocol(runtime.config.providers.codex.command, env);
      const server = new CodexAppServer(runtime.config.providers.codex.command, runtime.profileDir, env);
      try {
        await server.initialize();
        const auth = await server.accountStatus();
        return auth === runtime.config.providers.codex.auth_mode ? null : auth === 'login-required' ? 'Codex login required' : 'Codex account uses the wrong auth mode';
      } finally { server.close(); }
    } catch (error: unknown) { return error instanceof Error ? error.message : 'Codex App Server unavailable'; }
  };
  const codexReadinessProblem = async (): Promise<string | null> => {
    if (codexReadiness && Date.now() - codexReadiness.at < 30_000) return codexReadiness.problem;
    codexProbe ??= probeCodex().then(problem => { codexReadiness = { at: Date.now(), problem }; return problem; })
      .finally(() => { codexProbe = undefined; });
    return codexProbe;
  };
  app.onError((error, c) => {
    const message = error instanceof Error ? error.message : 'Request failed';
    const status = /revision conflict|Idempotency key reused|already in progress/i.test(message) ? 409
      : /not found|absent/i.test(message) ? 404
      : /unavailable|stale|unconfigured|missing|login required|wrong auth mode|CODEX_LOGIN_REQUIRED|CODEX_WRONG_AUTH_MODE|fetch failed|ECONNREFUSED|ETIMEDOUT|timeout/i.test(message) ? 503
      : error instanceof z.ZodError || error instanceof SyntaxError || /invalid|must be|exceeds|requires/i.test(message) ? 400 : 500;
    const code = status === 409 ? 'CONFLICT' : status === 404 ? 'NOT_FOUND' : status === 503 ? 'DEPENDENCY_UNAVAILABLE' : status === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
    return c.json({ error: { code, message: status === 500 ? 'Internal request error' : message.slice(0, 500) } }, status);
  });
  app.get('/health/live', c => c.json({ status: 'live' }));
  app.get('/health/ready', async c => {
    const problems = runtimeProblems(runtime.config, env);
    if (!problems.length && runtime.config.execution.backend === 'codex') {
      const problem = await codexReadinessProblem();
      if (problem) problems.push(problem);
    }
    if (!problems.length && runtime.config.execution.backend === 'llamacpp') {
      const base = resolveReference(runtime.config.providers.llamacpp.base_url, env);
      if (base) {
        try {
          const token = env[runtime.config.providers.llamacpp.api_key_env];
          const response = await fetch(llamaEndpoint(base, 'models'), { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(2000), redirect: 'manual' });
          if (!response.ok) problems.push(`llama.cpp model discovery HTTP ${response.status}`);
        } catch { problems.push('llama.cpp model endpoint is unavailable'); }
      }
    }
    return c.json({ status: problems.length ? 'degraded' : 'ready', problems }, problems.length ? 503 : 200);
  });
  app.get('/openapi.json', c => c.json(ardentOpenApi()));
  app.use('/api/v1/*', async (c, next) => {
    const expected = env[apiTokenEnv];
    const supplied = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
    if (!expected || !authEqual(supplied, expected)) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } }, 401);
    return next();
  });
  app.get('/api/v1/status', c => c.json({ version: ARDENT_VERSION, profile: runtime.config.profile, backend: runtime.config.execution.backend, tasks: runtime.store.list(10).length }));
  app.get('/api/v1/jobs/definitions/status', async c => {
    if (!jobEngine) throw new Error('Job engine is unavailable');
    const status = await jobEngine.status();
    return c.json({ profile: runtime.config.profile, revision: status.active_revision,
      sha256: status.active_sha256, ...status });
  });
  app.get('/api/v1/profile', c => c.json({ profile: runtime.config.profile, name: runtime.config.name, product: runtime.config.product, timezone: runtime.config.timezone, path: runtime.profileDir }));
  app.get('/api/v1/config', c => c.json({ revision: current.revision, text: current.text }));
  app.get('/api/v1/config/schema', c => c.json(toJsonSchema(ConfigSchema)));
  app.post('/api/v1/config/validate', async c => {
    const input = parseJson(await c.req.json() as unknown, z.object({ text: z.string().min(1).max(200000) }).strict());
    const config = parseConfig(input.text);
    return c.json({ valid: true, profile: config.profile, runtime_problems: runtimeProblems(config, env) });
  });
  app.put('/api/v1/config', async c => {
    const edit = parseJson(await c.req.json() as unknown, ConfigEdit);
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
    const edit = parseJson(await c.req.json() as unknown, IdentityEdit);
    return c.json(await writeIdentity(runtime.profileDir, runtime.config, kind, edit.text, edit.revision));
  });
  app.get('/api/v1/identity/:kind/history', async c => {
    const kind = z.enum(['soul', 'identity']).parse(c.req.param('kind'));
    return c.json({ history: await identityHistory(runtime.profileDir, kind) });
  });
  app.post('/api/v1/identity/:kind/restore', async c => {
    const kind = z.enum(['soul', 'identity']).parse(c.req.param('kind'));
    const input = parseJson(await c.req.json() as unknown, IdentityRestore);
    return c.json(await restoreIdentity(runtime.profileDir, runtime.config, kind, input.history_name, input.revision));
  });
  app.get('/api/v1/providers', async c => {
    let codex: string = 'unconfigured';
    try {
      await assertCodexProtocol(runtime.config.providers.codex.command, env);
      const server = new CodexAppServer(runtime.config.providers.codex.command, runtime.profileDir, env);
      try { await server.initialize(); codex = await server.accountStatus(); }
      finally { server.close(); }
    } catch (error: unknown) { codex = error instanceof Error ? error.message : 'unavailable'; }
    return c.json({ selected: runtime.config.execution.backend, llamacpp: { base_url: runtime.config.providers.llamacpp.base_url, model: runtime.config.providers.llamacpp.model }, codex: { model: runtime.config.providers.codex.model, auth_mode: codex } });
  });
  app.post('/api/v1/providers/test', async c => {
    if (runtime.config.execution.backend === 'codex') {
      await assertCodexProtocol(runtime.config.providers.codex.command, env);
      const server = new CodexAppServer(runtime.config.providers.codex.command, runtime.profileDir, env);
      try {
        await server.initialize();
        const auth = await server.accountStatus();
        if (auth !== 'chatgpt') throw new Error(auth === 'login-required' ? 'Codex ChatGPT login required' : 'Codex account uses the wrong auth mode');
        return c.json({ backend: 'codex', auth_mode: auth });
      }
      finally { server.close(); }
    }
    const result = await new LlamaCppBackend(runtime.config.providers.llamacpp, env).complete([{ role: 'user', content: 'Reply with READY.' }], [], AbortSignal.timeout(20000), false);
    return c.json({ backend: 'llamacpp', answer: result.content, usage: result.usage ?? null });
  });
  app.get('/api/v1/channels', c => c.json({ telegram: { enabled: runtime.config.channels.telegram.enabled, token_configured: Boolean(env[runtime.config.channels.telegram.token_env]), allowed_user_count: runtime.config.channels.telegram.allowed_user_ids.length, allowed_chat_count: runtime.config.channels.telegram.allowed_chat_ids.length }, mattermost: { enabled: runtime.config.channels.mattermost.enabled, token_configured: Boolean(env[runtime.config.channels.mattermost.token_env]), allowed_user_count: runtime.config.channels.mattermost.allowed_user_ids.length, allowed_channel_count: runtime.config.channels.mattermost.allowed_channel_ids.length } }));
  app.post('/api/v1/channels/:name/test', async c => {
    const name = z.enum(['telegram', 'mattermost']).parse(c.req.param('name'));
    if (name === 'telegram') {
      const result = await new TelegramAdapter(runtime, runtime.config.channels.telegram, env).initialize(AbortSignal.timeout(10000));
      return c.json({ name, status: 'reachable', bot: result, receive_mode: 'polling', polling_started: false });
    }
    const result = await new MattermostAdapter(runtime, runtime.config.channels.mattermost, env).initialize();
    return c.json({ name, status: 'reachable', bot: result, socket_started: false });
  });
  app.get('/api/v1/peers', async c => c.json({ peers: (await listPeers(runtime.profileDir, runtime.config)).map(peer => ({ ...peer,
    inbound_credential_configured: Boolean(env[inboundTokenEnv(peer)]), outbound_credential_configured: Boolean(env[outboundTokenEnv(peer)]),
    credential_configured: Boolean(env[inboundTokenEnv(peer)] && env[outboundTokenEnv(peer)]) })) }));
  app.get('/api/v1/peers/config', async c => c.json(await readPeersConfig(runtime.profileDir, runtime.config)));
  app.post('/api/v1/peers/validate', async c => {
    const input = parseJson(await c.req.json() as unknown, z.object({ text: z.string().min(1).max(200000) }).strict());
    return c.json({ valid: true, peers: parsePeersConfig(input.text).length });
  });
  app.put('/api/v1/peers/config', async c => {
    const input = parseJson(await c.req.json() as unknown, ConfigEdit);
    return c.json({ revision: await savePeersConfig(runtime.profileDir, runtime.config, input.text, input.revision), activation_required: true });
  });
  app.post('/api/v1/peers/:id/test', async c => {
    const { card } = await new ArdentA2AClient(runtime.profileDir, runtime.config, env).open(c.req.param('id'));
    return c.json({ peer: c.req.param('id'), status: 'reachable', card });
  });
  app.put('/api/v1/skills/:name', async c => {
    const edit = parseJson(await c.req.json() as unknown, SkillEdit);
    const revision = await setSkillEnabled(runtime.profileDir, c.req.param('name'), edit.enabled, edit.revision);
    current = await loadConfig(runtime.profileDir);
    recordSkillChange(runtime.development, c.req.param('name'), edit.enabled, edit.revision, revision);
    return c.json({ revision, activation_required: true });
  });
  app.post('/api/v1/memory/search', async c => {
    const input = parseJson(await c.req.json() as unknown, z.object({ query: z.string().trim().min(1).max(1000) }).strict());
    if (runtime.config.memory.provider !== 'hivemem') throw new Error('Memory provider is unconfigured');
    const client = new HiveMemClient(runtime.config.memory, env);
    return c.json({ results: await client.search(input.query, 'private') });
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
      try { body = JSON.parse(text) as unknown; } catch { throw new Error('Invalid request: body must be empty or an empty JSON object'); }
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
  app.get('/api/v1/sessions', c => c.json({ sessions: runtime.store.listSessions('management', SessionContext.parse(c.req.query('context') ?? 'direct')) }));
  app.post('/api/v1/sessions', async c => {
    const input = parseJson(await c.req.json() as unknown, SessionOpen);
    const context = input.context ?? 'direct';
    return c.json(input.reset ? runtime.store.resetSession('management', context, input.key) : runtime.store.session('management', context, input.key));
  });
  app.get('/api/v1/sessions/:id/messages', c => c.json({ messages: runtime.store.sessionMessages(c.req.param('id'), 'management') }));
  app.post('/api/v1/tasks', async c => {
    const input = parseJson(await c.req.json() as unknown, Submit);
    const task = runtime.accept(input.prompt, 'management', 'direct', input.idempotency_key, input.session_id);
    if (task.state === 'queued') void runtime.run(task.id, env).catch(() => { /* Task failure is recorded in SQLite. */ });
    return c.json({ task_id: task.id, state: task.state }, 202);
  });
  app.post('/api/v1/missions', async c => {
    const input = parseInput(await c.req.json() as unknown, MissionSubmit);
    let task;
    try { task = runtime.acceptMission(input, 'management'); }
    catch (error: unknown) {
      if (error instanceof Error && /Session caller or context mismatch/.test(error.message)) throw new Error('Invalid session: open it with context mission');
      throw error;
    }
    if (task.state === 'queued') void runtime.run(task.id, env).catch(() => { /* Task failure is recorded in SQLite. */ });
    return c.json({ task_id: task.id, state: task.state }, 202);
  });
  app.get('/api/v1/tasks', c => c.json({ tasks: runtime.store.list(PageLimit.parse(c.req.query('limit') ?? 50)) }));
  app.get('/api/v1/tasks/:id', c => {
    const task = runtime.store.get(c.req.param('id'));
    if (!task) return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
    return c.json(task);
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
      let wake: (() => void) | undefined;
      const unsubscribe = runtime.liveText.subscribe(id, update => { live.push(update); wake?.(); });
      const snapshot = runtime.liveText.snapshot(id);
      if (snapshot) live.push({ kind: 'text', ...snapshot });
      try {
        const until = Date.now() + 60_000;
        while (!stream.aborted && Date.now() < until) {
          for (const update of live.splice(0)) {
            if (update.kind !== 'end') await stream.writeSSE({ event: update.kind === 'text' ? 'task.text' : 'task.delta', data: JSON.stringify({ step: update.step, text: update.text }) });
          }
          const events = runtime.store.events(id, after, 100);
          for (const event of events) {
            await stream.writeSSE({ event: 'task.event', id: String(event.sequence), data: JSON.stringify(event) });
            after = event.sequence;
          }
          const task = runtime.store.get(id);
          if (!task || ['completed', 'partial', 'failed', 'cancelled', 'unknown'].includes(task.state)) {
            await stream.writeSSE({ event: 'task.done', data: JSON.stringify(task ?? { id, state: 'missing' }) });
            break;
          }
          if (events.length < 100 && !live.length) {
            await new Promise<void>(resolve => {
              const timer = setTimeout(resolve, 250);
              wake = () => { clearTimeout(timer); resolve(); };
            });
            wake = undefined;
          }
        }
      } finally { unsubscribe(); }
    });
  });
  app.post('/api/v1/tasks/:id/cancel', c => c.json(runtime.cancel(c.req.param('id'))));
  for (const action of ['pause', 'resume'] as const) app.post(`/api/v1/tasks/:id/${action}`, c => {
    const id = c.req.param('id');
    if (!runtime.store.get(id)) return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
    try {
      const { task, admission } = action === 'pause' ? runtime.pause(id) : runtime.resume(id);
      return c.json({ task_id: task.id, state: task.state, admission });
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'TASK_TERMINAL')
        return c.json({ error: { code: 'CONFLICT', message: error instanceof Error ? error.message : 'Task already finished' } }, 409);
      throw error;
    }
  });
  app.post('/api/v1/preview/tasks', async c => {
    const input = parseInput(await c.req.json() as unknown, PreviewSubmit);
    let task;
    try { task = runtime.acceptPreview(input, 'management'); }
    catch (error: unknown) {
      if (error instanceof Error && /Session caller or context mismatch/.test(error.message)) throw new Error('Invalid session: open it with context preview');
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
    const { author, ...note } = parseInput(await c.req.json() as unknown, DevelopmentPost);
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
  app.get('/api/v1/artifacts/:id', async c => {
    try { return c.body(new Uint8Array(await runtime.artifacts.get(c.req.param('id'))), 200, { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }); }
    catch { return c.json({ error: { code: 'NOT_FOUND', message: 'Artifact not found' } }, 404); }
  });
  // Plugin routes mount after the bearer-token middleware above.
  const ctx = pluginContext(runtime, env);
  for (const plugin of runtime.plugins) {
    if (!plugin.routes) continue;
    const sub = new Hono();
    plugin.routes(sub, ctx);
    app.route(`/api/v1/plugins/${plugin.name}`, sub);
  }
  mountPluginHttp(app, runtime, env, jobEngine);
  return app;
}
