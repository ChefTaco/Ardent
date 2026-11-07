import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { LlamaCppBackend } from '../src/llamacpp.js';
import type { ArdentConfig } from '../src/config.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('llama.cpp wire handling', () => {
  it('uses discovered context and template capabilities before sending explicit reasoning options', async () => {
    let supportsReasoning = true;
    let lastBody: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'fixture', meta: { n_ctx: 8192 } }] })); return; }
      if (request.url === '/props') { response.end(JSON.stringify({ default_generation_settings: { n_ctx: 8192, params: { temperature: 0.7, top_p: 0.8, reasoning_format: 'none', chat_format: 'Content-only' } }, chat_template_caps: { supports_tools: true, supports_tool_calls: true, supports_reasoning_effort: supportsReasoning } })); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      response.end(JSON.stringify({ choices: [{ message: { content: 'READY', reasoning_content: 'internal reasoning' } }] }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture address');
    const config: ArdentConfig['providers']['llamacpp'] = { base_url: `http://127.0.0.1:${address.port}`, model: 'fixture', api_key_env: 'NO_SUCH_TEST_KEY', request_timeout_seconds: 2, max_output_tokens: 1024, reasoning_effort: 'low' };
    const backend = new LlamaCppBackend(config, {});
    expect((await backend.discover()).contextTokens).toBe(8192);
    const reply = await backend.complete([{ role: 'user', content: 'Ready?' }], [], AbortSignal.timeout(2000), false);
    expect(reply).toMatchObject({ content: 'READY', reasoning: 'internal reasoning' });
    expect(lastBody).toMatchObject({ reasoning_effort: 'low', max_tokens: 1024 });
    supportsReasoning = false;
    await expect(new LlamaCppBackend(config, {}).complete([{ role: 'user', content: 'Ready?' }], [], AbortSignal.timeout(2000), false)).rejects.toThrow('not advertised');
  });
  it('assembles fragmented UTF-8 and two interleaved tool calls, and reports malformed, rate, context, timeout, and abort errors', async () => {
    let mode = 'fragmented';
    let rateAttempts = 0;
    const server = createServer((_request, response) => {
      if (mode === 'rate') { response.writeHead(429).end('{}'); return; }
      if (mode === 'transient' && rateAttempts++ === 0) { response.writeHead(429).end('{}'); return; }
      if (mode === 'context') { response.writeHead(413).end('{}'); return; }
      response.setHeader('Content-Type', 'text/event-stream');
      if (mode === 'malformed') { response.end('data: {invalid\n\ndata: [DONE]\n\n'); return; }
      if (mode === 'hang') return;
      const events = [
        { choices: [{ delta: { content: 'Café ', tool_calls: [
          { index: 0, id: 'call-search', type: 'function', function: { name: 'news_', arguments: '{"query":"caf' } },
          { index: 1, id: 'call-article', type: 'function', function: { name: 'news_', arguments: '{"url":"https://example.test/' } },
        ] } }] },
        { choices: [{ delta: { content: 'résumé', tool_calls: [
          { index: 1, function: { name: 'article', arguments: 'news"}' } },
          { index: 0, function: { name: 'search', arguments: 'é"}' } },
        ] } }] },
      ];
      const bytes = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
      const accent = bytes.indexOf(Buffer.from('é'));
      response.write(bytes.subarray(0, accent + 1));
      setTimeout(() => response.end(bytes.subarray(accent + 1)), 10);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture address');
    const config: ArdentConfig['providers']['llamacpp'] = {
      base_url: `http://127.0.0.1:${address.port}`, model: 'fixture', api_key_env: 'NO_SUCH_TEST_KEY', request_timeout_seconds: 1,
    };
    const backend = new LlamaCppBackend(config, {});
    const messages = [{ role: 'user' as const, content: 'Research the update' }];
    const result = await backend.complete(messages, [], AbortSignal.timeout(5_000));
    expect(result.content).toBe('Café résumé');
    expect(result.toolCalls.map(call => [call.id, call.function.name, JSON.parse(call.function.arguments)])).toEqual([
      ['call-search', 'news_search', { query: 'café' }],
      ['call-article', 'news_article', { url: 'https://example.test/news' }],
    ]);
    mode = 'malformed';
    await expect(backend.complete(messages, [], AbortSignal.timeout(5_000))).rejects.toThrow();
    mode = 'rate';
    await expect(backend.complete(messages, [], AbortSignal.timeout(5_000))).rejects.toThrow('HTTP 429');
    mode = 'transient';
    rateAttempts = 0;
    expect((await backend.complete(messages, [], AbortSignal.timeout(5_000))).content).toBe('Café résumé');
    expect(rateAttempts).toBe(2);
    mode = 'context';
    await expect(backend.complete(messages, [], AbortSignal.timeout(5_000))).rejects.toThrow('HTTP 413');
    mode = 'hang';
    await expect(backend.complete(messages, [], AbortSignal.timeout(5_000))).rejects.toThrow();
    const cancelled = new AbortController();
    const pending = backend.complete(messages, [], cancelled.signal);
    setTimeout(() => cancelled.abort('fixture interruption'), 20);
    await expect(pending).rejects.toThrow();
  });
});
