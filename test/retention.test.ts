import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, parseConfig } from '../src/config.js';
import { inspectJournal } from '../src/journal.js';
import { backupProfile, parseDuration, profileSize, pruneJournal } from '../src/retention.js';
import { ArdentRuntime } from '../src/runtime.js';
import { initTestProfile } from './helpers.js';

const DAY = 86_400_000;
const T0 = 1_790_000_000_000;
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); vi.restoreAllMocks(); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-retention-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await initTestProfile(dir);
  const loaded = await loadConfig(dir);
  const runtime = new ArdentRuntime(dir, loaded.config, {});
  cleanup.push(() => runtime.close());
  return { dir, runtime, loaded };
}
const pdf = (text: string) => Buffer.from(`%PDF-1.7\n${text}\n%%EOF\n`);

describe('journal retention (ardent prune)', () => {
  it('deletes old finished tasks and what belongs only to them, and keeps everything still needed', async () => {
    const { runtime } = await setup();
    let now = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const store = runtime.store;
    const finish = (id: string, state: 'completed' | 'failed' | 'unknown') => store.setState(id, state, state === 'completed' ? 'done' : null, state === 'completed' ? null : 'fixture');
    const old = runtime.accept('Old report', 'management');
    const artifact = await runtime.artifactManifests.registerStream({ taskId: old.id, name: 'report.pdf', mime: 'application/pdf', stream: Readable.from([pdf('old')]), source: 'fixture' });
    finish(old.id, 'completed');
    const oldFailed = runtime.accept('Old failure', 'management');
    finish(oldFailed.id, 'failed');
    const oldUnknown = runtime.accept('Old uncertain effect', 'management');
    finish(oldUnknown.id, 'unknown');
    const session = store.session('management', 'direct', 'chat-1');
    const chatted = runtime.accept('Old chat', 'management', 'direct', undefined, session.id);
    store.appendAssistant(store.get(chatted.id)!, 'Reply');
    finish(chatted.id, 'completed');
    const referenced = runtime.accept('Old, but another record names it', 'management');
    finish(referenced.id, 'completed');
    store.db.exec('CREATE TABLE fixture_records (task_id TEXT NOT NULL)');
    store.db.prepare('INSERT INTO fixture_records(task_id) VALUES (?)').run(referenced.id);
    const queued = runtime.accept('Old but still queued', 'management');
    now = T0 + 80 * DAY;
    const recent = runtime.accept('Recent', 'management');
    finish(recent.id, 'completed');
    now = T0 + 100 * DAY;

    const dry = await pruneJournal(store, runtime.artifacts, { olderThanMs: 30 * DAY, dryRun: true });
    expect(dry).toMatchObject({ dry_run: true, tasks: 2 });
    expect(store.get(old.id)).toBeDefined();

    const result = await pruneJournal(store, runtime.artifacts, { olderThanMs: 30 * DAY });
    expect(result).toMatchObject({ dry_run: false, tasks: 2, rows: { tasks: 2, artifact_manifests: 1 }, artifacts: { deleted: 1, retained: 0 } });
    expect(result.rows['events']).toBeGreaterThan(0);
    expect(store.get(old.id)).toBeUndefined();
    expect(store.get(oldFailed.id)).toBeUndefined();
    expect(store.events(old.id)).toEqual([]);
    expect(await runtime.artifacts.stat(artifact.manifest.sha256).catch(() => undefined)).toBeUndefined();
    for (const kept of [oldUnknown, chatted, referenced, queued, recent]) expect(store.get(kept.id), kept.prompt).toBeDefined();
    // Session transcripts are immutable (context checkpoints rest on them), so a chat task stays.
    expect(store.sessionMessages(session.id, 'management').length).toBeGreaterThan(0);
    // Nothing the idle check reads is left dangling (the fixture table is not Ardent's).
    store.db.exec('DROP TABLE fixture_records');
    const status = await inspectJournal(join(runtime.profileDir, 'state', 'ardent.sqlite'));
    expect(status.unsupported).toBe(0);
  });

  it('keeps an artifact another task still names, and refuses a retention under a day', async () => {
    const { runtime } = await setup();
    let now = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const bytes = pdf('shared');
    const first = runtime.accept('First', 'management');
    const shared = await runtime.artifactManifests.registerStream({ taskId: first.id, name: 'a.pdf', mime: 'application/pdf', stream: Readable.from([bytes]), source: 'fixture' });
    runtime.store.setState(first.id, 'completed', 'done');
    now = T0 + 60 * DAY;
    const second = runtime.accept('Second', 'management');
    await runtime.artifactManifests.registerStream({ taskId: second.id, name: 'b.pdf', mime: 'application/pdf', stream: Readable.from([bytes]), source: 'fixture' });
    runtime.store.setState(second.id, 'completed', 'done');
    now = T0 + 70 * DAY;
    expect(await pruneJournal(runtime.store, runtime.artifacts, { olderThanMs: 30 * DAY })).toMatchObject({ tasks: 1, artifacts: { deleted: 0, retained: 1 } });
    await expect(runtime.artifacts.stat(shared.manifest.sha256)).resolves.toBeDefined();
    await expect(pruneJournal(runtime.store, runtime.artifacts, { olderThanMs: 3_600_000 })).rejects.toThrow(/at least one day/);
    expect(parseDuration('90d')).toBe(90 * DAY);
    expect(parseDuration('36h')).toBe(36 * 3_600_000);
    expect(() => parseDuration('90 days')).toThrow();
  });

  it('is off by default in configuration', async () => {
    const { dir } = await setup();
    const config = parseConfig(await readFile(join(dir, 'config.yaml'), 'utf8'));
    expect(config.retention).toEqual({ enabled: false, older_than_days: 90 });
  });

  it('prunes only while the profile is over its size threshold', async () => {
    const { runtime } = await setup();
    let now = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const old = runtime.accept('Old report', 'management');
    await runtime.artifactManifests.registerStream({ taskId: old.id, name: 'report.pdf', mime: 'application/pdf', stream: Readable.from([pdf('x'.repeat(4096))]), source: 'fixture' });
    runtime.store.setState(old.id, 'completed', 'done');
    now = T0 + 100 * DAY;
    // A partial upload or temporary file is not part of the profile's size.
    await writeFile(join(runtime.artifacts.directory, '.leftover.tmp'), Buffer.alloc(8192));
    const size = await profileSize(runtime.store, runtime.artifacts);
    expect(size.artifact_bytes).toBeGreaterThan(4096);
    expect(size.artifact_bytes).toBeLessThan(8192);
    expect(size.journal_bytes).toBeGreaterThan(0);
    expect(size.total_bytes).toBe(size.journal_bytes + size.artifact_bytes);

    const under = await pruneJournal(runtime.store, runtime.artifacts, { olderThanMs: 30 * DAY, minProfileBytes: size.total_bytes });
    expect(under).toMatchObject({ tasks: 0, skipped: 'below_min_size', profile_bytes: size.total_bytes });
    expect(runtime.store.get(old.id)).toBeDefined();

    const over = await pruneJournal(runtime.store, runtime.artifacts, { olderThanMs: 30 * DAY, minProfileBytes: size.total_bytes - 1 });
    expect(over).toMatchObject({ tasks: 1, profile_bytes: size.total_bytes, artifacts: { deleted: 1 } });
    expect(over.skipped).toBeUndefined();
    expect(runtime.store.get(old.id)).toBeUndefined();
    // Freed pages are not counted, so the next run sees the smaller profile even though SQLite kept the file size.
    expect((await profileSize(runtime.store, runtime.artifacts)).total_bytes).toBeLessThan(size.total_bytes);
    await expect(pruneJournal(runtime.store, runtime.artifacts, { olderThanMs: 30 * DAY, minProfileBytes: -1 })).rejects.toThrow(/whole number of bytes/);
  });

  it('takes a size threshold in MiB from configuration', async () => {
    const { dir } = await setup();
    const text = await readFile(join(dir, 'config.yaml'), 'utf8');
    const withRetention = (block: string) => `${text.trimEnd()}\nretention:\n${block}\n`;
    expect(parseConfig(withRetention('  enabled: true\n  min_profile_mb: 512')).retention).toEqual({ enabled: true, older_than_days: 90, min_profile_mb: 512 });
    expect(() => parseConfig(withRetention('  enabled: true\n  min_profile_mb: 0'))).toThrow();
    expect(() => parseConfig(withRetention('  enabled: true\n  min_profile_mb: 1.5'))).toThrow();
  });
});

describe('ardent backup', () => {
  it('writes a consistent, private copy of the journal (and artifacts) to a new directory', async () => {
    const { dir, runtime } = await setup();
    const task = runtime.accept('Backed up', 'management');
    await runtime.artifactManifests.registerStream({ taskId: task.id, name: 'report.pdf', mime: 'application/pdf', stream: Readable.from([pdf('backup')]), source: 'fixture' });
    const target = join(dir, '..', `${dir.split('/').at(-1)}-backup`);
    cleanup.push(() => rm(target, { recursive: true, force: true }));
    // The gateway's connection stays open: the backup API copies a consistent snapshot.
    const result = await backupProfile(dir, target, { artifacts: true });
    expect(result).toMatchObject({ format: 'ardent-backup', version: 1, journal: { file: 'ardent.sqlite', integrity: 'ok', idle: false }, artifacts: { included: true, files: expect.any(Number) } });
    expect(result.artifacts.files).toBeGreaterThan(0);
    expect((await stat(target)).mode & 0o777).toBe(0o700);
    expect((await stat(join(target, 'ardent.sqlite'))).mode & 0o777).toBe(0o600);
    expect(createHash('sha256').update(await readFile(join(target, 'ardent.sqlite'))).digest('hex')).toBe(result.journal.sha256);
    expect(JSON.parse(await readFile(join(target, 'backup.json'), 'utf8'))).toEqual(result);
    const copied = await inspectJournal(join(target, 'ardent.sqlite'));
    expect(copied.active).toBeGreaterThan(0);
    expect(await readdir(target)).not.toContain('.env');
    // A directory that is not empty is refused and left as it was.
    await writeFile(join(target, 'keep.txt'), 'x');
    await expect(backupProfile(dir, target)).rejects.toThrow(/not empty/);
    expect(await readdir(target)).toContain('keep.txt');
  });
});
