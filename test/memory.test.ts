import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { HiveMemClient } from '../src/memory.js';
import { registerMemoryTools } from '../src/memory-tools.js';
import { ToolRegistry } from '../src/tools.js';
import { parseConfig, runtimeProblems, type ArdentConfig } from '../src/config.js';
import type { Task } from '../src/store.js';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });

/** A minimal in-process stand-in for the HiveMem HTTP API. */
async function stubHiveMem(token: string): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const memories = [{ id: 'm-1', agent_id: 'assistant', content: 'The operator prefers dated sources.', scope: 'private', created_at: '2026-01-01T00:00:00Z' }];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('Content-Type', 'application/json');
      if (request.headers.authorization !== `Bearer ${token}`) { response.statusCode = 401; response.end('{}'); return; }
      if (request.url === '/v1/capabilities') { response.end(JSON.stringify({ retrieval: 'lexical', storage: 'sqlite' })); return; }
      if (request.url === '/v1/memories/search' && request.method === 'POST') {
        const query = (JSON.parse(body) as { query: string }).query;
        response.end(JSON.stringify({ results: memories.filter(item => item.content.includes(query)).map(memory => ({ memory, score: 1 })) }));
        return;
      }
      response.statusCode = 404; response.end('{}');
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HiveMem stub address');
  return { url: `http://127.0.0.1:${address.port}/`, requests };
}

const base = 'schema_version: 1\nprofile: assistant\nname: Assistant\nexecution: { backend: llamacpp, max_model_steps: 1, max_tool_calls: 0, max_parallel_tools: 1, deadline_seconds: 10, max_delegation_depth: 0 }\nproviders:\n  llamacpp: { base_url: "http://127.0.0.1:1/", model: m, api_key_env: K, request_timeout_seconds: 5 }\n  codex: { command: codex, model: m, approval_policy: never, sandbox: read-only }\n';
const task = { id: 'task-1', context: 'direct', caller: 'local', session_id: null } as unknown as Task;

describe('optional HiveMem memory', () => {
  it('is off by default and refuses to construct a client without a provider', () => {
    const config = parseConfig(base);
    expect(config.memory.provider).toBe('none');
    expect(runtimeProblems(config, {})).not.toContain('HiveMem token is missing');
    expect(() => new HiveMemClient(config.memory, {})).toThrow('not configured');
  });

  it('searches a configured HiveMem server through the direct-task tools', async () => {
    const stub = await stubHiveMem('stub-token');
    const config: ArdentConfig = parseConfig(`${base}memory: { provider: hivemem, base_url: "${stub.url}", token_env: HIVEMEM_TOKEN, agent_id: assistant, workspace_id: ws-1 }\n`);
    expect(runtimeProblems(config, {})).toContain('HiveMem token is missing');
    const env = { HIVEMEM_TOKEN: 'stub-token' };
    expect(runtimeProblems(config, env)).not.toContain('HiveMem token is missing');
    const registry = new ToolRegistry();
    registerMemoryTools(registry, config, env, task);
    expect(registry.list('direct').map(tool => tool.name)).toContain('hivemem_search');
    expect(registry.list('peer')).toEqual([]);
    expect(await registry.call('hivemem_status', {}, 'direct', new AbortController().signal))
      .toEqual({ ok: true, value: { status: 'ready', agent_id: 'assistant', workspace_id: 'ws-1' } });
    const found = await registry.call('hivemem_search', { query: 'dated sources' }, 'direct', new AbortController().signal);
    expect(found).toMatchObject({ ok: true, value: { memories: [{ id: 'm-1', scope: 'private' }] } });
    expect(stub.requests).toEqual(['GET /v1/capabilities', 'POST /v1/memories/search']);
    expect(() => registerMemoryTools(new ToolRegistry(), config, env, { ...task, context: 'peer' } as Task)).toThrow('direct task');
  });
});
