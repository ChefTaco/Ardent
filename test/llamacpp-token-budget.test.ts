import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextCheckpoints } from '../src/context-checkpoints.js';
import { LlamaCppBackend } from '../src/llamacpp.js';
import { parseModelPolicy } from '../src/model-policy.js';
import { TaskStore } from '../src/store.js';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('llama.cpp input token counting', () => {
  it('uses the chat-template token count when exposed and falls back when absent', async () => {
    let available = true;
    const server = createServer((request, response) => {
      if (request.url !== '/v1/chat/completions/input_tokens' || !available) { response.writeHead(404).end(); return; }
      expect(request.method).toBe('POST');
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; messages: unknown[]; tools: unknown[] };
        expect(body).toMatchObject({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }], tools: [] });
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: 42 }));
      });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture address missing');
    const backend = new LlamaCppBackend({ base_url: `http://127.0.0.1:${address.port}`, model: 'fixture',
      api_key_env: 'FIXTURE_KEY', request_timeout_seconds: 5 });
    const messages = [{ role: 'user' as const, content: 'hello' }];
    expect(await backend.countInputTokens(messages, [], AbortSignal.timeout(5000))).toBe(42);
    available = false;
    expect(await backend.countInputTokens(messages, [], AbortSignal.timeout(5000))).toBeNull();
  });

  it('assembles a llama.cpp task from a Codex compacted checkpoint under the discovered context limit', async () => {
    let completion: { messages: Array<{ role: string; content: string }> } | null = null;
    const server = createServer(async (request, response) => {
      if (request.url === '/v1/models') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'fixture', meta: { n_ctx: 8192 } }] }));
        return;
      }
      if (request.url === '/props') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ default_generation_settings: { n_ctx: 8192 }, chat_template_caps: { supports_tools: true } }));
        return;
      }
      const chunks: Buffer[] = [];
      try { for await (const chunk of request) chunks.push(Buffer.from(chunk)); }
      catch { response.destroy(); return; }
      if (!request.complete) { response.destroy(); return; }
      let body: { messages: Array<{ role: string; content: string }> };
      try { body = JSON.parse(Buffer.concat(chunks).toString()) as typeof body; }
      catch { response.writeHead(400).end(); return; }
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/chat/completions/input_tokens') {
        response.end(JSON.stringify({ input_tokens: body.messages.some(message => message.content.includes('historical_unverified')) ? 1000 : 6000 }));
      } else {
        completion = body;
        response.end(JSON.stringify({ choices: [{ message: { content: 'Fresh answer' } }] }));
      }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture address missing');
    const backend = new LlamaCppBackend({ base_url: `http://127.0.0.1:${address.port}`, model: 'fixture',
      api_key_env: 'FIXTURE_KEY', request_timeout_seconds: 5, max_output_tokens: 2048 });
    const limits = await backend.discover();
    expect(limits.contextTokens).toBe(8192);

    const dir = mkdtempSync(join(tmpdir(), 'ardent-llama-context-'));
    dirs.push(dir);
    const store = new TaskStore(join(dir, 'ardent.sqlite'));
    const session = store.session('local', 'direct', 'chat');
    for (const prompt of ['first', 'second', 'third']) {
      const task = store.accept({ caller: 'local', context: 'direct', sessionId: session.id,
        prompt, backend: 'llamacpp', deadlineMs: Date.now() + 60_000 });
      store.startQueued(task.id);
      store.finishWithAssistant(task.id, 'completed', `Answer: ${prompt}`);
    }
    const current = store.accept({ caller: 'local', context: 'direct', sessionId: session.id,
      prompt: 'current request', backend: 'llamacpp', deadlineMs: Date.now() + 60_000 });
    const policy = { ...parseModelPolicy(JSON.stringify({ schema_version: 1, revision: 7,
      primary: { codex: { model: 'gpt-6.1-sol', reasoning_effort: 'medium' }, llamacpp: { mode: 'profile' } },
      compaction: { enabled: true, routes: [{ backend: 'codex', model: 'gpt-6-luna', reasoning_effort: 'high' }],
        prompt_budget_tokens: 8192, output_reserve_tokens: 2048, checkpoint_max_tokens: 512,
        recent_max_tokens: 1024, trigger_ratio: 0.7 } })), path: join(dir, 'policy.json') };
    const policyBytes = JSON.stringify(policy.policy);
    writeFileSync(policy.path, policyBytes, { mode: 0o600 });
    policy.sha256 = parseModelPolicy(policyBytes).sha256;
    const used: string[] = [];
    const manager = new ContextCheckpoints(store, async (route, prompt) => {
      used.push(`${route.backend}:${route.model}:${route.reasoning_effort}`);
      const source = JSON.parse(prompt) as { exchanges: Array<{ user: { id: number } }> };
      return JSON.stringify({ items: [{ kind: 'open_item', text: 'Historical item is unverified',
        source_message_ids: [source.exchanges[0]!.user.id], historical_status: 'historical_unverified' }] });
    });
    const signal = AbortSignal.timeout(5000);
    const prepared = await manager.prepare(current, 'Current policy', [], policy, signal, { apply: true,
      maxInputTokens: limits.contextTokens - 2048,
      countTokens: (messages, tools) => backend.countInputTokens(messages, tools, signal) });
    expect(prepared.compacted).toBe(true);
    expect(used).toEqual(['codex:gpt-6-luna:high']);
    expect(manager.status(session.id, 'local', 'direct')).toMatchObject({ valid: true, policy_revision: 7 });
    expect((await backend.complete(prepared.messages, [], signal, false)).content).toBe('Fresh answer');
    expect(completion?.messages.map(message => message.content).join(' ')).toContain('Current policy');
    expect(completion?.messages.map(message => message.content).join(' ')).toContain('historical_unverified');
    expect(completion?.messages.at(-1)?.content).toBe('current request');
    expect(store.db.prepare('SELECT count(*) AS n FROM session_messages').get()).toEqual({ n: 7 });
    store.close();
  });
});
