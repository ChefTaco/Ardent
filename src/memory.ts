import { z } from 'zod';
import type { HiveMemConfig } from './config.js';
import { resolveReference } from './config.js';

const Memory = z.object({ id: z.string(), agent_id: z.string(), content: z.string(), scope: z.enum(['private', 'shared']), workspace_id: z.string().optional(),
  created_at: z.string().optional(), metadata: z.object({ project_id: z.string().optional() }).passthrough().optional() }).passthrough();
const Search = z.object({ results: z.array(z.object({ memory: Memory, score: z.number().optional(), citation: z.unknown().optional() }).passthrough()) }).passthrough();
const Browse = z.object({ results: z.array(Memory), next_cursor: z.string().nullable() }).passthrough();
const Session = z.object({ session_id: z.string(), owner_agent_id: z.string(), scope: z.enum(['private', 'shared']), workspace_id: z.string() }).passthrough();
export type MemoryRecord = z.infer<typeof Memory>;

export class HiveMemClient {
  readonly base: string;
  readonly token: string;
  readonly workspaceId: string;
  readonly agentId: string;
  constructor(config: HiveMemConfig | { provider: 'none' }, env: NodeJS.ProcessEnv = process.env) {
    if (config.provider !== 'hivemem') throw new Error('Memory provider is not configured (memory.provider: none)');
    const base = resolveReference(config.base_url, env);
    const workspace = resolveReference(config.workspace_id, env);
    const token = env[config.token_env];
    if (!base || !workspace || !token) throw new Error('HiveMem URL, workspace, or scoped token is unconfigured');
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('HiveMem URL is invalid');
    this.base = url.toString();
    this.token = token;
    this.workspaceId = workspace;
    this.agentId = config.agent_id;
  }
  async #request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) controller.abort(signal.reason);
      const response = await fetch(new URL(path, this.base.endsWith('/') ? this.base : `${this.base}/`), { method, headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual', signal: controller.signal });
      if (!response.ok) throw new Error(`HiveMem HTTP ${response.status}`);
      if (response.status === 204) return null;
      return await response.json() as unknown;
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
  }
  async capabilities(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return z.record(z.string(), z.unknown()).parse(await this.#request('v1/capabilities', 'GET', undefined, signal));
  }
  async search(query: string, scope: 'private' | 'shared', limit = 5, signal?: AbortSignal, projectId?: string): Promise<MemoryRecord[]> {
    if (scope === 'shared' && (!projectId || !/^[a-z][a-z0-9._-]{0,63}$/.test(projectId))) throw new Error('Shared memory requires one exact project grant');
    const response = Search.parse(await this.#request('v1/memories/search', 'POST', { query, scope, workspace_id: this.workspaceId,
      agent_filter: scope === 'private' ? this.agentId : undefined, ...(projectId ? { filters: { project_id: projectId } } : {}),
      limit: Math.max(1, Math.min(limit, 10)) }, signal));
    return response.results.map(item => item.memory).filter(item => item.scope === scope && (scope === 'shared' || item.agent_id === this.agentId)
      && (item.workspace_id === undefined || item.workspace_id === this.workspaceId)
      && (scope !== 'shared' || item.metadata?.project_id === projectId));
  }
  async browse(offset = 0, limit = 10, signal?: AbortSignal): Promise<{ memories: MemoryRecord[]; nextOffset: number | null }> {
    const query = new URLSearchParams({ scope: 'private', workspace_id: this.workspaceId,
      offset: String(Math.max(0, Math.min(offset, 1000))), limit: String(Math.max(1, Math.min(limit, 20))) });
    const response = Browse.parse(await this.#request(`v1/memories/browse?${query}`, 'GET', undefined, signal));
    const next = response.next_cursor;
    return { memories: response.results.filter(item => item.agent_id === this.agentId && item.scope === 'private'
      && (item.workspace_id === undefined || item.workspace_id === this.workspaceId)),
      nextOffset: next !== null && /^\d+$/.test(next) ? Number(next) : null };
  }
  async ensureSession(sessionId: string, title: string, signal?: AbortSignal): Promise<void> {
    if (!z.string().guid().safeParse(sessionId).success) throw new Error('Invalid HiveMem session ID');
    const session = Session.parse(await this.#request('v1/sessions', 'POST', { session_id: sessionId, title: title.slice(0, 160), scope: 'private', workspace_id: this.workspaceId, metadata: { application: 'ardent', profile: this.agentId } }, signal));
    if (session.session_id !== sessionId || session.owner_agent_id !== this.agentId || session.scope !== 'private' || session.workspace_id !== this.workspaceId) throw new Error('HiveMem acknowledged a mismatched session owner or scope');
  }
  async createObservation(content: string, taskId: string, sourceIds: string[], sessionId?: string, signal?: AbortSignal): Promise<MemoryRecord> {
    if (!content.trim() || content.length > 5000) throw new Error('Memory observation must be bounded');
    if (sessionId) await this.ensureSession(sessionId, 'Ardent direct conversation', signal);
    const result = await this.#request('v1/memories', 'POST', { content, type: 'episodic', scope: 'private', source: 'research', workspace_id: this.workspaceId, ...(sessionId ? { session_id: sessionId } : {}), metadata: { ardent_task_id: taskId, source_ids: sourceIds, observed_at: new Date().toISOString() } }, signal);
    const memory = Memory.parse(result);
    if (memory.agent_id !== this.agentId || memory.scope !== 'private' ||
      (memory.workspace_id && memory.workspace_id !== this.workspaceId)) throw new Error('HiveMem acknowledged a mismatched owner or scope');
    return memory;
  }
  async storeDirect(content: string, type: 'episodic' | 'semantic', taskId: string, sessionId?: string, signal?: AbortSignal): Promise<MemoryRecord> {
    if (!content.trim() || content.length > 5000) throw new Error('Memory content must be bounded');
    if (sessionId) await this.ensureSession(sessionId, 'Ardent direct conversation', signal);
    const result = await this.#request('v1/memories', 'POST', { content, type, scope: 'private', source: 'conversation', workspace_id: this.workspaceId,
      ...(sessionId ? { session_id: sessionId } : {}), metadata: { ardent_task_id: taskId, observed_at: new Date().toISOString() } }, signal);
    const memory = Memory.parse(result);
    if (memory.agent_id !== this.agentId || memory.scope !== 'private' ||
      (memory.workspace_id && memory.workspace_id !== this.workspaceId)) throw new Error('HiveMem acknowledged a mismatched owner or scope');
    return memory;
  }
  async forget(id: string, signal?: AbortSignal): Promise<void> {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new Error('Invalid memory ID');
    await this.get(id, signal);
    await this.#request(`v1/memories/${encodeURIComponent(id)}`, 'DELETE', undefined, signal);
  }
  async get(id: string, signal?: AbortSignal): Promise<MemoryRecord> {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new Error('Invalid memory ID');
    const memory = Memory.parse(await this.#request(`v1/memories/${encodeURIComponent(id)}`, 'GET', undefined, signal));
    if (memory.agent_id !== this.agentId || memory.scope !== 'private' ||
      (memory.workspace_id && memory.workspace_id !== this.workspaceId)) throw new Error('Memory is outside the owned private workspace');
    return memory;
  }
  async update(id: string, content: string, signal?: AbortSignal): Promise<MemoryRecord> {
    if (!content.trim() || content.length > 5000) throw new Error('Memory update must be bounded');
    await this.get(id, signal);
    const memory = Memory.parse(await this.#request(`v1/memories/${encodeURIComponent(id)}`, 'PUT', { content }, signal));
    if (memory.agent_id !== this.agentId || memory.scope !== 'private' ||
      (memory.workspace_id && memory.workspace_id !== this.workspaceId)) throw new Error('HiveMem acknowledged a mismatched owner or scope');
    return memory;
  }
}
