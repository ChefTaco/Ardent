import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArdentApi } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { initTestProfile } from './helpers.js';

const token = 'fixture-management-token';
const headers = { Authorization: `Bearer ${token}` };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-task-list-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await initTestProfile(dir);
  const loaded = await loadConfig(dir);
  const env: NodeJS.ProcessEnv = { ARDENT_API_TOKEN: token };
  const runtime = new ArdentRuntime(dir, loaded.config, env);
  cleanup.push(() => runtime.close());
  return { runtime, app: createArdentApi(runtime, loaded, env) };
}
type Page = { tasks: Array<{ id: string; state: string; caller: string; context: string; created_ms: number }>; next: string | null };

describe('GET /api/v1/tasks pagination and filters', () => {
  it('pages through every task newest first with a cursor', async () => {
    const { runtime, app } = await setup();
    let now = 1_790_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const ids: string[] = [];
    // Two tasks share a creation time so the cursor must break the tie by id.
    for (let index = 0; index < 7; index += 1) { if (index !== 3) now += 1000; ids.push(runtime.accept(`Prompt ${index}`, index % 2 ? 'peer-a' : 'management').id); }
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const response = await app.request(`/api/v1/tasks?limit=3${after ? `&after=${after}` : ''}`, { headers });
      expect(response.status).toBe(200);
      const page = await response.json() as Page;
      seen.push(...page.tasks.map(task => task.id));
      after = page.next;
      pages += 1;
    } while (after);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect(seen.map(id => runtime.store.get(id)!.created_ms)).toEqual([...seen.map(id => runtime.store.get(id)!.created_ms)].sort((a, b) => b - a));
    // The last page says so; an old client that ignores next still gets the newest tasks.
    const all = await (await app.request('/api/v1/tasks', { headers })).json() as Page;
    expect(all.tasks).toHaveLength(7);
    expect(all.next).toBeNull();
    expect(all.tasks[0]!.id).toBe(ids[6]);
  });

  it('filters by state, context, caller and time, and refuses bad filters', async () => {
    const { runtime, app } = await setup();
    let now = 1_790_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const first = runtime.accept('First', 'management');
    now += 60_000;
    const second = runtime.accept('Second', 'peer-a', 'peer');
    now += 60_000;
    const third = runtime.accept('Third', 'management');
    runtime.store.setState(third.id, 'failed', null, 'fixture');
    const list = async (query: string) => (await (await app.request(`/api/v1/tasks?${query}`, { headers })).json() as Page).tasks.map(task => task.id);
    expect(await list('state=failed')).toEqual([third.id]);
    expect(await list('state=queued,failed')).toEqual([third.id, second.id, first.id]);
    expect(await list('context=peer')).toEqual([second.id]);
    expect(await list('caller=management')).toEqual([third.id, first.id]);
    expect(await list(`since=${first.created_ms + 1}`)).toEqual([third.id, second.id]);
    expect(await list(`since=${new Date(second.created_ms).toISOString()}&until=${third.created_ms}`)).toEqual([second.id]);
    for (const bad of ['state=done', 'context=other', 'since=yesterday', 'after=not-a-cursor', 'limit=101'])
      expect((await app.request(`/api/v1/tasks?${bad}`, { headers })).status, bad).toBe(400);
  });
});

describe('task stream', () => {
  it('wakes on a journal append instead of polling', async () => {
    const { runtime, app } = await setup();
    const task = runtime.accept('Prompt', 'management');
    const response = await app.request(`/api/v1/tasks/${task.id}/stream`, { headers });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    const readUntil = async (needle: string, ms: number) => {
      const deadline = Date.now() + ms;
      while (!body.includes(needle)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        const part = await Promise.race([reader.read(), new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), remaining))]);
        if (part === 'timeout') return false;
        if (part.done) return body.includes(needle);
        body += decoder.decode(part.value, { stream: true });
      }
      return true;
    };
    cleanup.push(() => reader.cancel().catch(() => undefined));
    expect(await readUntil('"kind":"accepted"', 2000)).toBe(true);
    // A journal event reaches the stream well before the one-second fallback poll.
    const appended = Date.now();
    runtime.store.append(task.id, 'fixture_event', { n: 1 });
    expect(await readUntil('fixture_event', 2000)).toBe(true);
    expect(Date.now() - appended).toBeLessThan(500);
    runtime.store.setState(task.id, 'cancelled', null, null);
    expect(await readUntil('task.done', 2000)).toBe(true);
  });

  it('sends a keepalive comment on an idle stream', async () => {
    const { runtime, app } = await setup();
    const task = runtime.accept('Prompt', 'management');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const response = await app.request(`/api/v1/tasks/${task.id}/stream`, { headers });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    const pump = (async () => { for (let part = await reader.read(); !part.done; part = await reader.read()) body += decoder.decode(part.value, { stream: true }); })();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(body).toContain(': keepalive');
    runtime.store.setState(task.id, 'cancelled', null, null);
    await vi.advanceTimersByTimeAsync(2_000);
    await pump;
    expect(body).toContain('task.done');
  });
});
