import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { JobEngine, validateJobDefinitions, type JobDefinitions, type JobRegistry } from '../src/job-engine.js';
import { TaskStore } from '../src/store.js';

const dirs: string[] = [];
const stores: TaskStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const base: JobDefinitions = { schema_version: 1, profile: 'assistant', revision: 1, jobs: [{
  id: '32eb4b7a04c1', owner: 'ardent', enabled: true, handler: 'test.v1',
  schedule: { cron: '5 5 * * *', timezone: 'America/New_York', missed_window: 'skip', catch_up_minutes: 0 },
  input: { label: 'test' }, delivery: { kind: 'none' }, policy: { max_attempts: 2, retry_backoff_seconds: 1 }
}] };
const intervalBase: JobDefinitions = { ...base, jobs: [{ ...base.jobs[0]!,
  schedule: { kind: 'interval', every_minutes: 15, anchor_at: '2026-09-27T18:19:39.268Z' }
}] };
const frozen = () => 0;
async function fixture(definitions: JobDefinitions = base, registry?: JobRegistry, allow = true) {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-job-engine-'));
  dirs.push(dir);
  await mkdir(join(dir, 'jobs'));
  await writeFile(join(dir, 'jobs', 'active.json'), JSON.stringify(definitions));
  const store = new TaskStore(join(dir, 'state', 'ardent.sqlite'));
  stores.push(store);
  let calls = 0;
  const handlers = registry ?? { 'test.v1': { input: z.object({ label: z.string() }).strict(), effect: 'none' as const,
    run: async () => { calls++; return { state: 'completed' as const, receipt: { effect_status: 'none' as const, evidence: { count: calls } } }; } } };
  const ownerCalls: string[] = [];
  const ownership = async (job: JobDefinitions['jobs'][number]) => { ownerCalls.push(job.id); if (!allow) throw new Error('No exclusive owner'); };
  // A frozen elapsed clock keeps each tick's receipts on its injected instant.
  return { dir, store, handlers, engine: new JobEngine(store.db, dir, 'assistant', handlers, ownership, frozen), calls: () => calls, ownerCalls };
}

describe('profile-local job engine', () => {
  it('validates profiles, handlers, cron, inputs and duplicate IDs before admitting work', async () => {
    const { handlers } = await fixture();
    expect(validateJobDefinitions(base, handlers, 'assistant').job_count).toBe(1);
    expect(() => validateJobDefinitions(base, handlers, 'other')).toThrow('profile differs');
    expect(() => validateJobDefinitions({ ...base, jobs: [{ ...base.jobs[0]!, handler: 'unknown.v1' }] }, handlers)).toThrow('Unknown job handler');
    expect(() => validateJobDefinitions({ ...base, jobs: [{ ...base.jobs[0]!, input: { label: 3 } }] }, handlers)).toThrow();
    expect(() => validateJobDefinitions({ ...base, jobs: [base.jobs[0], base.jobs[0]] }, handlers)).toThrow('Duplicate job ID');
    expect(() => validateJobDefinitions({ ...base, jobs: [{ ...base.jobs[0]!, schedule: { ...base.jobs[0]!.schedule, cron: '61 5 * * *' } }] }, handlers)).toThrow('Invalid cron range');
  });

  it('validates relative intervals without accepting hybrid or unanchored schedules', async () => {
    const { handlers } = await fixture();
    expect(validateJobDefinitions(intervalBase, handlers, 'assistant').job_count).toBe(1);
    const changed = (schedule: unknown) => ({ ...intervalBase, jobs: [{ ...intervalBase.jobs[0]!, schedule }] });
    expect(() => validateJobDefinitions(changed({ kind: 'interval', every_minutes: 0,
      anchor_at: '2026-09-27T18:19:39.268Z' }), handlers)).toThrow();
    expect(() => validateJobDefinitions(changed({ kind: 'interval', every_minutes: 15 }), handlers)).toThrow();
    expect(() => validateJobDefinitions(changed({ kind: 'interval', every_minutes: 15,
      anchor_at: '2026-09-27T14:19:39.268-05:00' }), handlers)).toThrow();
    expect(() => validateJobDefinitions(changed({ kind: 'interval', every_minutes: 15,
      anchor_at: '2026-09-27T18:19:39.268Z', cron: '* * * * *' }), handlers)).toThrow();
  });

  it('uses subminute UTC interval keys, recovers cadence from completed receipts, and never storms after a late tick', async () => {
    const f = await fixture(intervalBase);
    expect((await f.engine.tick(new Date('2026-09-27T18:34:39.267Z'))).claimed).toBe(0);
    expect((await f.engine.tick(new Date('2026-09-27T18:34:39.268Z'))).claimed).toBe(1);
    expect((await f.engine.tick(new Date('2026-09-27T18:34:39.268Z'))).claimed).toBe(0);
    expect(f.store.db.prepare('SELECT window_key,scheduled_ms FROM job_windows').get()).toEqual({
      window_key: `32eb4b7a04c1:interval:${Date.parse('2026-09-27T18:34:39.268Z')}`,
      scheduled_ms: Date.parse('2026-09-27T18:34:39.268Z') });
    const restarted = new JobEngine(f.store.db, f.dir, 'assistant', f.handlers, async () => {}, frozen);
    expect((await restarted.status(10, new Date('2026-09-27T18:35:00Z'))).jobs[0]?.next_window)
      .toBe('2026-09-27T18:49:39.268Z');
    expect((await restarted.tick(new Date('2026-09-27T19:30:00Z'))).claimed).toBe(1);
    expect((await restarted.tick(new Date('2026-09-27T19:30:00Z'))).claimed).toBe(0);
    expect(f.calls()).toBe(2);
    expect((await restarted.status(10, new Date('2026-09-27T19:30:00Z'))).jobs[0]?.next_window)
      .toBe('2026-09-27T19:45:00.000Z');
  });

  it('holds interval advancement through retries, exhaustion, unknown effects, and restart recovery', async () => {
    let calls = 0;
    const registry: JobRegistry = { 'test.v1': { input: z.object({ label: z.string() }), effect: 'none', run: async () => {
      calls++;
      return { state: 'retry', receipt: { effect_status: 'none', evidence: 'temporary source absence' } };
    } } };
    const f = await fixture(intervalBase, registry);
    const due = new Date('2026-09-27T18:34:39.268Z');
    expect((await f.engine.tick(due)).retry).toBe(1);
    expect((await f.engine.status()).jobs[0]?.next_window).toBeNull();
    expect((await f.engine.tick(new Date(due.getTime() + 999))).claimed).toBe(0);
    expect((await f.engine.tick(new Date(due.getTime() + 1000))).claimed).toBe(0);
    expect(calls).toBe(2);
    expect(f.store.db.prepare('SELECT state FROM job_windows').get()).toEqual({ state: 'failed' });
    expect((await f.engine.tick(new Date(due.getTime() + 60_000))).claimed).toBe(0);
    f.store.db.prepare("UPDATE job_windows SET state='running',attempts=3").run();
    const restarted = new JobEngine(f.store.db, f.dir, 'assistant', registry, async () => {}, frozen);
    expect(restarted.recover(new Date(due.getTime() + 61_000))).toBe(1);
    expect((await restarted.tick(new Date(due.getTime() + 30 * 60_000))).claimed).toBe(0);
    expect(f.store.db.prepare('SELECT state FROM job_windows').get()).toEqual({ state: 'unknown' });
    expect(calls).toBe(2);
  });

  it('uses elapsed time across DST, skips externally owned intervals, and retains the completed anchor after rollback', async () => {
    const fallback: JobDefinitions = { ...intervalBase, jobs: [{ ...intervalBase.jobs[0]!,
      schedule: { kind: 'interval', every_minutes: 15, anchor_at: '2026-11-01T05:45:00.000Z' }
    }] };
    const f = await fixture(fallback);
    expect((await f.engine.tick(new Date('2026-11-01T06:00:00Z'))).claimed).toBe(1);
    expect((await f.engine.status()).jobs[0]?.next_window).toBe('2026-11-01T06:15:00.000Z');
    const revised = { ...fallback, revision: 2, jobs: [{ ...fallback.jobs[0]!,
      schedule: { kind: 'interval' as const, every_minutes: 15, anchor_at: '2026-09-30T23:00:00.000Z' }
    }] };
    await writeFile(join(f.dir, 'jobs', 'active.json'), JSON.stringify(revised));
    expect((await f.engine.status()).jobs[0]?.next_window).toBe('2026-11-01T06:15:00.000Z');
    expect((await f.engine.tick(new Date('2026-11-01T06:15:00Z'))).claimed).toBe(1);
    await writeFile(join(f.dir, 'jobs', 'active.json'), JSON.stringify(fallback));
    expect((await f.engine.status()).jobs[0]?.next_window).toBe('2026-11-01T06:30:00.000Z');
    const external = await fixture({ ...intervalBase, jobs: [{ ...intervalBase.jobs[0]!, owner: 'external' }] });
    expect((await external.engine.tick(new Date('2026-09-27T19:00:00Z'))).claimed).toBe(0);
    expect(external.store.db.prepare('SELECT count(*) AS count FROM job_windows').get()).toEqual({ count: 0 });
    expect(external.store.db.prepare('SELECT count(*) AS count FROM job_scan').get()).toEqual({ count: 0 });
  });

  it('binds legacy scan timestamps to the active definition only after a new tick', async () => {
    const f = await fixture();
    f.store.db.exec('DROP TABLE job_scan; CREATE TABLE job_scan (job_id TEXT PRIMARY KEY, scanned_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)');
    f.store.db.prepare('INSERT INTO job_scan(job_id,scanned_ms,updated_ms) VALUES (?,?,?)')
      .run(base.jobs[0]!.id, Date.parse('2026-09-27T09:04:00Z'), Date.parse('2026-09-27T09:04:00Z'));
    const migrated = new JobEngine(f.store.db, f.dir, 'assistant', f.handlers, async () => {}, frozen);
    expect(f.store.db.prepare('SELECT definition_revision,definition_sha256 FROM job_scan').get())
      .toEqual({ definition_revision: 0, definition_sha256: '' });
    const digest = (await migrated.load()).sha256;
    await migrated.tick(new Date('2026-09-27T09:05:00Z'));
    expect(f.store.db.prepare('SELECT definition_revision,definition_sha256 FROM job_scan').get())
      .toEqual({ definition_revision: 1, definition_sha256: digest });
  });

  it('checks ownership and admission before claim and execution', async () => {
    const blocked = await fixture(base, undefined, false);
    await expect(blocked.engine.tick(new Date('2026-09-27T09:05:00Z'))).rejects.toThrow('No exclusive owner');
    expect(blocked.calls()).toBe(0);
    expect(blocked.store.db.prepare('SELECT count(*) AS count FROM job_windows').get()).toEqual({ count: 0 });
    const fenced = await fixture();
    fenced.store.close(); stores.splice(stores.indexOf(fenced.store), 1);
    const reopened = new TaskStore(join(fenced.dir, 'state', 'ardent.sqlite')); stores.push(reopened);
    const engine = new JobEngine(reopened.db, fenced.dir, 'assistant', fenced.handlers, async () => {}, frozen);
    reopened.closeAdmission('48398779-53ea-43c7-b763-829199fd624d');
    await expect(engine.tick(new Date('2026-09-27T09:05:00Z'))).rejects.toThrow('admission is fenced');
  });

  it('deduplicates local windows through the repeated DST hour and ignores nonexistent spring hour', async () => {
    const fall = { ...base, jobs: [{ ...base.jobs[0]!, schedule: { ...base.jobs[0]!.schedule, cron: '30 1 * * *' } }] };
    const f = await fixture(fall);
    expect((await f.engine.tick(new Date('2026-11-01T05:30:00Z'))).claimed).toBe(1);
    expect((await f.engine.tick(new Date('2026-11-01T06:30:00Z'))).claimed).toBe(0);
    expect(f.calls()).toBe(1);
    const row = f.store.db.prepare('SELECT window_key FROM job_windows').get() as { window_key: string };
    expect(row.window_key).toContain('2026-11-01T01:30@America/New_York');
    const spring = await fixture({ ...fall, jobs: [{ ...fall.jobs[0]!, schedule: { ...fall.jobs[0]!.schedule, cron: '30 2 * * *', missed_window: 'catch_up', catch_up_minutes: 180 } }] });
    await spring.engine.tick(new Date('2026-03-08T08:00:00Z'));
    expect(spring.calls()).toBe(0);
  });

  it('runs numeric-start cron steps across the rest of the field', async () => {
    const stepped = { ...base, jobs: [{ ...base.jobs[0]!, schedule: { ...base.jobs[0]!.schedule, cron: '5/10 5 * * *' } }] };
    const f = await fixture(stepped);
    expect((await f.engine.tick(new Date('2026-09-27T09:05:00Z'))).claimed).toBe(1);
    expect((await f.engine.tick(new Date('2026-09-27T09:15:00Z'))).claimed).toBe(1);
    expect((await f.engine.tick(new Date('2026-09-27T09:16:00Z'))).claimed).toBe(0);
    expect(f.calls()).toBe(2);
  });

  it('recovers missed windows within the bounded horizon and persists retry receipts', async () => {
    let calls = 0;
    const registry: JobRegistry = { 'test.v1': { input: z.object({ label: z.string() }), effect: 'none', run: async () => {
      calls++;
      return calls === 1 ? { state: 'retry', receipt: { effect_status: 'none', evidence: 'temporary source absence' } }
        : { state: 'completed', receipt: { effect_status: 'none', evidence: 'retrieved' } };
    } } };
    const definitions = { ...base, jobs: [{ ...base.jobs[0]!, schedule: { ...base.jobs[0]!.schedule, missed_window: 'catch_up' as const, catch_up_minutes: 120 } }] };
    const f = await fixture(definitions, registry);
    await f.engine.tick(new Date('2026-09-27T08:00:00Z'));
    expect((await f.engine.tick(new Date('2026-09-27T10:00:00Z'))).claimed).toBe(1);
    expect(calls).toBe(1);
    expect((await f.engine.tick(new Date('2026-09-27T10:00:02Z'))).completed).toBe(1);
    expect(calls).toBe(2);
    expect(f.store.db.prepare('SELECT count(*) AS count FROM job_attempts').get()).toEqual({ count: 2 });
    expect((await f.engine.status()).windows[0]).not.toHaveProperty('receipt_json');
  });

  it('does not replay interrupted or ambiguous external work after restart', async () => {
    const registry: JobRegistry = { 'test.v1': { input: z.object({ label: z.string() }), effect: 'external', run: async () => { throw new Error('Provider response lost'); } } };
    const f = await fixture(base, registry);
    await f.engine.tick(new Date('2026-09-27T09:05:00Z'));
    expect((await f.engine.status()).unknown_jobs).toBe(1);
    await f.engine.tick(new Date('2026-09-27T09:06:00Z'));
    expect(f.store.db.prepare('SELECT count(*) AS count FROM job_attempts').get()).toEqual({ count: 1 });
    f.store.db.prepare("UPDATE job_windows SET state='running',attempts=2 WHERE job_id=?").run(base.jobs[0]!.id);
    const restarted = new JobEngine(f.store.db, f.dir, 'assistant', registry, async () => {}, frozen);
    expect(restarted.recover(new Date('2026-09-27T09:07:00Z'))).toBe(1);
    expect((await restarted.status()).unknown_jobs).toBe(1);
    expect(f.store.db.prepare('SELECT state FROM job_attempts WHERE attempt=2').get()).toEqual({ state: 'unknown' });
  });

  it('marks an aborted in-flight external handler unknown without retrying it', async () => {
    const registry: JobRegistry = { 'test.v1': { input: z.object({ label: z.string() }), effect: 'external',
      run: async () => new Promise(() => {}) } };
    const f = await fixture(base, registry);
    const controller = new AbortController();
    const ticking = f.engine.tick(new Date('2026-09-27T09:05:00Z'), controller.signal);
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    expect((await ticking).unknown).toBe(1);
    expect((await f.engine.status()).unknown_jobs).toBe(1);
    expect(f.store.db.prepare('SELECT count(*) AS count FROM job_attempts').get()).toEqual({ count: 1 });
  });

  it('reloads definition revisions without a build and rejects invalid active content or a release lock', async () => {
    const f = await fixture();
    const before = await f.engine.status();
    const updated = { ...base, revision: 2, jobs: [{ ...base.jobs[0]!, schedule: { ...base.jobs[0]!.schedule, cron: '10 5 * * *' } }] };
    await writeFile(join(f.dir, 'jobs', 'active.json'), JSON.stringify(updated));
    const after = await f.engine.status();
    expect(after.active_revision).toBe(2);
    expect(after.active_sha256).not.toBe(before.active_sha256);
    await f.engine.tick(new Date('2026-09-27T09:10:00Z'));
    expect(f.calls()).toBe(1);
    await writeFile(join(f.dir, 'jobs', 'active.json'), JSON.stringify({ ...updated, revision: 3, jobs: [{ ...updated.jobs[0]!, handler: 'missing.v1' }] }));
    await expect(f.engine.tick(new Date('2026-09-28T09:10:00Z'))).rejects.toThrow('Unknown job handler');
    expect((await f.engine.status()).last_validation_error).toContain('Unknown job handler');
    await writeFile(join(f.dir, 'jobs', 'active.json'), JSON.stringify(updated));
    await mkdir(join(f.dir, 'state', 'job-definition-releases'), { recursive: true });
    await writeFile(join(f.dir, 'state', 'job-definition-releases', '.release.lock'), 'held');
    await expect(f.engine.tick(new Date('2026-09-28T09:10:00Z'))).rejects.toThrow('release lock');
  });

  it('holds a tick marker through execution and fails closed around a concurrent release', async () => {
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const registry: JobRegistry = { 'test.v1': { input: z.object({ label: z.string() }), effect: 'external',
      run: async () => { started(); return new Promise(() => {}); } } };
    const f = await fixture(base, registry);
    const marker = join(f.dir, 'state', 'job-definition-releases', '.tick.lock');
    const release = join(f.dir, 'state', 'job-definition-releases', '.release.lock');
    const abort = new AbortController();
    const ticking = f.engine.tick(new Date('2026-09-27T09:05:00Z'), abort.signal);
    await running;
    await expect(access(marker)).resolves.toBeUndefined();
    await writeFile(release, 'release held');
    abort.abort();
    expect((await ticking).unknown).toBe(1);
    await expect(access(marker)).rejects.toThrow();
    await expect(f.engine.tick(new Date('2026-09-27T09:06:00Z'))).rejects.toThrow('release lock');
    await rm(release);
    await writeFile(marker, 'stale marker');
    await expect(f.engine.tick(new Date('2026-09-27T09:06:00Z'))).rejects.toThrow('tick marker already exists');
  });

  it('reconciles a dead tick generation as unknown and refuses a live or malformed marker', async () => {
    const f = await fixture();
    await f.engine.tick(new Date('2026-09-27T09:05:00Z'));
    f.store.db.prepare("UPDATE job_windows SET state='running',attempts=2 WHERE job_id=?").run(base.jobs[0]!.id);
    const marker = join(f.dir, 'state', 'job-definition-releases', '.tick.lock');
    await writeFile(marker, JSON.stringify({ pid: process.pid, started_at: '2026-09-27T09:05:00.000Z' }));
    await expect(f.engine.recoverAfterRestart()).rejects.toThrow('live PID');
    expect(f.store.db.prepare('SELECT state FROM job_windows').get()).toEqual({ state: 'running' });
    await writeFile(marker, 'bad marker');
    await expect(f.engine.recoverAfterRestart()).rejects.toThrow('malformed');
    await writeFile(marker, JSON.stringify({ pid: 99999999, started_at: '2026-09-27T09:05:00.000Z' }));
    expect(await f.engine.recoverAfterRestart(new Date('2026-09-27T09:07:00Z'))).toBe(1);
    await expect(access(marker)).rejects.toThrow();
    expect(f.store.db.prepare('SELECT state FROM job_windows').get()).toEqual({ state: 'unknown' });
    expect(f.store.db.prepare('SELECT state FROM job_attempts WHERE attempt=2').get()).toEqual({ state: 'unknown' });
  });
});

describe('job engine clock and shutdown', () => {
  it('uses a fresh clock for ownership, receipts and retry backoff, keeping tick time for due scanning', async () => {
    let elapsed = 0;
    const owned: number[] = [];
    const registry: JobRegistry = { 'test.v1': { input: z.object({ label: z.string() }), effect: 'none', run: async () => {
      elapsed += 10 * 60_000; // A long handler inside one tick.
      return { state: 'retry', receipt: { effect_status: 'none', evidence: 'temporary source absence' } };
    } } };
    const second = { ...base.jobs[0]!, id: '32eb4b7a04c2' };
    const f = await fixture({ ...base, jobs: [base.jobs[0]!, second] }, registry);
    const engine = new JobEngine(f.store.db, f.dir, 'assistant', registry, async (_job, at) => { owned.push(at.getTime()); }, () => elapsed);
    const tickAt = new Date('2026-09-27T09:05:00Z');
    expect((await engine.tick(tickAt)).retry).toBe(2);
    const minutes = (count: number) => tickAt.getTime() + count * 60_000;
    expect(f.store.db.prepare('SELECT next_attempt_ms,updated_ms FROM job_windows ORDER BY job_id').all()).toEqual([
      { next_attempt_ms: minutes(10) + 1000, updated_ms: minutes(10) }, { next_attempt_ms: minutes(20) + 1000, updated_ms: minutes(20) }]);
    expect(f.store.db.prepare('SELECT recorded_ms FROM job_attempts ORDER BY recorded_ms').all()).toEqual([{ recorded_ms: minutes(10) }, { recorded_ms: minutes(20) }]);
    // The second job's due windows were scanned at tick time, but its ownership is checked when claimed.
    expect(owned).toEqual([minutes(0), minutes(0), minutes(10), minutes(10)]);
    expect(f.store.db.prepare('SELECT local_key FROM job_windows WHERE job_id=?').get(second.id)).toEqual({ local_key: '2026-09-27T05:05' });
  });

  it('keeps interval cadence anchored at the claim when a handler runs long', async () => {
    let elapsed = 0;
    const registry: JobRegistry = { 'test.v1': { input: z.object({ label: z.string() }), effect: 'none', run: async () => {
      elapsed += 4 * 60_000;
      return { state: 'completed', receipt: { effect_status: 'none', evidence: 'ok' } };
    } } };
    const f = await fixture(intervalBase, registry);
    const engine = new JobEngine(f.store.db, f.dir, 'assistant', registry, async () => {}, () => elapsed);
    expect((await engine.tick(new Date('2026-09-27T18:35:00Z'))).completed).toBe(1);
    expect((await engine.status(10, new Date('2026-09-27T18:40:00Z'))).jobs[0]?.next_window).toBe('2026-09-27T18:50:00.000Z');
  });

  it('stops claiming new windows once shutdown begins without aborting the running handler', async () => {
    const stopping = new AbortController();
    const ran: string[] = [];
    const registry: JobRegistry = { 'test.v1': { input: z.object({ label: z.string() }), effect: 'external', run: async ({ job, signal }) => {
      ran.push(job.id);
      stopping.abort();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(signal.aborted).toBe(false);
      return { state: 'completed', receipt: { effect_status: 'confirmed', evidence: 'sent' } };
    } } };
    const second = { ...base.jobs[0]!, id: '32eb4b7a04c2' };
    const f = await fixture({ ...base, jobs: [base.jobs[0]!, second] }, registry);
    const result = await f.engine.tick(new Date('2026-09-27T09:05:00Z'), new AbortController().signal, stopping.signal);
    expect(result).toMatchObject({ completed: 1, unknown: 0 });
    expect(ran).toEqual([base.jobs[0]!.id]);
    expect(f.store.db.prepare('SELECT job_id,state FROM job_windows ORDER BY job_id').all()).toEqual([
      { job_id: base.jobs[0]!.id, state: 'completed' }, { job_id: second.id, state: 'queued' }]);
  });

  it('does not wedge the scheduler when tick marker cleanup fails', async () => {
    const f = await fixture();
    const marker = join(f.dir, 'state', 'job-definition-releases', '.tick.lock');
    const registry = f.handlers['test.v1']!;
    const original = registry.run.bind(registry);
    registry.run = async ctx => { await rm(marker); return original(ctx); };
    await expect(f.engine.tick(new Date('2026-09-27T09:05:00Z'))).rejects.toThrow();
    registry.run = original;
    expect((await f.engine.tick(new Date('2026-09-28T09:05:00Z'))).claimed).toBe(1);
  });
});
