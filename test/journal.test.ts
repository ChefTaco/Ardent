import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createA2ASurface } from '../src/a2a-server.js';
import { ArtifactImportStateSchema, ArtifactTransfers } from '../src/artifact-transfer.js';
import { CatchupJournal } from '../src/channel-catchup.js';
import { loadConfig } from '../src/config.js';
import { ContextCheckpoints } from '../src/context-checkpoints.js';
import { InvocationState, RecoveryStatus } from '../src/execution-state.js';
import { JobEngine } from '../src/job-engine.js';
import { inspectJournal, inspectJournalFile, journalPolicy, JOURNAL_TABLES, TASK_RECOVERY_STATUSES, type JournalTableRule } from '../src/journal.js';
import { ArdentRuntime } from '../src/runtime.js';
import Database from '../src/sqlite.js';
import { TaskState } from '../src/store.js';
import { initTestProfile } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-journal-test-'));
  dirs.push(dir);
  return dir;
}
async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? sourceFiles(join(dir, entry.name))
    : Promise.resolve(entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [])));
  return nested.flat();
}
function stateRule(name: string): Extract<JournalTableRule, { kind: 'state' }> {
  const rule = JOURNAL_TABLES[name];
  if (rule?.kind !== 'state') throw new Error(`${name} is not a state table`);
  return rule;
}
const classified = (rule: Extract<JournalTableRule, { kind: 'state' }>) => new Set([...rule.active, ...rule.uncertain, ...rule.terminal]);
function synthetic(path: string, sql: string): void {
  const db = new Database(path);
  try { db.exec(sql); } finally { db.close(); }
}
async function digest(path: string): Promise<string | null> {
  return readFile(path).then(bytes => createHash('sha256').update(bytes).digest('hex'), () => null);
}

describe('journal table classification', () => {
  it('classifies every table any Ardent module creates', async () => {
    // A new CREATE TABLE without an entry in JOURNAL_TABLES fails here, before
    // a release can reach a backup or upgrade tool that refuses unknown tables.
    const created = new Set<string>();
    for (const file of await sourceFiles(new URL('../src', import.meta.url).pathname)) {
      const text = await readFile(file, 'utf8');
      // Table names are literal so this scan can see them.
      expect(text, file).not.toMatch(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\$\{/i);
      expect(text, file).not.toMatch(/ALTER\s+TABLE\s+\S+\s+RENAME\s+TO/i);
      for (const match of text.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z0-9_]+)/gi)) created.add(match[1]!);
    }
    const unclassified = [...created].filter(name => !Object.hasOwn(JOURNAL_TABLES, name));
    expect(unclassified, 'add these tables to JOURNAL_TABLES in src/journal.ts').toEqual([]);
    const stale = Object.keys(JOURNAL_TABLES).filter(name => !created.has(name));
    expect(stale, 'these JOURNAL_TABLES entries name no table Ardent creates').toEqual([]);
  });

  it('classifies every value of the state enums the stores write', () => {
    const cases: Array<[string, readonly string[]]> = [
      ['tasks', TaskState.options], ['tool_invocations', InvocationState.options],
      ['artifact_transfers', ArtifactImportStateSchema.options],
    ];
    for (const [table, values] of cases) expect(values.filter(value => !classified(stateRule(table)).has(value)), table).toEqual([]);
    const recovery = new Set<string>([...TASK_RECOVERY_STATUSES.active, ...TASK_RECOVERY_STATUSES.uncertain, ...TASK_RECOVERY_STATUSES.terminal]);
    expect(RecoveryStatus.options.filter(value => !recovery.has(value)), 'task_recovery').toEqual([]);
    for (const [name, rule] of Object.entries(JOURNAL_TABLES)) {
      if (rule.kind !== 'state') continue;
      const all = [...rule.active, ...rule.uncertain, ...rule.terminal];
      expect(new Set(all).size, `${name} lists a state twice`).toBe(all.length);
      expect(rule.uncertain, `${name} counts unknown as uncertain`).toContain('unknown');
    }
  });

  it('publishes a JSON-serializable policy', () => {
    const policy = journalPolicy();
    expect(policy.policy_version).toBe(1);
    expect(JSON.parse(JSON.stringify(policy))).toEqual(policy);
    expect(Object.keys(policy.tables).sort()).toEqual(Object.keys(JOURNAL_TABLES).sort());
  });

  it('reports a fresh profile journal built by the real stores as idle, and leaves it unchanged', async () => {
    const dir = await scratch();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.a2a.public_url = 'http://127.0.0.1:9900';
    const env = {};
    const runtime = new ArdentRuntime(dir, config, env);
    let surface: Awaited<ReturnType<typeof createA2ASurface>> | undefined;
    try {
      surface = await createA2ASurface(runtime, config, env);
      new JobEngine(runtime.store.db, dir, config.profile, {}, async () => {});
      new ArtifactTransfers(runtime, env);
      new CatchupJournal(runtime.store.db);
      new ContextCheckpoints(runtime.store, () => Promise.reject(new Error('unused')));
      const tables = (runtime.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(row => row.name);
      expect(tables.filter(name => !Object.hasOwn(JOURNAL_TABLES, name))).toEqual([]);
      expect(tables.sort()).toEqual(Object.keys(JOURNAL_TABLES).sort());
    } finally {
      surface?.grpcServer?.forceShutdown();
      runtime.close();
    }
    const path = join(dir, 'state', 'ardent.sqlite');
    const before = await Promise.all(['', '-wal', '-shm'].map(suffix => digest(path + suffix)));
    const status = await inspectJournal(path);
    expect(await Promise.all(['', '-wal', '-shm'].map(suffix => digest(path + suffix)))).toEqual(before);
    expect(status).toMatchObject({ policy_version: 1, idle: true, active: 0, unknown: 0, unsupported: 0 });
    expect(status.tables.every(table => table.kind !== 'unclassified')).toBe(true);
  });
});

describe('journal inspection', () => {
  it('counts active, uncertain and unsupported rows and names the problems', async () => {
    const path = join(await scratch(), 'journal.sqlite');
    synthetic(path, `CREATE TABLE tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      INSERT INTO tasks VALUES ('a','queued'),('b','running'),('c','completed'),('d','unknown'),('e','mystery');
      CREATE TABLE task_recovery (task_id TEXT PRIMARY KEY, status TEXT NOT NULL);
      INSERT INTO task_recovery VALUES ('a','awaiting_decision'),('b','resolved');
      CREATE TABLE events (id INTEGER PRIMARY KEY, body TEXT);
      CREATE TABLE channel_catchup_runs (id INTEGER PRIMARY KEY, state TEXT NOT NULL);
      INSERT INTO channel_catchup_runs(state) VALUES ('catching_up');
      CREATE TABLE future_work (id TEXT PRIMARY KEY, state TEXT);`);
    const status = inspectJournalFile(path);
    expect(status).toMatchObject({ idle: false, active: 2, unknown: 2, unsupported: 2 });
    const byName = Object.fromEntries(status.tables.map(table => [table.name, table]));
    expect(byName.tasks).toMatchObject({ kind: 'state', active: 2, unknown: 1, unsupported: 1, problems: ['unrecognized state "mystery"'] });
    expect(byName.task_recovery).toMatchObject({ unknown: 1, active: 0 });
    expect(byName.events).toMatchObject({ kind: 'passive', active: 0, unsupported: 0 });
    expect(byName.channel_catchup_runs).toMatchObject({ kind: 'ledger', active: 0, unsupported: 0 });
    expect(byName.future_work).toMatchObject({ kind: 'unclassified', unsupported: 1, problems: ['table is not classified by this Ardent version'] });
  });

  it('treats schema drift and the closed admission fence as unsupported', async () => {
    const path = join(await scratch(), 'journal.sqlite');
    synthetic(path, `CREATE TABLE tasks (id TEXT PRIMARY KEY);
      CREATE TABLE events (id INTEGER PRIMARY KEY, status TEXT);
      CREATE TABLE admission_fence (singleton INTEGER PRIMARY KEY, release_id TEXT NOT NULL, closed_ms INTEGER NOT NULL);
      INSERT INTO admission_fence VALUES (1, 'release', 1);`);
    const status = inspectJournalFile(path);
    expect(status).toMatchObject({ idle: false, active: 0, unknown: 0, unsupported: 3 });
    expect(status.tables.find(table => table.name === 'admission_fence')?.problems).toEqual(['admission fence is closed']);
  });

  it('applies the special rules for A2A tasks, child claims, receipts and chat intake', async () => {
    const path = join(await scratch(), 'journal.sqlite');
    const task = (state: string) => JSON.stringify({ id: 't', contextId: 'c', status: { state } });
    synthetic(path, `CREATE TABLE a2a_tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, task_json TEXT NOT NULL);
      INSERT INTO a2a_tasks VALUES ('w','TASK_STATE_WORKING','${task('TASK_STATE_WORKING')}'),
        ('d','TASK_STATE_COMPLETED','${task('TASK_STATE_COMPLETED')}'), ('x','TASK_STATE_WORKING','${task('TASK_STATE_COMPLETED')}');
      CREATE TABLE a2a_team_child_claims (child_id TEXT PRIMARY KEY, settlement_json TEXT, acknowledged INTEGER NOT NULL DEFAULT 0);
      INSERT INTO a2a_team_child_claims VALUES ('open', NULL, 0), ('done','{"outcome":"completed"}',1), ('lost','{"outcome":"unknown"}',1);
      CREATE TABLE a2a_request_receipts (message_id TEXT PRIMARY KEY, task_id TEXT);
      INSERT INTO a2a_request_receipts VALUES ('bound','t'),('unbound',NULL);
      CREATE TABLE channel_deliveries (id TEXT PRIMARY KEY, platform TEXT, account TEXT, update_id TEXT, state TEXT NOT NULL);
      INSERT INTO channel_deliveries VALUES ('sent','p','a','1','sent');
      CREATE TABLE channel_inbound (platform TEXT, account TEXT, update_id TEXT, task_id TEXT, disposition TEXT);
      INSERT INTO channel_inbound VALUES ('p','a','1',NULL,'admitted'),('p','a','2',NULL,'admitted'),('p','a','3',NULL,'ignored'),('p','a','4','t','admitted');`);
    const byName = Object.fromEntries(inspectJournalFile(path).tables.map(table => [table.name, table]));
    // The mismatched task counts as active (indexed WORKING) and unsupported (it disagrees with its JSON).
    expect(byName.a2a_tasks).toMatchObject({ active: 2, unknown: 0, unsupported: 1 });
    expect(byName.a2a_team_child_claims).toMatchObject({ active: 1, unknown: 1, unsupported: 0 });
    expect(byName.a2a_request_receipts).toMatchObject({ active: 1 });
    expect(byName.channel_inbound).toMatchObject({ active: 1 });
  });

  it('rejects an empty file and a database that fails its integrity check', async () => {
    const dir = await scratch();
    synthetic(join(dir, 'empty.sqlite'), 'PRAGMA user_version=1');
    expect(inspectJournalFile(join(dir, 'empty.sqlite'))).toMatchObject({ idle: false, unsupported: 1, tables: [] });
    synthetic(join(dir, 'fk.sqlite'), `PRAGMA foreign_keys=OFF; CREATE TABLE tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY, task_id TEXT REFERENCES tasks(id)); INSERT INTO events VALUES (1,'missing');`);
    expect(() => inspectJournalFile(join(dir, 'fk.sqlite'))).toThrow(/foreign-key/);
  });

  it('counts committed work still in the WAL without touching the source files', async () => {
    const dir = await scratch();
    const writerPath = join(dir, 'writer.sqlite');
    const writer = new Database(writerPath);
    try {
      writer.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL); INSERT INTO tasks VALUES ('a','queued');`);
      // A stopped profile can leave committed, uncheckpointed pages in the WAL with no -shm.
      await copyFile(writerPath, join(dir, 'ardent.sqlite'));
      await copyFile(`${writerPath}-wal`, join(dir, 'ardent.sqlite-wal'));
    } finally { writer.close(); }
    const path = join(dir, 'ardent.sqlite');
    expect((await stat(`${path}-wal`)).size).toBeGreaterThan(0);
    const before = await Promise.all([path, `${path}-wal`].map(digest));
    expect(await inspectJournal(path)).toMatchObject({ idle: false, active: 1 });
    expect(await Promise.all([path, `${path}-wal`].map(digest))).toEqual(before);
    expect(await digest(`${path}-shm`)).toBeNull();
  });
});
