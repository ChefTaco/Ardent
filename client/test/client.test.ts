import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HiveError } from '@hivemagnus/hive-common/errors';
import {
  ArdentClientError, ConflictError, createArdentClient, DigestMismatchError, direct, NotFoundError, TransportError, UnauthorizedError,
  UnsupportedCapabilityError, viaMagnus, type ArdentClient, type TaskEvent,
} from '../src/index.js';
import { run as runExample } from '../examples/cli.mjs';
import { ardent, cleanup, fakeMagnus, faultyProxy, heldTask, TOKEN } from './fixtures.js';

afterEach(cleanup);

const fast = { maxAttempts: 3, baseMs: 20, maxMs: 100 };
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const client = (baseUrl: string, getToken: () => string = () => TOKEN) =>
  createArdentClient({ transport: direct({ baseUrl, getToken }), retryPolicy: fast });
async function bytes(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
}
async function waitFor(ardentClient: ArdentClient, id: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const task = await ardentClient.tasks.get(id);
    if (!['queued', 'running'].includes(task.state)) return task.state;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Task did not finish');
}

describe('example CLI: submit, follow, download', () => {
  it('follows across two dropped streams to the final outcome and resumes a reset download with a verified digest', async () => {
    const server = await ardent({ size: 3 * 1024 * 1024 });
    const proxy = await faultyProxy(server.url, { streamDrops: 2, contentResets: 1, resetAfter: 1024 * 1024 + 7 });
    const out = await mkdtemp(join(tmpdir(), 'ardent-client-out-'));
    try {
      let streamed = '';
      const summary = await runExample({ argv: ['--url', proxy.url, '--prompt', 'Write the report', '--out', out], env: { ARDENT_TOKEN: TOKEN }, log: (text: string) => { streamed += text; } });
      expect(summary).toMatchObject({ state: 'completed', result: 'The report is ready.' });
      expect(summary.reconnects).toBeGreaterThanOrEqual(2);
      expect(streamed).toContain('The report is ready.');
      // Three stream connections: the two dropped ones resumed from the last event they delivered.
      const streams = proxy.log.filter(entry => entry.url.includes('/stream'));
      expect(streams.length).toBeGreaterThanOrEqual(3);
      expect(streams[1]?.lastEventId).toMatch(/^\d+$/);
      expect(streams[1]?.url).toContain(`after=${streams[1]?.lastEventId}`);
      expect(Number(streams[2]?.lastEventId)).toBeGreaterThan(Number(streams[1]?.lastEventId));
      // Every journaled event was delivered once.
      const journal = await client(server.url).tasks.events(summary.task_id);
      expect(summary.events).toBe(journal.length);
      // The artifact download was reset once and resumed with Range and If-Range.
      expect(summary.downloads).toHaveLength(1);
      const download = summary.downloads[0]!;
      expect(download).toMatchObject({ sha256: sha256(server.content), size: server.content.length, resumes: 1, verified: true });
      const contents = proxy.log.filter(entry => entry.url.endsWith('/content'));
      expect(contents.map(entry => [entry.range, entry.ifRange])).toEqual([[undefined, undefined], [`bytes=${1024 * 1024 + 7}-`, `"${download.sha256}"`]]);
      expect(sha256(await readFile(download.path))).toBe(download.sha256);
      expect(await readdir(out)).toEqual(['report.pdf']);
    } finally { await rm(out, { recursive: true, force: true }); }
  }, 30_000);

  it('delivers events in order exactly once to onEvent across drops, and live text to onText', async () => {
    const server = await ardent({ size: 1024 });
    const proxy = await faultyProxy(server.url, { streamDrops: 2 });
    const ardentClient = client(proxy.url);
    const accepted = await ardentClient.tasks.submit({ prompt: 'Write the report', idempotencyKey: 'report-1' });
    const seen: TaskEvent[] = [];
    let text = '';
    const task = await ardentClient.tasks.follow(accepted.task_id, { onEvent: event => { seen.push(event); }, onText: update => { text = update.kind === 'text' ? update.text : text + update.text; } });
    expect(task.state).toBe('completed');
    expect(task.result).toBe('The report is ready.');
    expect(seen.map(event => event.sequence)).toEqual((await ardentClient.tasks.events(task.id)).map(event => event.sequence));
    expect(text).toBe('The report is ready.');
    // Resuming after a cursor skips what was handled.
    const tail: number[] = [];
    await ardentClient.tasks.follow(task.id, { after: seen[2]!.sequence, onEvent: event => { tail.push(event.sequence); } });
    expect(tail).toEqual(seen.slice(3).map(event => event.sequence));
  }, 20_000);
});

describe('artifact downloads', () => {
  it('resumes from bytes the caller already holds, verifies the whole file, and handles an already complete prefix', async () => {
    const server = await ardent({ size: 256 * 1024 });
    const ardentClient = client(server.url);
    const accepted = await ardentClient.tasks.submit({ prompt: 'Write the report' });
    expect(await waitFor(ardentClient, accepted.task_id)).toBe('completed');
    const [artifact] = await ardentClient.artifacts.list(accepted.task_id);
    const sha = artifact!.manifest.sha256;
    expect(await ardentClient.artifacts.manifest(sha)).toMatchObject({ manifest: { sha256: sha, name: 'report.pdf' } });
    expect(await ardentClient.artifacts.manifest(sha, { v2: true })).toMatchObject({ manifest: { schema_version: '1.1', sha256: sha } });
    expect(await ardentClient.artifacts.renditions(sha)).toEqual([expect.objectContaining({ sha256: sha, role: 'original' })]);
    const half = server.content.subarray(0, 100_000);
    const resumed = await ardentClient.artifacts.download(sha, { resumeFrom: new Blob([half]) });
    expect(resumed).toMatchObject({ offset: half.length, size: server.content.length, mime: 'application/pdf', filename: 'report.pdf' });
    expect(Buffer.concat([half, await bytes(resumed.stream)]).equals(server.content)).toBe(true);
    const complete = await ardentClient.artifacts.download(sha, { resumeFrom: server.content });
    expect((await bytes(complete.stream)).length).toBe(0);
    // A wrong prefix fails the digest and the stream errors instead of closing.
    const wrong = await ardentClient.artifacts.download(sha, { resumeFrom: Buffer.alloc(10) });
    await expect(bytes(wrong.stream)).rejects.toBeInstanceOf(DigestMismatchError);
    // `download` purpose always picks the original.
    expect((await ardentClient.artifacts.download(sha, { rendition: { purpose: 'download' } })).sha256).toBe(sha);
    await expect(ardentClient.artifacts.download('f'.repeat(64))).rejects.toBeInstanceOf(NotFoundError);
  }, 20_000);

  it('errors with DigestMismatchError when the bytes change in transit', async () => {
    const server = await ardent({ size: 64 * 1024 });
    const proxy = await faultyProxy(server.url, { corrupt: true });
    const ardentClient = client(proxy.url);
    const accepted = await ardentClient.tasks.submit({ prompt: 'Write the report' });
    expect(await waitFor(ardentClient, accepted.task_id)).toBe('completed');
    const [artifact] = await ardentClient.artifacts.list(accepted.task_id);
    const download = await ardentClient.artifacts.download(artifact!.manifest.sha256);
    const error = await bytes(download.stream).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DigestMismatchError);
    expect(error).toBeInstanceOf(HiveError);
    expect((error as DigestMismatchError).expected).toBe(artifact!.manifest.sha256);
  }, 20_000);
});

describe('recovery and lineage', () => {
  it('reads and decides a held task, then follows its continuation', async () => {
    const held = await heldTask();
    const ardentClient = client(held.url);
    const recovery = await ardentClient.recovery.get(held.taskId);
    expect(recovery).toMatchObject({ status: 'awaiting_decision', reason: { code: 'UNSETTLED_EXTERNAL_WRITE' }, attempt: 1 });
    expect(recovery?.actions).toContain('mark_applied');
    expect((await ardentClient.tasks.get(held.taskId))).toMatchObject({ state: 'unknown', recovery: { status: 'awaiting_decision' } });
    expect((await ardentClient.status()).recovery).toMatchObject({ awaiting_decision: 1 });
    await expect(ardentClient.recovery.decide(held.taskId, { action: 'mark_applied', result: { written: 'yes' } })).rejects.toMatchObject({ status: 400 });
    const decided = await ardentClient.recovery.decide(held.taskId, { action: 'mark_applied', result: { written: true, key: 'operator' }, note: 'Checked the target system' });
    expect(decided).toMatchObject({ status: 'resolved', decided: { action: 'mark_applied' } });
    const continuation = decided.continuation_task_id!;
    expect((await ardentClient.recovery.decide(held.taskId, { action: 'mark_applied' })).continuation_task_id).toBe(continuation);
    await expect(ardentClient.recovery.decide(held.taskId, { action: 'abandon' })).rejects.toBeInstanceOf(ConflictError);
    expect((await ardentClient.tasks.follow(continuation)).state).toBe('completed');
    const lineage = await ardentClient.lineage(held.taskId);
    expect(lineage.continuations.map(item => item.local_task_id)).toEqual([continuation]);
    // A task that was never interrupted has no recovery; a missing one is not found.
    expect(await ardentClient.recovery.get(held.completedId)).toBeNull();
    await expect(ardentClient.recovery.get('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    await expect(ardentClient.lineage('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
  }, 20_000);
});

describe('errors, authentication and task control', () => {
  it('asks getToken() again once after a 401 and maps refusals to typed errors', async () => {
    const server = await ardent({ size: 1024, delayMs: 50 });
    const calls: boolean[] = [];
    const rotating = createArdentClient({ retryPolicy: fast, transport: direct({ baseUrl: server.url, getToken: ({ refresh }) => { calls.push(refresh); return refresh ? TOKEN : 'expired-fixture-token'; } }) });
    expect((await rotating.status()).profile).toBe('assistant');
    expect(calls).toEqual([false, true]);
    const refused = client(server.url, () => 'wrong-fixture-token');
    const unauthorized = await refused.status().catch((error: unknown) => error);
    expect(unauthorized).toBeInstanceOf(UnauthorizedError);
    expect(unauthorized).toBeInstanceOf(ArdentClientError);
    expect(HiveError.is(unauthorized, 'UNAUTHORIZED')).toBe(true);
    await expect(refused.tasks.follow('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(UnauthorizedError);

    const ardentClient = client(server.url);
    const first = await ardentClient.tasks.submit({ prompt: 'Write the report', idempotencyKey: 'same-key' });
    expect((await ardentClient.tasks.submit({ prompt: 'Write the report', idempotencyKey: 'same-key' })).task_id).toBe(first.task_id);
    const conflict = await ardentClient.tasks.submit({ prompt: 'Something else', idempotencyKey: 'same-key' }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ConflictError);
    expect((conflict as ConflictError).idempotency).toBe(true);
    expect(await waitFor(ardentClient, first.task_id)).toBe('completed');
    const paused = await ardentClient.tasks.pause(first.task_id).catch((error: unknown) => error);
    expect(paused).toBeInstanceOf(ConflictError);
    expect((paused as ConflictError).idempotency).toBe(false);
    expect((await ardentClient.tasks.cancel(first.task_id)).state).toBe('completed');
    await expect(ardentClient.tasks.get('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    await expect(ardentClient.tasks.follow('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    await expect(ardentClient.tasks.get('../config')).rejects.toBeInstanceOf(NotFoundError);
    expect((await ardentClient.tasks.list({ limit: 5 })).map(task => task.id)).toContain(first.task_id);
    const session = await ardentClient.sessions.open('client-session');
    const inSession = await ardentClient.tasks.submit({ prompt: 'Write the report', sessionId: session.id });
    expect(await waitFor(ardentClient, inSession.task_id)).toBe('completed');
    expect((await ardentClient.sessions.list()).map(item => item.id)).toContain(session.id);
    expect((await ardentClient.sessions.messages(session.id)).map(message => message.role)).toEqual(['user', 'assistant']);
  }, 20_000);

  it('pauses and resumes a queued task, and carries the execution context on submissions', async () => {
    const server = await ardent({ size: 1024, delayMs: 400 });
    const execution = { v: 1 as const, root: 'hx1:studio:local:request:req-1', self: 'hx1:studio:local:step:req-1/1' };
    const ardentClient = createArdentClient({ transport: direct({ baseUrl: server.url, getToken: () => TOKEN }), execution, retryPolicy: fast });
    const running = await ardentClient.tasks.submit({ prompt: 'Write the report' });
    const queued = await ardentClient.tasks.submit({ prompt: 'Write the second report' });
    expect(await ardentClient.tasks.pause(queued.task_id)).toMatchObject({ task_id: queued.task_id, admission: 'paused' });
    expect(await ardentClient.tasks.resume(queued.task_id)).toMatchObject({ admission: 'open' });
    expect(await waitFor(ardentClient, running.task_id)).toBe('completed');
    expect((await ardentClient.tasks.follow(queued.task_id)).state).toBe('completed');
    const task = await ardentClient.tasks.get(running.task_id);
    expect(task.execution).toMatchObject({ root: execution.root, parent: execution.self });
    expect((await ardentClient.lineage(running.task_id)).parent?.ref).toBe(execution.self);
  }, 20_000);

  it('raises TransportError when the profile cannot be reached, and honours AbortSignal', async () => {
    const unreachable = client('http://127.0.0.1:9');
    const error = await unreachable.status().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    const server = await ardent({ size: 1024, delayMs: 2000 });
    const ardentClient = client(server.url);
    const accepted = await ardentClient.tasks.submit({ prompt: 'Write the report' });
    const controller = new AbortController();
    const following = ardentClient.tasks.follow(accepted.task_id, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('stop following')), 100);
    await expect(following).rejects.toThrow('stop following');
    const aborted = new AbortController();
    aborted.abort(new Error('client closed'));
    await expect(createArdentClient({ transport: direct({ baseUrl: server.url, getToken: () => TOKEN }), signal: aborted.signal }).status()).rejects.toThrow('client closed');
    expect(() => direct({ baseUrl: 'ftp://example.com', getToken: () => TOKEN })).toThrow(ArdentClientError);
    expect(() => direct({ baseUrl: 'http://user:secret@example.com', getToken: () => TOKEN })).toThrow(/credentials/);
  }, 20_000);
});

describe('through Magnus', () => {
  const magnusClient = (url: string, nodeId = 'node-1', profile = 'assistant') =>
    createArdentClient({ transport: viaMagnus({ baseUrl: url, nodeId, profile, getToken: () => 'magnus-fixture-token' }), retryPolicy: fast,
      execution: { v: 1, root: 'hx1:studio:local:request:req-2' } });

  it('proxies reads, actions and the task stream, and raises UnsupportedCapabilityError for routes Magnus does not allow yet', async () => {
    const server = await ardent({ size: 64 * 1024 });
    const magnus = await fakeMagnus(server.url, { release: 'current' });
    const ardentClient = magnusClient(magnus.url);
    // Magnus accepts only UUID idempotency keys: another key maps to a stable UUID.
    const accepted = await ardentClient.tasks.submit({ prompt: 'Write the report', idempotencyKey: 'report-key' });
    expect((await ardentClient.tasks.submit({ prompt: 'Write the report', idempotencyKey: 'report-key' })).task_id).toBe(accepted.task_id);
    const submitted = magnus.actions.find(action => action['action'] === 'task-submit');
    expect(submitted).not.toHaveProperty('execution');
    expect((submitted?.['body'] as { idempotency_key: string }).idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const events: number[] = [];
    const task = await ardentClient.tasks.follow(accepted.task_id, { onEvent: event => { events.push(event.sequence); } });
    expect(task.state).toBe('completed');
    expect(events).toEqual((await ardentClient.tasks.events(task.id)).map(event => event.sequence));
    expect((await ardentClient.tasks.list()).map(item => item.id)).toContain(task.id);
    const [artifact] = await ardentClient.artifacts.list(task.id);
    const sha = artifact!.manifest.sha256;
    expect(await ardentClient.artifacts.manifest(sha)).toMatchObject({ manifest: { sha256: sha } });
    expect((await ardentClient.tasks.cancel(task.id)).state).toBe('completed');
    await expect(ardentClient.tasks.get('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    for (const call of [() => ardentClient.recovery.get(task.id), () => ardentClient.recovery.decide(task.id, { action: 'abandon' }), () => ardentClient.lineage(task.id),
      () => ardentClient.artifacts.download(sha), () => ardentClient.artifacts.renditions(sha), () => ardentClient.artifacts.manifest(sha, { v2: true }),
      () => ardentClient.artifacts.imports(), () => ardentClient.artifacts.import({ peer_id: 'peer', a2a_task_id: 'a2a-task', artifact_id: 'artifact' })]) {
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnsupportedCapabilityError);
      expect(HiveError.is(error, 'unsupported_capability')).toBe(true);
    }
    expect(await ardentClient.capabilities()).toMatchObject({ transport: 'magnus', profile: 'assistant', artifactTransfer: 2,
      features: { recovery: false, lineage: false, execution: false, artifactContent: false, renditions: false, imports: false }, magnus: { capabilities: { studio: 3 } } });
  }, 20_000);

  it('uses the Magnus 3.3.0 routes, actions and execution passthrough once Magnus advertises them', async () => {
    const held = await heldTask();
    const magnus = await fakeMagnus(held.url, { release: 'next' });
    const ardentClient = magnusClient(magnus.url);
    expect((await ardentClient.capabilities()).features).toEqual({ recovery: true, lineage: true, execution: true, artifactContent: true, renditions: true, imports: true });
    expect(await ardentClient.recovery.get(held.taskId)).toMatchObject({ status: 'awaiting_decision' });
    const decided = await ardentClient.recovery.decide(held.taskId, { action: 'mark_applied', result: { written: true, key: 'operator' } });
    expect(magnus.actions.at(-1)).toMatchObject({ action: 'task-recovery', target: held.taskId, body: { action: 'mark_applied' } });
    expect((await ardentClient.tasks.follow(decided.continuation_task_id!)).state).toBe('completed');
    expect((await ardentClient.lineage(held.taskId)).continuations).toHaveLength(1);
    await expect(ardentClient.recovery.get('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    expect(await ardentClient.recovery.get(held.completedId)).toBeNull();
    const accepted = await ardentClient.tasks.submit({ prompt: 'Say hello' });
    expect(magnus.actions.at(-1)).toMatchObject({ action: 'task-submit', execution: { root: 'hx1:studio:local:request:req-2' } });
    expect((await ardentClient.tasks.follow(accepted.task_id)).execution).toMatchObject({ root: 'hx1:studio:local:request:req-2' });
  }, 20_000);

  it('downloads with Range through the Magnus 3.3.0 content route, and maps an old profile to UnsupportedCapabilityError with versions', async () => {
    const server = await ardent({ size: 512 * 1024 });
    const magnus = await fakeMagnus(server.url, { release: 'next' });
    const ardentClient = magnusClient(magnus.url);
    const accepted = await ardentClient.tasks.submit({ prompt: 'Write the report' });
    expect((await ardentClient.tasks.follow(accepted.task_id)).state).toBe('completed');
    const [artifact] = await ardentClient.artifacts.list(accepted.task_id);
    const sha = artifact!.manifest.sha256;
    const prefix = server.content.subarray(0, 1000);
    const download = await ardentClient.artifacts.download(sha, { resumeFrom: prefix });
    expect(Buffer.concat([prefix, await bytes(download.stream)]).equals(server.content)).toBe(true);
    expect(await ardentClient.artifacts.renditions(sha)).toHaveLength(1);

    const old = await fakeMagnus(server.url, { release: 'next', oldProfile: true });
    const error = await magnusClient(old.url).recovery.get(accepted.task_id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedCapabilityError);
    expect(error).toMatchObject({ capability: 'ardent.recovery.v1', requiredVersion: '3.2.0', installedVersion: '3.1.4', status: 409 });
    // Without a readable installation report (a service identity), a refused route is still unsupported.
    const service = await fakeMagnus(server.url, { release: 'current', readableReport: false });
    await expect(magnusClient(service.url).lineage(accepted.task_id)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(() => viaMagnus({ baseUrl: magnus.url, nodeId: '../node', profile: 'assistant', getToken: () => 'magnus-fixture-token' })).toThrow(ArdentClientError);
  }, 20_000);
});
