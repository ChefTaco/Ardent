import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { Sha256, uuidFromKey } from '../src/sha256.js';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

/** Bundle the default entry as a browser would load it: any Node built-in fails the build. */
async function browserBundle(): Promise<{ code: string; inputs: string[] }> {
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'iife', globalName: 'ArdentClient',
    target: ['es2022'], write: false, metafile: true, logLevel: 'silent' });
  return { code: result.outputFiles[0]!.text, inputs: Object.keys(result.metafile.inputs) };
}

/** Only web platform globals: no process, Buffer, require or module. */
function browserGlobals(fetch: (input: string, init: RequestInit) => Promise<Response>): Record<string, unknown> {
  const names = ['URL', 'URLSearchParams', 'Headers', 'Request', 'Response', 'ReadableStream', 'WritableStream', 'TransformStream', 'TextEncoder', 'TextDecoder',
    'TextDecoderStream', 'AbortController', 'AbortSignal', 'DOMException', 'Blob', 'crypto', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'structuredClone',
    'atob', 'btoa', 'Event', 'EventTarget'] as const;
  const scope: Record<string, unknown> = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  scope['fetch'] = fetch;
  scope['window'] = scope;
  scope['globalThis'] = scope;
  scope['self'] = scope;
  return scope;
}

describe('browser build', () => {
  it('bundles for the browser with no Node built-ins and runs with web globals only', async () => {
    const { code, inputs } = await browserBundle();
    expect(inputs.filter(input => /^node:|(?:^|\/)node_modules\/(?:jose|hono)\//.test(input))).toEqual([]);
    expect(code).not.toMatch(/\brequire\(["']node:|from ["']node:/);
    const content = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(200_000)]);
    const sha = createHash('sha256').update(content).digest('hex');
    const task = { id: '11111111-1111-4111-8111-111111111111', state: 'completed', result: 'Done' };
    const seen: string[] = [];
    const fetch = async (input: string, init: RequestInit) => {
      const url = new URL(input);
      seen.push(`${init.method ?? 'GET'} ${url.pathname}`);
      if (new Headers(init.headers).get('authorization') !== 'Bearer fixture-token') return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } }, { status: 401 });
      if (url.pathname === `/api/v1/tasks/${task.id}`) return Response.json(task);
      if (url.pathname === `/api/v1/tasks/${task.id}/stream`)
        return new Response(`event: task.event\nid: 1\ndata: {"sequence":1,"task_id":"${task.id}","kind":"accepted","created_ms":1}\n\nevent: task.done\ndata: ${JSON.stringify(task)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      if (url.pathname === `/api/v1/artifacts/${sha}/content`) {
        const range = /^bytes=(\d+)-$/.exec(new Headers(init.headers).get('range') ?? '');
        const start = range ? Number(range[1]) : 0;
        return new Response(content.subarray(start), { status: range ? 206 : 200, headers: { 'content-type': 'application/pdf', 'x-content-sha256': sha,
          'content-length': String(content.length - start), ...(range ? { 'content-range': `bytes ${start}-${content.length - 1}/${content.length}` } : {}) } });
      }
      return Response.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 });
    };
    const scope = browserGlobals(fetch);
    runInNewContext(code, scope);
    const exports = scope['ArdentClient'] as typeof import('../src/index.js');
    expect(typeof exports.createArdentClient).toBe('function');
    expect(runInNewContext('typeof process + typeof Buffer + typeof require', scope)).toBe('undefinedundefinedundefined');
    const ardent = exports.createArdentClient({ transport: exports.direct({ baseUrl: 'https://ardent.example.com', getToken: () => 'fixture-token' }) });
    const events: number[] = [];
    expect(await ardent.tasks.follow(task.id, { onEvent: event => { events.push(event.sequence); } })).toMatchObject({ state: 'completed' });
    expect(events).toEqual([1]);
    const download = await ardent.artifacts.download(sha, { resumeFrom: new Blob([content.subarray(0, 50_000)]) });
    const parts: Uint8Array[] = [];
    const reader = download.stream.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); }
    expect(Buffer.concat(parts).equals(content.subarray(50_000))).toBe(true);
    expect(seen).toContain(`GET /api/v1/artifacts/${sha}/content`);
    const bad = exports.createArdentClient({ transport: exports.direct({ baseUrl: 'https://ardent.example.com', getToken: () => 'wrong-fixture-token' }) });
    const error = await bad.tasks.get(task.id).catch((caught: unknown) => caught);
    expect((error as Error).name).toBe('UnauthorizedError');
  });
});

describe('SHA-256', () => {
  it('matches node:crypto for every split of the input', () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const data = randomBytes(size);
      const expected = createHash('sha256').update(data).digest('hex');
      expect(new Sha256().update(data).hex()).toBe(expected);
      const split = new Sha256();
      for (let offset = 0; offset < size; offset += 37) split.update(data.subarray(offset, offset + 37));
      expect(split.hex()).toBe(expected);
      expect(split.length).toBe(size);
    }
    expect(() => new Sha256().update(Buffer.from('a')).update(new Uint8Array(0))).not.toThrow();
  });

  it('derives a stable version 8 UUID from an idempotency key', () => {
    expect(uuidFromKey('report-key')).toBe(uuidFromKey('report-key'));
    expect(uuidFromKey('report-key')).not.toBe(uuidFromKey('report-key-2'));
    expect(uuidFromKey('report-key')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
