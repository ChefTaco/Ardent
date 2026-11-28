import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { TaskState } from '@a2a-js/sdk';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteA2APushStore } from '../src/a2a-push.js';
import { SqliteA2ATaskStore } from '../src/a2a-store.js';
import { loadConfig, parseConfig } from '../src/config.js';
import { inspectJournal } from '../src/journal.js';
import { backupProfile, parseDuration, profileSize, pruneJournal, vacuumJournal } from '../src/retention.js';
import { ArdentRuntime } from '../src/runtime.js';
import { TeamArtifacts } from '../src/team-artifacts.js';
import { TeamChildService } from '../src/team-child.js';
import { TeamControlService } from '../src/team-control.js';
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

  it('aborts a batch that would leave a row pointing at a deleted parent, and deletes nothing', async () => {
    const { runtime } = await setup();
    let now = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const old = runtime.accept('Old report', 'management');
    const artifact = await runtime.artifactManifests.registerStream({ taskId: old.id, name: 'report.pdf', mime: 'application/pdf', stream: Readable.from([pdf('kept')]), source: 'fixture' });
    runtime.store.setState(old.id, 'completed', 'done');
    // A table retention does not know, with a foreign key to the manifest the prune would delete.
    runtime.store.db.exec('CREATE TABLE fixture_manifest_refs (artifact_id TEXT NOT NULL REFERENCES artifact_manifests(artifact_id))');
    runtime.store.db.prepare('INSERT INTO fixture_manifest_refs VALUES (?)').run(artifact.manifest.artifact_id);
    now = T0 + 100 * DAY;
    await expect(pruneJournal(runtime.store, runtime.artifacts, { olderThanMs: 30 * DAY })).rejects.toThrow(/fixture_manifest_refs.*artifact_manifests/);
    expect(runtime.store.get(old.id)).toBeDefined();
    await expect(runtime.artifacts.stat(artifact.manifest.sha256)).resolves.toBeDefined();
    expect(z.array(z.object({ foreign_keys: z.number() })).parse(runtime.store.db.pragma('foreign_keys'))[0]?.foreign_keys).toBe(1);
    runtime.store.db.exec('DROP TABLE fixture_manifest_refs');
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

describe('peer session retention (ardent prune --peer-sessions)', () => {
  /** A finished inbound peer (A2A) task in its own session, with the rows Ardent's A2A server keeps for it. */
  async function peerTask(runtime: ArdentRuntime, name: string, options: { status?: number; push?: string; artifactExpires?: number; childClaim?: boolean } = {}) {
    const store = runtime.store;
    const session = store.session('a2a::lead', 'peer', `context-${name}`);
    const task = runtime.accept(`Mission ${name}`, 'a2a::lead', 'peer', undefined, session.id);
    store.appendAssistant(store.get(task.id)!, `Report ${name}`);
    store.setState(task.id, 'completed', 'done');
    const a2a = `a2a-${name}`;
    const db = store.db;
    db.prepare('INSERT INTO a2a_tasks(id,tenant,caller,context_id,status,status_timestamp,task_json,updated_ms) VALUES (?,?,?,?,?,?,?,?)')
      .run(a2a, '', 'lead', `context-${name}`, options.status ?? TaskState.TASK_STATE_COMPLETED, new Date(Date.now()).toISOString(),
        JSON.stringify({ id: a2a, contextId: `context-${name}`, status: { state: options.status ?? TaskState.TASK_STATE_COMPLETED } }), Date.now());
    db.prepare('INSERT INTO a2a_request_receipts(tenant,caller,message_id,request_sha256,task_id,created_ms) VALUES (?,?,?,?,?,?)').run('', 'lead', `message-${name}`, 'digest', a2a, Date.now());
    db.prepare('INSERT INTO a2a_operation_map VALUES (?,?,?,?)').run(a2a, task.id, '', 'lead');
    db.prepare('INSERT INTO a2a_team_missions VALUES (?,?,?,?)').run(a2a, '', 'lead', '{}');
    db.prepare('INSERT INTO a2a_team_admission(a2a_task_id,operation_id,version,admission,updated_ms) VALUES (?,?,?,?,?)').run(a2a, task.id, 1, 'open', Date.now());
    if (options.push) {
      db.prepare('INSERT INTO a2a_push_configs(task_id,tenant,caller,id,config_json,wire_version,created_ms) VALUES (?,?,?,?,?,?,?)').run(a2a, '', 'lead', 'push-1', '{}', '1.0', Date.now());
      db.prepare('INSERT INTO a2a_push_deliveries(id,task_id,tenant,caller,config_id,state,created_ms,updated_ms) VALUES (?,?,?,?,?,?,?,?)').run(`delivery-${name}`, a2a, '', 'lead', 'push-1', options.push, Date.now(), Date.now());
    }
    let digest: string | undefined;
    if (options.artifactExpires !== undefined) {
      const bytes = Buffer.from(`team artifact ${name}`);
      digest = createHash('sha256').update(bytes).digest('hex');
      await runtime.artifacts.putStream(Readable.from([bytes]), digest);
      db.prepare('INSERT INTO a2a_team_artifacts(id,peer,context_id,a2a_task_id,digest,name,mime,size,manifest_json,status,expires) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(`artifact-${name}`, 'lead', `context-${name}`, a2a, digest, 'report.txt', 'text/plain', bytes.length, '{}', 'available', options.artifactExpires);
    }
    if (options.childClaim) db.prepare('INSERT INTO a2a_team_child_claims(child_id,a2a_task_id,fingerprint,claim_id,root,grant_json) VALUES (?,?,?,?,?,?)').run(`child-${name}`, a2a, 'f', 'c', 'r', '{}');
    return { session, task, a2a, digest };
  }
  async function peerSetup() {
    const env = await setup();
    const db = env.runtime.store.db;
    new SqliteA2ATaskStore(db);
    new SqliteA2APushStore(db, []);
    new TeamControlService(env.runtime);
    new TeamArtifacts(env.runtime, env.runtime.config, {});
    new TeamChildService(env.runtime, {});
    db.exec('CREATE TABLE IF NOT EXISTS a2a_operation_map (a2a_task_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, tenant TEXT NOT NULL, caller TEXT NOT NULL); CREATE TABLE IF NOT EXISTS a2a_team_missions (a2a_task_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, caller TEXT NOT NULL, envelope_json TEXT NOT NULL)');
    return env;
  }
  const count = (runtime: ArdentRuntime, sql: string, ...values: string[]) => Number(Object.values(runtime.store.db.prepare(sql).get(...values) as Record<string, unknown>)[0]);

  it('deletes an old finished peer session whole, transcript and A2A records included, and keeps the transcript trigger', async () => {
    const { runtime } = await peerSetup();
    let now = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const trigger = () => runtime.store.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='session_messages_immutable_delete'").get();
    const before = trigger();
    const done = await peerTask(runtime, 'done', { push: 'sent', artifactExpires: (T0 + DAY) / 1000 });
    const failedPush = await peerTask(runtime, 'failed-push', { status: TaskState.TASK_STATE_FAILED, push: 'failed' });
    const working = await peerTask(runtime, 'working', { status: TaskState.TASK_STATE_WORKING });
    const unknownPush = await peerTask(runtime, 'unknown-push', { push: 'unknown' });
    const published = await peerTask(runtime, 'published', { artifactExpires: (T0 + 400 * DAY) / 1000 });
    const claimed = await peerTask(runtime, 'claimed', { childClaim: true });
    const direct = runtime.store.session('management', 'direct', 'chat-old');
    const chat = runtime.accept('Old chat', 'management', 'direct', undefined, direct.id);
    runtime.store.appendAssistant(runtime.store.get(chat.id)!, 'Reply');
    runtime.store.setState(chat.id, 'completed', 'done');
    now = T0 + 80 * DAY;
    const recent = await peerTask(runtime, 'recent');
    now = T0 + 100 * DAY;

    const journalPath = join(runtime.profileDir, 'state', 'ardent.sqlite');
    const inspectedBefore = await inspectJournal(journalPath);
    // Without the option, the transcript rule keeps every peer session.
    expect(await pruneJournal(runtime.store, runtime.artifacts, { olderThanMs: 30 * DAY })).toMatchObject({ tasks: 0 });
    const dry = await pruneJournal(runtime.store, runtime.artifacts, { olderThanMs: 30 * DAY, peerSessions: true, dryRun: true });
    expect(dry).toMatchObject({ dry_run: true, tasks: 2, peer_sessions: 2 });
    expect(runtime.store.get(done.task.id)).toBeDefined();

    const result = await pruneJournal(runtime.store, runtime.artifacts, { olderThanMs: 30 * DAY, peerSessions: true });
    expect(result).toMatchObject({ tasks: 2, peer_sessions: 2, rows: { tasks: 2, sessions: 2, a2a_tasks: 2, a2a_operation_map: 2, a2a_team_missions: 2, a2a_team_admission: 2, a2a_request_receipts: 2,
      a2a_push_deliveries: 2, a2a_push_configs: 2, a2a_team_artifacts: 1 }, artifacts: { deleted: 1, retained: 0 } });
    expect(result.rows['session_messages']).toBeGreaterThanOrEqual(2);
    for (const gone of [done, failedPush]) {
      expect(runtime.store.get(gone.task.id)).toBeUndefined();
      expect(count(runtime, 'SELECT count(*) FROM sessions WHERE id=?', gone.session.id)).toBe(0);
      expect(count(runtime, 'SELECT count(*) FROM session_messages WHERE session_id=?', gone.session.id)).toBe(0);
      expect(count(runtime, 'SELECT count(*) FROM events WHERE task_id=?', gone.task.id)).toBe(0);
      for (const table of ['a2a_tasks WHERE id=?', 'a2a_operation_map WHERE a2a_task_id=?', 'a2a_team_missions WHERE a2a_task_id=?', 'a2a_request_receipts WHERE task_id=?'])
        expect(count(runtime, `SELECT count(*) FROM ${table}`, gone.a2a), table).toBe(0);
    }
    expect(await runtime.artifacts.stat(done.digest!).catch(() => undefined)).toBeUndefined();
    // Kept: a non-final A2A task, an unsettled push, an unexpired published artifact, a lead-side child claim, a recent session, a direct chat.
    for (const kept of [working, unknownPush, published, claimed, recent]) {
      expect(runtime.store.get(kept.task.id), kept.a2a).toBeDefined();
      expect(count(runtime, 'SELECT count(*) FROM session_messages WHERE session_id=?', kept.session.id), kept.a2a).toBeGreaterThan(0);
      expect(count(runtime, 'SELECT count(*) FROM a2a_tasks WHERE id=?', kept.a2a), kept.a2a).toBe(1);
    }
    await expect(runtime.artifacts.stat(published.digest!)).resolves.toBeDefined();
    expect(runtime.store.get(chat.id)).toBeDefined();
    // The immutability trigger is back with its exact text, and still refuses a delete.
    expect(trigger()).toEqual(before);
    expect(() => runtime.store.db.prepare('DELETE FROM session_messages WHERE session_id=?').run(recent.session.id)).toThrow(/immutable/);
    // The kept in-flight fixtures are what the idle check counts; pruning changed none of that.
    const inspectedAfter = await inspectJournal(journalPath);
    expect({ active: inspectedAfter.active, unknown: inspectedAfter.unknown, unsupported: inspectedAfter.unsupported })
      .toEqual({ active: inspectedBefore.active, unknown: inspectedBefore.unknown, unsupported: inspectedBefore.unsupported });
    expect(z.object({ integrity_check: z.string() }).parse(runtime.store.db.prepare('PRAGMA integrity_check').get()).integrity_check).toBe('ok');
    expect(runtime.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // A vacuum gives the freed pages back and keeps the journal intact.
    const vacuum = vacuumJournal(runtime.store);
    expect(vacuum.after_bytes).toBeLessThanOrEqual(vacuum.before_bytes);
    expect(trigger()).toEqual(before);
    expect(runtime.store.get(recent.task.id)).toBeDefined();
  });

  it('keeps a peer session another record names, or whose checkpoint another record names', async () => {
    const { runtime } = await peerSetup();
    let now = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const named = await peerTask(runtime, 'named');
    const plain = await peerTask(runtime, 'plain');
    runtime.store.db.exec('CREATE TABLE fixture_session_refs (session_id TEXT NOT NULL)');
    runtime.store.db.prepare('INSERT INTO fixture_session_refs VALUES (?)').run(named.session.id);
    now = T0 + 100 * DAY;
    expect(await pruneJournal(runtime.store, runtime.artifacts, { olderThanMs: 30 * DAY, peerSessions: true })).toMatchObject({ peer_sessions: 1, tasks: 1 });
    expect(runtime.store.get(named.task.id)).toBeDefined();
    expect(runtime.store.get(plain.task.id)).toBeUndefined();
    runtime.store.db.exec('DROP TABLE fixture_session_refs');
  });

  it('takes peer_sessions from configuration', async () => {
    const { dir } = await setup();
    const text = await readFile(join(dir, 'config.yaml'), 'utf8');
    expect(parseConfig(`${text.trimEnd()}\nretention:\n  enabled: true\n  peer_sessions: true\n`).retention).toEqual({ enabled: true, older_than_days: 90, peer_sessions: true });
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
