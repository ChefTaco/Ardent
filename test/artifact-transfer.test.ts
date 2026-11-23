import { createHash, randomFillSync } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { appendFile, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { crc32 } from 'node:zlib';
import express from 'express';
import { AgentCard } from '@a2a-js/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ARTIFACT_TRANSFER_V2_MEDIA_TYPE, ARTIFACT_TRANSFER_V2_URN, formatReprDigest, selectRendition } from '@hivemagnus/hive-common/artifact';
import { createA2ASurface, type A2ASurface } from '../src/a2a-server.js';
import { createArdentApi } from '../src/api.js';
import { ArtifactTransfers } from '../src/artifact-transfer.js';
import { ArtifactManifestSchema } from '../src/artifact-manifests.js';
import { initProfile, loadConfig, type LoadedConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { TeamEnvelope } from '../src/team-contract.js';

const MiB = 1024 * 1024;
const LINK_TOKEN = 'fixture-token-transfer-link-1234';
const API_TOKEN = 'fixture-token-management-5678';
const env = { LINK_TOKEN, ARDENT_API_TOKEN: API_TOKEN };
const fast = { maxAttempts: 3, baseMs: 5, maxMs: 20, jitter: 'none' as const };

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Fill `size` bytes with random data after a fixed header, in 64 KiB chunks, without holding them. */
function* bytes(size: number, header: Uint8Array, trailer: Uint8Array = new Uint8Array()): Generator<Uint8Array> {
  yield header;
  let left = size - header.byteLength - trailer.byteLength;
  while (left > 0) { const chunk = randomFillSync(Buffer.allocUnsafe(Math.min(left, 64 * 1024))); left -= chunk.byteLength; yield chunk; }
  yield trailer;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.byteLength);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])));
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, crc]);
}
/** An RGBA PNG container of `size` bytes: signature, IHDR (color type 6), one IDAT of opaque payload, IEND. */
function png(size: number, width = 4096, height = 3072): Generator<Uint8Array> {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const head = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)]);
  const tail = chunk('IEND', Buffer.alloc(0));
  const idat = Buffer.alloc(8); idat.writeUInt32BE(size - head.byteLength - tail.byteLength - 12); idat.write('IDAT', 4, 'latin1');
  // The IDAT CRC is not checked by Ardent; four placeholder bytes keep the declared size exact.
  return bytes(size, Buffer.concat([head, idat]), Buffer.concat([Buffer.alloc(4), tail]));
}
const pdf = (size: number) => bytes(size, Buffer.from('%PDF-1.7\n'), Buffer.from('\n%%EOF\n'));

type Deliverable = { name: string; mime: 'application/pdf' | 'image/png'; size: number; preview?: boolean };

/** An exporting runtime whose plugin streams the deliverables a mission names into the store. */
async function exporter(deliverables: Record<string, Deliverable>, options: { advertiseV2?: boolean } = {}) {
  const dir = await temp('ardent-export-');
  await initProfile(dir);
  await writeFile(join(dir, 'peers.yaml'), 'schema_version: 1\npeers:\n  - id: receiver\n    url: http://127.0.0.1:9/\n    token_env: LINK_TOKEN\n');
  const loaded = await loadConfig(dir);
  const config = loaded.config;
  config.a2a.bindings = ['jsonrpc'];
  config.artifacts.max_bytes = 64 * MiB;
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const origin = `http://127.0.0.1:${address.port}`;
  config.a2a.public_url = origin;
  const runtime = new ArdentRuntime(dir, config, env);
  await runtime.usePlugins([{
    name: 'deliver',
    teamEnvelope: value => TeamEnvelope.parse(value),
    taskExecutor: ctx => ({ id: 'deliver', effect: 'possible', run: async () => {
      const envelope = ctx.envelope!;
      const produced: Array<{ name: string; sha256: string }> = [];
      for (const resource of envelope.mission.resources) {
        const item = deliverables[resource];
        if (!item) continue;
        const record = await ctx.runtime.artifactManifests.registerStream({ taskId: ctx.task.id, name: item.name, mime: item.mime,
          stream: Readable.from(item.mime === 'image/png' ? png(item.size) : pdf(item.size)), source: resource });
        produced.push({ name: item.name, sha256: record.manifest.sha256 });
        ctx.runtime.store.append(ctx.task.id, 'deliver_receipt', { name: item.name, sha256: record.manifest.sha256, mime: item.mime });
        if (item.preview) await ctx.runtime.artifactManifests.registerRendition({ originalSha256: record.manifest.sha256, role: 'preview', purpose: 'display',
          mime: 'image/webp', bytes: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(64, 7)]),
          transform: { name: 'fixture-resize', version: '1', params: { longest_side: 1600 } }, width: 1600, height: 1200, has_alpha: true });
      }
      return { effect_status: 'confirmed', answer: JSON.stringify({ team_result: { version: '1.0', mission_id: envelope.mission.id,
        mission_revision: envelope.mission.revision, task_id: envelope.task_id, outcome: 'completed', summary: 'Delivered fixtures',
        checks: [{ criterion: 'Deliver', status: 'pass', evidence: produced.map(item => `ardent-artifact:${item.sha256}`) }],
        artifacts: produced.map(item => ({ name: item.name, reference: `ardent-artifact:${item.sha256}`, sha256: item.sha256 })), uncertain_effects: [] } }) };
    } }),
    teamEvidence: (_ctx, _task, _envelope, events) => ({ references: [], artifacts: events.filter(event => event.kind === 'deliver_receipt')
      .map(event => z.object({ name: z.string(), sha256: z.string(), mime: z.string() }).parse(event.detail)) })
  }], env);
  const surface = await createA2ASurface(runtime, config, env);
  const app = express();
  if (options.advertiseV2 === false) {
    // An older peer: the same runtime behind a card without the transfer-v2 extension.
    const encoded = z.record(z.string(), z.unknown()).parse(AgentCard.toJSON(surface.card));
    const capabilities = z.record(z.string(), z.unknown()).parse(encoded.capabilities);
    app.get('/.well-known/agent-card.json', (_req, res) => { res.json({ ...encoded, capabilities: { ...capabilities, extensions: [] } }); });
  }
  const requests: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  app.use((req, _res, next) => { if (req.url.startsWith('/team/artifacts/')) requests.push({ url: req.url, headers: req.headers }); next(); });
  app.use(surface.app);
  server.on('request', app);
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    surface.grpcServer.forceShutdown();
    await surface.pushSender.drain();
    runtime.close();
  });
  return { dir, runtime, surface, origin, requests, loaded };
}

/** Submit a team mission to the exporter as the receiving peer and return the completed A2A task. */
async function deliver(origin: string, resources: string[]) {
  const id = `mission-${resources.join('-').replace(/[^a-z0-9-]/g, '')}-${Date.now()}`;
  const envelope = { version: '1.0', caller: 'receiver', task_id: id, objective: 'Deliver the fixtures', mission: { id, revision: 1, parent_task: null,
    constraints: ['Fixtures only'], allowed_actions: ['extension:deliver:deliver'], resources, deadline: Math.floor(Date.now() / 1000) + 600,
    acceptance_criteria: ['Deliver'], expected_artifacts: [] } };
  const response = await fetch(`${origin}/a2a/jsonrpc`, { method: 'POST', headers: { Authorization: `Bearer ${LINK_TOKEN}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { role: 'ROLE_USER', messageId: id, parts: [{ text: 'Deliver the fixtures' }], metadata: { hermesTeamTask: envelope } } } }) });
  const body = z.object({ result: z.object({ task: z.object({ id: z.string(), contextId: z.string(), status: z.object({ state: z.string() }).passthrough(),
    artifacts: z.array(z.object({ name: z.string(), parts: z.array(z.object({ text: z.string().optional(), data: z.unknown().optional(), mediaType: z.string().optional() }).passthrough()) }).passthrough()) }).passthrough() }).passthrough() })
    .parse(await response.json());
  const task = body.result.task;
  expect(task.status.state, JSON.stringify(task.status)).toBe('TASK_STATE_COMPLETED');
  const v2 = task.artifacts.filter(item => item.name === 'Team artifact export v2').map(item => z.object({ manifest_1_1: z.object({ artifact_id: z.string(), name: z.string(), sha256: z.string(), size: z.number() }).passthrough(),
    content_path: z.string() }).passthrough().parse(item.parts[0]?.data));
  const exportOf = (name: string) => { const found = v2.find(item => item.manifest_1_1.name === name); if (!found) throw new Error(`No export for ${name}`); return found; };
  return { task, exportOf };
}

async function receiver(origin: string, dir?: string) {
  const home = dir ?? await temp('ardent-receive-');
  if (!dir) {
    await initProfile(home);
    await writeFile(join(home, 'peers.yaml'), `schema_version: 1\npeers:\n  - id: exporter\n    url: ${origin}\n    token_env: LINK_TOKEN\n`);
  }
  const loaded = await loadConfig(home);
  loaded.config.artifacts.max_bytes = 64 * MiB;
  const runtime = new ArdentRuntime(home, loaded.config, env);
  let closed = false;
  const close = () => { if (!closed) { closed = true; runtime.close(); } };
  cleanup.push(close);
  return { dir: home, runtime, close, loaded };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const part of (await open(path)).createReadStream()) hash.update(z.instanceof(Buffer).parse(part));
  return hash.digest('hex');
}

describe('artifact transfer v2 between two runtimes', () => {
  it('moves a 48 MiB PDF and a 12 MiB RGBA PNG with bounded memory, byte-identical, with peer provenance', async () => {
    const source = await exporter({ 'item:pdf': { name: 'atlas.pdf', mime: 'application/pdf', size: 48 * MiB }, 'item:png': { name: 'map.png', mime: 'image/png', size: 12 * MiB, preview: true } });
    const { task, exportOf } = await deliver(source.origin, ['item:pdf', 'item:png']);
    // Both exports are larger than the v1 limit: the v1 consumer gets an explicit requirement, never a truncated descriptor.
    const required = task.artifacts.filter(item => item.name === 'Team artifact export requires v2').map(item => JSON.parse(item.parts[0]?.text ?? '{}') as { error: string; capability: string });
    expect(required).toHaveLength(2);
    expect(required.every(item => item.error === 'TRANSFER_REQUIRES_V2' && item.capability === ARTIFACT_TRANSFER_V2_URN)).toBe(true);
    expect(task.artifacts.find(item => item.name === 'Team artifact export v2')?.parts[0]?.mediaType).toBe(ARTIFACT_TRANSFER_V2_MEDIA_TYPE);
    const card = z.object({ capabilities: z.object({ extensions: z.array(z.object({ uri: z.string(), params: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough() }).passthrough()
      .parse(await (await fetch(`${source.origin}/.well-known/agent-card.json`)).json());
    expect(card.capabilities.extensions).toContainEqual(expect.objectContaining({ uri: ARTIFACT_TRANSFER_V2_URN, params: { max_bytes: 64 * MiB, range: true, renditions: true } }));

    const sink = await receiver(source.origin);
    const transfers = new ArtifactTransfers(sink.runtime, env, { retryPolicy: fast });
    const atlas = exportOf('atlas.pdf');
    const map = exportOf('map.png');
    // Collect garbage while sampling so the peak reflects retained memory, not collector lag.
    setFlagsFromString('--expose_gc');
    const gc = runInNewContext('gc') as () => void;
    gc();
    const before = process.memoryUsage();
    let samples = 0;
    let peakRss = before.rss, peakHeap = before.heapUsed;
    const sampler = setInterval(() => { if (++samples % 10 === 0) gc(); const now = process.memoryUsage(); peakRss = Math.max(peakRss, now.rss); peakHeap = Math.max(peakHeap, now.heapUsed); }, 5);
    let pdfImport;
    try {
      const pending = transfers.request({ peer_id: 'exporter', a2a_task_id: task.id, artifact_id: atlas.manifest_1_1.artifact_id });
      pdfImport = await transfers.run(pending.import_id);
    } finally { clearInterval(sampler); }
    expect(pdfImport).toMatchObject({ state: 'completed', protocol: 'v2', size: 48 * MiB, received_bytes: 48 * MiB, sha256: atlas.manifest_1_1.sha256, attempts: 1 });
    expect(pdfImport.error).toBeUndefined();
    // Memory is independent of the artifact size.
    expect(peakRss - before.rss).toBeLessThan(32 * MiB);
    expect(peakHeap - before.heapUsed).toBeLessThan(32 * MiB);
    const pngImport = await transfers.run(transfers.request({ peer_id: 'exporter', a2a_task_id: task.id, artifact_id: map.manifest_1_1.artifact_id }).import_id);
    expect(pngImport).toMatchObject({ state: 'completed', size: 12 * MiB });
    for (const item of [atlas, map]) {
      const sha = item.manifest_1_1.sha256;
      expect(await sha256File(join(sink.dir, 'artifacts', sha))).toBe(sha);
      expect(await sha256File(join(source.dir, 'artifacts', sha))).toBe(sha);
      const record = sink.runtime.artifactManifests.manifestV2(sha);
      expect(record?.manifest).toMatchObject({ schema_version: '1.1', sha256: sha, size: item.manifest_1_1.size, name: item.manifest_1_1.name,
        provenance: { producer_task_id: task.id, lineage: expect.arrayContaining([{ producer: 'a2a:exporter', source_id: `a2a-task:${task.id}` }]) } });
      // Every artifact keeps an immutable manifest.
      expect(() => sink.runtime.store.db.prepare('UPDATE artifact_manifests SET size=0 WHERE sha256=?').run(sha)).toThrow(/immutable/);
    }
    expect(await stat(join(sink.dir, 'artifacts', '.partial', pdfImport.import_id)).catch(() => undefined)).toBeUndefined();
    // The import's own completed task owns the manifest; a repeat request is the same completed import.
    expect(sink.runtime.store.get(pdfImport.local_task_id ?? '')?.state).toBe('completed');
    expect(transfers.request({ peer_id: 'exporter', a2a_task_id: task.id, artifact_id: atlas.manifest_1_1.artifact_id })).toMatchObject({ import_id: pdfImport.import_id, state: 'completed' });

    // The peer lists the PNG original first, then its exported preview, each fetchable by export ID.
    const listed = z.object({ renditions: z.array(z.object({ sha256: z.string(), role: z.string(), artifact_id: z.string(), content_path: z.string(),
      width: z.number().optional(), has_alpha: z.boolean().optional() }).passthrough()) })
      .parse(await (await fetch(`${source.origin}${map.content_path.replace('?', '/renditions?')}`, { headers: { Authorization: `Bearer ${LINK_TOKEN}` } })).json());
    expect(listed.renditions.map(item => item.role)).toEqual(['original', 'preview']);
    expect(listed.renditions[0]).toMatchObject({ sha256: map.manifest_1_1.sha256, width: 4096, has_alpha: true });
    const preview = await fetch(`${source.origin}${listed.renditions[1]!.content_path}`, { headers: { Authorization: `Bearer ${LINK_TOKEN}` } });
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('image/webp');
    expect(createHash('sha256').update(Buffer.from(await preview.arrayBuffer())).digest('hex')).toBe(listed.renditions[1]!.sha256);
    const manifest = z.object({ manifest: z.object({ schema_version: z.literal('1.1') }).passthrough() })
      .parse(await (await fetch(`${source.origin}${map.content_path.replace('?', '/manifest?')}`, { headers: { Authorization: `Bearer ${LINK_TOKEN}` } })).json());
    expect(manifest.manifest).toMatchObject({ sha256: map.manifest_1_1.sha256 });
  }, 180_000);

  it('resumes after the receiver stops at about 40% from exactly the retained bytes', async () => {
    const size = 24 * MiB;
    const source = await exporter({ 'item:pdf': { name: 'report.pdf', mime: 'application/pdf', size } });
    const { task, exportOf } = await deliver(source.origin, ['item:pdf']);
    const exported = exportOf('report.pdf');
    let sink = await receiver(source.origin);
    const stop = new AbortController();
    const first = new ArtifactTransfers(sink.runtime, env, { retryPolicy: fast, commitBytes: MiB,
      onProgress: progress => { if (progress.received_bytes >= 0.4 * size) stop.abort(new Error('Receiver stopped')); } });
    const pending = first.request({ peer_id: 'exporter', a2a_task_id: task.id, artifact_id: exported.manifest_1_1.artifact_id });
    await expect(first.run(pending.import_id, stop.signal)).rejects.toThrow();
    const interrupted = first.get(pending.import_id)!;
    expect(interrupted.state).toBe('transferring');
    const retained = interrupted.received_bytes;
    expect(retained).toBeGreaterThanOrEqual(0.4 * size);
    expect(retained).toBeLessThan(size);
    const partial = join(sink.dir, 'artifacts', '.partial', pending.import_id);
    expect((await stat(partial)).size).toBe(retained);
    // Bytes written after the last commit are not trusted: the restart discards them.
    await appendFile(partial, Buffer.alloc(4096, 0xee));
    sink.close();

    sink = await receiver(source.origin, sink.dir);
    const second = new ArtifactTransfers(sink.runtime, env, { retryPolicy: fast });
    source.requests.splice(0);
    expect(second.resumePending()).toEqual([pending.import_id]);
    const finished = await second.run(pending.import_id);
    expect(finished).toMatchObject({ state: 'completed', received_bytes: size, attempts: 2 });
    expect(source.requests).toHaveLength(1);
    expect(source.requests[0]?.headers.range).toBe(`bytes=${retained}-`);
    expect(source.requests[0]?.headers['if-range']).toBe(`"${exported.manifest_1_1.sha256}"`);
    expect(await sha256File(join(sink.dir, 'artifacts', exported.manifest_1_1.sha256))).toBe(exported.manifest_1_1.sha256);
  }, 120_000);

  it('retries a busy peer and a dropped response within one run, continuing from the retained bytes', async () => {
    const size = 6 * MiB;
    const source = await exporter({ 'item:pdf': { name: 'drop.pdf', mime: 'application/pdf', size } });
    const { task, exportOf } = await deliver(source.origin, ['item:pdf']);
    const exported = exportOf('drop.pdf');
    const sink = await receiver(source.origin);
    let calls = 0;
    const flaky: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes('/team/artifacts/')) return fetch(input, init);
      calls++;
      if (calls === 1) return new Response('busy', { status: 503, headers: { 'Retry-After': '0' } });
      const response = await fetch(input, init);
      if (calls !== 2 || !response.body) return response;
      // Cut the second response after 2 MiB, as a dropped connection would.
      let passed = 0;
      const cut = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(part, controller) {
        passed += part.byteLength;
        if (passed > 2 * MiB) controller.error(new TypeError('terminated'));
        else controller.enqueue(part);
      } }));
      return new Response(cut, { status: response.status, headers: response.headers });
    };
    const transfers = new ArtifactTransfers(sink.runtime, env, { retryPolicy: fast, fetch: flaky, commitBytes: 512 * 1024 });
    const pending = transfers.request({ peer_id: 'exporter', a2a_task_id: task.id, artifact_id: exported.manifest_1_1.artifact_id });
    source.requests.splice(0);
    const result = await transfers.run(pending.import_id);
    expect(result).toMatchObject({ state: 'completed', received_bytes: size, attempts: 3 });
    expect(source.requests).toHaveLength(2);
    expect(source.requests[0]?.headers.range).toBe('bytes=0-');
    const resumedAt = Number(/^bytes=(\d+)-$/.exec(String(source.requests[1]?.headers.range))?.[1]);
    expect(resumedAt).toBeGreaterThan(0);
    expect(resumedAt).toBeLessThanOrEqual(2 * MiB);
    expect(await sha256File(join(sink.dir, 'artifacts', exported.manifest_1_1.sha256))).toBe(exported.manifest_1_1.sha256);
  }, 60_000);

  it('rejects a byte flipped on the server mid-transfer and registers nothing', async () => {
    const size = 8 * MiB;
    const source = await exporter({ 'item:pdf': { name: 'flip.pdf', mime: 'application/pdf', size } });
    const { task, exportOf } = await deliver(source.origin, ['item:pdf']);
    const exported = exportOf('flip.pdf');
    const sha = exported.manifest_1_1.sha256;
    const sink = await receiver(source.origin);
    let flipped: Promise<void> | undefined;
    const transfers = new ArtifactTransfers(sink.runtime, env, { retryPolicy: fast, onProgress: progress => {
      if (!flipped && progress.received_bytes >= size / 4) flipped = (async () => {
        const file = await open(join(source.dir, 'artifacts', sha), 'r+');
        const at = size - 1024;
        const byte = Buffer.alloc(1);
        await file.read(byte, 0, 1, at);
        byte[0] = (byte[0] ?? 0) ^ 0xff;
        await file.write(byte, 0, 1, at);
        await file.close();
      })();
    } });
    const pending = transfers.request({ peer_id: 'exporter', a2a_task_id: task.id, artifact_id: exported.manifest_1_1.artifact_id });
    const result = await transfers.run(pending.import_id);
    await flipped;
    expect(result).toMatchObject({ state: 'failed', error: { code: 'DIGEST_MISMATCH' } });
    expect(await sink.runtime.artifacts.stat(sha)).toBeUndefined();
    expect(sink.runtime.artifactManifests.manifestV2(sha)).toBeUndefined();
    expect(await stat(join(sink.dir, 'artifacts', '.partial', pending.import_id)).catch(() => undefined)).toBeUndefined();
    // No automatic retry: the failure stands until an operator reissues the import.
    expect(transfers.get(pending.import_id)).toMatchObject({ state: 'failed', attempts: 1 });
  }, 60_000);

  it('requires v2 above 2 MiB from a peer without the URN and keeps the v1 path for 1 MiB', async () => {
    const source = await exporter({ 'item:big': { name: 'big.pdf', mime: 'application/pdf', size: 3 * MiB }, 'item:small': { name: 'small.pdf', mime: 'application/pdf', size: MiB } },
      { advertiseV2: false });
    const { task, exportOf } = await deliver(source.origin, ['item:big', 'item:small']);
    // The unchanged v1 text descriptor is still emitted for the small export.
    const v1 = task.artifacts.filter(item => item.name === 'Team artifact export').map(item => JSON.parse(item.parts[0]?.text ?? '{}') as Record<string, unknown>);
    expect(v1).toHaveLength(1);
    expect(Object.keys(v1[0] ?? {}).sort()).toEqual(['artifact_id', 'artifact_manifest', 'mime', 'name', 'producer_task_id', 'sha256', 'size']);
    expect(ArtifactManifestSchema.parse(v1[0]?.artifact_manifest).schema_version).toBe('1.0');
    const sink = await receiver(source.origin);
    const transfers = new ArtifactTransfers(sink.runtime, env, { retryPolicy: fast });
    const big = await transfers.run(transfers.request({ peer_id: 'exporter', a2a_task_id: task.id, artifact_id: exportOf('big.pdf').manifest_1_1.artifact_id }).import_id);
    expect(big).toMatchObject({ state: 'failed', error: { code: 'TRANSFER_REQUIRES_V2' } });
    expect(big.error?.message).toContain(ARTIFACT_TRANSFER_V2_URN);
    source.requests.splice(0);
    const small = await transfers.run(transfers.request({ peer_id: 'exporter', a2a_task_id: task.id, artifact_id: exportOf('small.pdf').manifest_1_1.artifact_id }).import_id);
    expect(small).toMatchObject({ state: 'completed', protocol: 'v1', size: MiB });
    expect(source.requests).toHaveLength(1);
    expect(source.requests[0]?.headers.range).toBeUndefined();
    expect(await sha256File(join(sink.dir, 'artifacts', exportOf('small.pdf').manifest_1_1.sha256))).toBe(exportOf('small.pdf').manifest_1_1.sha256);
  }, 60_000);
});

describe('artifact content, ranges and renditions', () => {
  async function local() {
    const dir = await temp('ardent-content-');
    await initProfile(dir);
    const loaded: LoadedConfig = await loadConfig(dir);
    loaded.config.artifacts.max_bytes = 16 * MiB;
    const runtime = new ArdentRuntime(dir, loaded.config, env);
    cleanup.push(() => runtime.close());
    const app = createArdentApi(runtime, loaded, env);
    const call = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
      app.request(path, { ...init, headers: { Authorization: `Bearer ${API_TOKEN}`, ...headers } });
    return { dir, runtime, app, call };
  }

  it('serves 206 slices, 416 for a bad range and the C4 headers, and keeps the octet-stream route', async () => {
    const { runtime, call } = await local();
    const task = runtime.accept('Produce a report', 'management', 'mission');
    const content = Buffer.concat([...pdf(3 * MiB)].map(part => Buffer.from(part)));
    const record = await runtime.artifactManifests.registerStream({ taskId: task.id, name: 'report.pdf', mime: 'application/pdf', stream: Readable.from([content]), source: 'fixture' });
    const sha = record.manifest.sha256;
    const whole = await call(`/api/v1/artifacts/${sha}/content`);
    expect(whole.status).toBe(200);
    expect(Object.fromEntries(['accept-ranges', 'etag', 'repr-digest', 'x-content-sha256', 'content-type', 'content-disposition', 'content-length'].map(name => [name, whole.headers.get(name)]))).toEqual({
      'accept-ranges': 'bytes', etag: `"${sha}"`, 'repr-digest': formatReprDigest(sha), 'x-content-sha256': sha, 'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="report.pdf"', 'content-length': String(content.byteLength) });
    expect(Buffer.from(await whole.arrayBuffer()).equals(content)).toBe(true);
    for (const [range, start, end] of [['bytes=100-199', 100, 199], ['bytes=-50', content.byteLength - 50, content.byteLength - 1], [`bytes=${MiB}-`, MiB, content.byteLength - 1]] as const) {
      const part = await call(`/api/v1/artifacts/${sha}/content`, { Range: range });
      expect(part.status, range).toBe(206);
      expect(part.headers.get('content-range')).toBe(`bytes ${start}-${end}/${content.byteLength}`);
      expect(Buffer.from(await part.arrayBuffer()).equals(content.subarray(start, end + 1)), range).toBe(true);
    }
    const unsatisfiable = await call(`/api/v1/artifacts/${sha}/content`, { Range: `bytes=${content.byteLength}-` });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe(`bytes */${content.byteLength}`);
    // A stale If-Range means the client's bytes are from another representation: send it all.
    const stale = await call(`/api/v1/artifacts/${sha}/content`, { Range: 'bytes=0-9', 'If-Range': `"${'0'.repeat(64)}"` });
    expect(stale.status).toBe(200);
    expect(Number(stale.headers.get('content-length'))).toBe(content.byteLength);
    await stale.arrayBuffer();
    const legacy = await call(`/api/v1/artifacts/${sha}`);
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get('content-type')).toBe('application/octet-stream');
    expect(Buffer.from(await legacy.arrayBuffer()).equals(content)).toBe(true);
    expect((await call(`/api/v1/artifacts/${'f'.repeat(64)}/content`)).status).toBe(404);
    const status = z.object({ capabilities: z.object({ artifact_transfer: z.number() }) }).passthrough().parse(await (await call('/api/v1/status')).json());
    expect(status.capabilities.artifact_transfer).toBe(2);
  });

  it('lists a registered PNG rendition with the original first and leaves the original unchanged', async () => {
    const { dir, runtime, call } = await local();
    const task = runtime.accept('Draw a map', 'management', 'mission');
    const original = await runtime.artifactManifests.registerStream({ taskId: task.id, name: 'map.png', mime: 'image/png', stream: Readable.from(png(2 * MiB, 2048, 1024)), source: 'fixture' });
    const sha = original.manifest.sha256;
    const preview = await runtime.artifactManifests.registerRendition({ originalSha256: sha, role: 'preview', purpose: 'display', mime: 'image/png',
      stream: Readable.from(png(64 * 1024, 1600, 800)), transform: { name: 'fixture-resize', version: '1.0.0', params: { longest_side: 1600, format: 'png' } },
      width: 1600, height: 800, has_alpha: true });
    expect(preview.manifest).toMatchObject({ schema_version: '1.1', name: 'map.preview.png', rendition: { role: 'preview', of_sha256: sha, purpose: 'display' } });
    // Registering the same rendition again is the same record.
    expect((await runtime.artifactManifests.registerRendition({ originalSha256: sha, role: 'preview', purpose: 'display', mime: 'image/png',
      bytes: await readFile(join(dir, 'artifacts', preview.manifest.sha256)), transform: { name: 'fixture-resize', version: '1.0.0', params: {} } })).manifest.artifact_id)
      .toBe(preview.manifest.artifact_id);
    await expect(runtime.artifactManifests.registerRendition({ originalSha256: preview.manifest.sha256, role: 'preview', purpose: 'display', mime: 'image/png',
      bytes: Buffer.from('not a png'), transform: { name: 'fixture-resize', version: '1', params: {} } })).rejects.toThrow();
    const body = z.object({ renditions: z.array(z.object({ sha256: z.string(), role: z.enum(['original', 'preview', 'model_input']), mime: z.string(), size: z.number(),
      purpose: z.string(), width: z.number().optional(), height: z.number().optional(), has_alpha: z.boolean().optional() }).strict()) })
      .parse(await (await call(`/api/v1/artifacts/${sha}/renditions`)).json());
    expect(body.renditions).toEqual([
      { sha256: sha, role: 'original', mime: 'image/png', size: 2 * MiB, purpose: 'download', width: 2048, height: 1024, has_alpha: true },
      { sha256: preview.manifest.sha256, role: 'preview', mime: 'image/png', size: 64 * 1024, purpose: 'display', width: 1600, height: 800, has_alpha: true }]);
    // The same list from the rendition's digest; download always selects the original.
    expect(await (await call(`/api/v1/artifacts/${preview.manifest.sha256}/renditions`)).json()).toEqual(body);
    expect(selectRendition(body.renditions, { purpose: 'download' })?.sha256).toBe(sha);
    expect(selectRendition(body.renditions, { purpose: 'display', needsAlpha: true })?.sha256).toBe(preview.manifest.sha256);
    expect(runtime.artifactManifests.manifest(sha)?.manifest.sha256).toBe(sha);
    expect(await sha256File(join(dir, 'artifacts', sha))).toBe(sha);
    // The task's deliverables are originals; renditions are reached through their original.
    expect(runtime.artifactManifests.forTask(task.id).map(item => item.manifest.sha256)).toEqual([sha]);
    expect(() => runtime.store.db.prepare('UPDATE artifact_renditions SET purpose=? WHERE original_sha256=?').run('other', sha)).toThrow(/immutable/);
  });

  it('keeps 1.0 manifests stored as they were and shows them as 1.0 on old routes and 1.1 on v2 routes', async () => {
    const { runtime, call } = await local();
    const task = runtime.accept('Write notes', 'management', 'mission');
    // A task accepted before execution ancestry was recorded: its artifacts are still stored as 1.0.
    runtime.store.db.prepare('DELETE FROM task_execution WHERE task_id=?').run(task.id);
    const old = await runtime.artifactManifests.register({ taskId: task.id, name: 'notes.md', mime: 'text/markdown', bytes: Buffer.from('# Notes\n'), source: 'fixture' });
    const stored = z.object({ manifest_json: z.string() }).parse(runtime.store.db.prepare('SELECT manifest_json FROM artifact_manifests WHERE artifact_id=?').get(old.manifest.artifact_id));
    expect(JSON.parse(stored.manifest_json)).toEqual(old.manifest);
    expect(old.manifest.schema_version).toBe('1.0');
    expect(await (await call(`/api/v1/artifacts/${old.manifest.sha256}/manifest`)).json()).toMatchObject({ manifest: old.manifest });
    expect(await (await call(`/api/v1/artifacts/${old.manifest.sha256}/manifest/v2`)).json()).toMatchObject({ manifest: { ...old.manifest, schema_version: '1.1' } });
    expect(await (await call(`/api/v1/tasks/${task.id}/artifacts`)).json()).toEqual({ artifacts: [old] });
    const content = await call(`/api/v1/artifacts/${old.manifest.sha256}/content`);
    expect(content.headers.get('content-type')).toMatch(/^text\/markdown/);
    expect(await content.text()).toBe('# Notes\n');
    // A stream registration refuses bytes that are not what they claim, storing nothing.
    await expect(runtime.artifactManifests.registerStream({ taskId: task.id, name: 'fake.pdf', mime: 'application/pdf', stream: Readable.from([Buffer.from('not a pdf')]), source: 'fixture' }))
      .rejects.toMatchObject({ code: 'INVALID_ARTIFACT' });
    await expect(runtime.artifactManifests.registerStream({ taskId: task.id, name: 'wrong.md', mime: 'text/markdown', stream: Readable.from([Buffer.from('# x')]), source: 'fixture',
      expectedSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
    expect(await runtime.artifacts.stat(createHash('sha256').update('# x').digest('hex'))).toBeUndefined();
  });

  it('accepts, reports and validates imports through the management API', async () => {
    const { call } = await local();
    const invalid = await call('/api/v1/artifacts/imports', { 'Content-Type': 'application/json' }, { method: 'POST', body: JSON.stringify({ peer_id: 'exporter' }) });
    expect(invalid.status).toBe(400);
    const accepted = await call('/api/v1/artifacts/imports', { 'Content-Type': 'application/json' },
      { method: 'POST', body: JSON.stringify({ peer_id: 'missing-peer', a2a_task_id: 'task-1', artifact_id: 'a'.repeat(32) }) });
    expect(accepted.status).toBe(202);
    const { import_id: id } = z.object({ import_id: z.string() }).parse(await accepted.json());
    let state = '';
    for (let attempt = 0; attempt < 100 && state !== 'failed'; attempt++) {
      state = z.object({ state: z.string() }).parse(await (await call(`/api/v1/artifacts/imports/${id}`)).json()).state;
      if (state !== 'failed') await new Promise(resolve => setTimeout(resolve, 20));
    }
    const failed = await (await call(`/api/v1/artifacts/imports/${id}`)).json();
    expect(failed).toMatchObject({ import_id: id, state: 'failed', error: { code: 'PEER_UNAVAILABLE' } });
    expect(await (await call('/api/v1/artifacts/imports')).json()).toMatchObject({ imports: [{ import_id: id }] });
    expect((await call(`/api/v1/artifacts/imports/${'b'.repeat(32)}`)).status).toBe(404);
  });
});
